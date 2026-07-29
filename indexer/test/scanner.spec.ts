import { describe, it, expect, beforeEach } from 'vitest'
import pino from 'pino'
import { ethers } from 'ethers'
import { scanChainOnce } from '../src/ingest/scanner'
import { IngestStore } from '../src/ingest/store'
import { dvnInterface, erc20Interface, type LogSource } from '../src/chain/events'
import { applySchema, memDb } from './helpers/memdb'

const silent = pino({ level: 'silent' })
const CHAIN = { key: 'baseSepolia', dvn: '0x' + 'd'.repeat(40) }
const TOKEN = '0x' + 'e'.repeat(40)
const A = '0x' + '1'.repeat(40)
const B = '0x' + '2'.repeat(40)
const PAYLOAD = '0x' + 'a'.repeat(64)

let db: ReturnType<typeof memDb>
let store: IngestStore

beforeEach(() => {
  db = memDb()
  applySchema(db)
  store = new IngestStore(db)
})

/** A fake chain: blocks with deterministic hashes plus whatever logs the test places. */
class FakeChain implements LogSource {
  /** hash suffix per height, so a reorg can be simulated by changing it. */
  private hashes = new Map<number, string>()
  logs: ethers.providers.Log[] = []

  constructor(private head: number) {}

  setHead(head: number): void {
    this.head = head
  }

  /** Rewrite history from `fromHeight` up, as a reorg would. */
  fork(fromHeight: number, marker: string): void {
    for (const height of [...this.hashes.keys()]) {
      if (height >= fromHeight) this.hashes.set(height, marker)
    }
    for (let h = fromHeight; h <= this.head; h++) this.hashes.set(h, marker)
  }

  private hashOf(height: number): string {
    const marker = this.hashes.get(height) ?? 'a'
    return '0x' + marker.repeat(1).padStart(2, '0').repeat(1) + String(height).padStart(62, '0')
  }

  async getBlockNumber(): Promise<number> {
    return this.head
  }

  async getBlock(blockNumber: number): Promise<{ hash: string; parentHash: string; timestamp: number } | null> {
    if (blockNumber > this.head || blockNumber < 0) return null
    // Deterministic, monotonic block times: 2s apart from a fixed genesis.
    return {
      hash: this.hashOf(blockNumber),
      parentHash: this.hashOf(blockNumber - 1),
      timestamp: 1_700_000_000 + blockNumber * 2,
    }
  }

  async getLogs(filter: { address?: string; topics?: (string | null)[]; fromBlock: number; toBlock: number }) {
    return this.logs.filter((l) => {
      if (l.blockNumber < filter.fromBlock || l.blockNumber > filter.toBlock) return false
      if (filter.address && l.address.toLowerCase() !== filter.address.toLowerCase()) return false
      const want = filter.topics?.[0]
      if (!want) return true
      const list = Array.isArray(want) ? (want as unknown as string[]) : [want]
      return list.includes(l.topics[0])
    })
  }
}

function verdictLog(blockNumber: number, logIndex: number): ethers.providers.Log {
  const encoded = dvnInterface.encodeEventLog(dvnInterface.getEvent('RiskVerdict'), [
    PAYLOAD,
    3,
    100,
    ethers.BigNumber.from(1),
    '0x' + 'b'.repeat(64),
  ])
  return {
    blockNumber,
    blockHash: '0x',
    transactionIndex: 0,
    removed: false,
    address: CHAIN.dvn,
    data: encoded.data,
    topics: encoded.topics,
    transactionHash: '0x' + String(blockNumber * 100 + logIndex).padStart(64, '0'),
    logIndex,
  }
}

function transferLog(blockNumber: number, logIndex: number, value: string): ethers.providers.Log {
  const encoded = erc20Interface.encodeEventLog(erc20Interface.getEvent('Transfer'), [A, B, ethers.BigNumber.from(value)])
  return {
    blockNumber,
    blockHash: '0x',
    transactionIndex: 0,
    removed: false,
    address: TOKEN,
    data: encoded.data,
    topics: encoded.topics,
    transactionHash: '0x' + String(900000 + blockNumber * 100 + logIndex).padStart(64, '0'),
    logIndex,
  }
}

function deps(chainSource: FakeChain, overrides: Partial<Parameters<typeof scanChainOnce>[0]> = {}) {
  return {
    chain: CHAIN,
    source: chainSource,
    store,
    trackedTokens: [TOKEN],
    confirmations: 5,
    scanWindow: 50,
    scanChunk: 1000,
    reorgDepth: 32,
    logger: silent,
    ...overrides,
  }
}

describe('scanChainOnce', () => {
  it('ingests verdicts and transfers up to the safe head', async () => {
    const chain = new FakeChain(100)
    chain.logs = [verdictLog(90, 0), transferLog(91, 0, '1000')]
    const result = await scanChainOnce(deps(chain))
    expect(result.to).toBe(95) // 100 - 5 confirmations
    expect(result.verdicts).toBe(1)
    expect(result.transfers).toBe(1)
    expect(await store.getCursor(CHAIN.key)).toBe(95)
    expect((await store.counts()).risk_verdicts).toBe(1)
    expect((await store.counts()).edges).toBe(1)
  })

  it('does not read past the confirmation depth', async () => {
    const chain = new FakeChain(100)
    chain.logs = [verdictLog(97, 0)] // inside the unconfirmed window
    const result = await scanChainOnce(deps(chain))
    expect(result.verdicts).toBe(0)
  })

  it('is idempotent — rescanning the same range inserts nothing new', async () => {
    const chain = new FakeChain(100)
    chain.logs = [verdictLog(90, 0), transferLog(91, 0, '1000')]
    await scanChainOnce(deps(chain))
    // Force a rescan of the same range by rewinding the cursor only.
    await store.setCursor(CHAIN.key, 80)
    await scanChainOnce(deps(chain))
    expect((await store.counts()).risk_verdicts).toBe(1)
    expect((await store.counts()).edges).toBe(1)
  })

  it('does nothing when the safe head has not advanced', async () => {
    const chain = new FakeChain(100)
    await store.setCursor(CHAIN.key, 95)
    const result = await scanChainOnce(deps(chain))
    expect(result.verdicts).toBe(0)
    expect(await store.getCursor(CHAIN.key)).toBe(95)
  })

  // Scan lag is head - cursor, and this is the only place the head is read. Reporting it even on
  // an idle tick is what keeps the lag gauge from sitting at a stale value.
  it('reports the chain head on every tick', async () => {
    const chain = new FakeChain(100)
    expect((await scanChainOnce(deps(chain))).head).toBe(100)
    await store.setCursor(CHAIN.key, 95)
    expect((await scanChainOnce(deps(chain))).head).toBe(100)
  })

  it('advances in bounded chunks', async () => {
    const chain = new FakeChain(1000)
    await store.setCursor(CHAIN.key, 0)
    chain.logs = [verdictLog(500, 0)]
    const result = await scanChainOnce(deps(chain, { scanChunk: 100 }))
    expect(result.to).toBe(995)
    expect(result.verdicts).toBe(1)
  })

  describe('reorg handling', () => {
    it('rolls back and rescans when the stored hash no longer matches', async () => {
      const chain = new FakeChain(100)
      chain.logs = [verdictLog(90, 0)]
      await scanChainOnce(deps(chain))
      expect(await store.getCursor(CHAIN.key)).toBe(95)
      expect((await store.counts()).risk_verdicts).toBe(1)

      // History is rewritten from 93 up. The log at 90 is still canonical, so the rescan
      // re-ingests it — the row count is unchanged because the insert is idempotent.
      chain.fork(93, 'f')
      const result = await scanChainOnce(deps(chain))

      expect(result.reorgDepth).toBeGreaterThan(0)
      expect((await store.counts()).risk_verdicts).toBe(1)
      expect(await store.getCursor(CHAIN.key)).toBe(95)
    })

    it('discards rows that the new canonical chain no longer contains', async () => {
      const chain = new FakeChain(100)
      chain.logs = [verdictLog(94, 0)] // inside the range that will be rewritten
      await scanChainOnce(deps(chain))
      expect((await store.counts()).risk_verdicts).toBe(1)

      chain.fork(93, 'f')
      chain.logs = [] // the log does not exist on the new chain
      await scanChainOnce(deps(chain))

      expect((await store.counts()).risk_verdicts).toBe(0)
    })

    it('re-ingests the replacement logs after a reorg', async () => {
      const chain = new FakeChain(100)
      chain.logs = [verdictLog(94, 0)]
      await scanChainOnce(deps(chain))

      chain.fork(93, 'f')
      chain.logs = [verdictLog(94, 1)] // a different log at the same height
      await scanChainOnce(deps(chain))

      const rows = await db.query<{ log_index: number }>('SELECT log_index FROM risk_verdicts')
      expect(rows.rows.length).toBe(1)
      expect(Number(rows.rows[0].log_index)).toBe(1)
    })

    // Silently trusting rows we know are wrong would be worse than stopping and being noticed.
    it('aborts loudly when the reorg is deeper than REORG_DEPTH', async () => {
      const chain = new FakeChain(100)
      chain.logs = [verdictLog(90, 0)]
      await scanChainOnce(deps(chain))

      chain.fork(0, 'f') // everything rewritten
      await expect(scanChainOnce(deps(chain, { reorgDepth: 3 }))).rejects.toThrow(/deeper than REORG_DEPTH/)
    })

    it('treats a cold cursor as no reorg', async () => {
      const chain = new FakeChain(100)
      const result = await scanChainOnce(deps(chain))
      expect(result.reorgDepth).toBe(0)
    })
  })

  it('collects no edges when no tokens are tracked', async () => {
    const chain = new FakeChain(100)
    chain.logs = [transferLog(90, 0, '1000')]
    const result = await scanChainOnce(deps(chain, { trackedTokens: [] }))
    expect(result.transfers).toBe(0)
  })
})
