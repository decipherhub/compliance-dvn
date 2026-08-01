import { ethers } from 'ethers'
import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type LogSource,
  decodePacketRecipient,
  dvnInterface,
  endpointInterface,
  erc20Interface,
  oftInterface,
} from '../src/chain/events'
import { scanChainOnce } from '../src/ingest/scanner'
import { IngestStore } from '../src/ingest/store'

import { applySchema, memDb } from './helpers/memdb'

const silent = pino({ level: 'silent' })
const CHAIN = { key: 'baseSepolia', dvn: '0x' + 'd'.repeat(40), endpoint: '0x' + 'f'.repeat(40) }
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

  // ERC-721 shares the Transfer topic but keeps all three parameters indexed, so its logs do
  // not decode as ERC-20. Before this was handled, one NFT contract in TRACKED_TOKENS aborted
  // the same chunk every tick — the cursor froze and never advanced again.
  it('skips undecodable Transfer logs instead of freezing the cursor', async () => {
    const chain = new FakeChain(100)
    const erc721Transfer: ethers.providers.Log = {
      blockNumber: 90,
      blockHash: '0x',
      transactionIndex: 0,
      removed: false,
      address: TOKEN,
      data: '0x', // ERC-721: value lives in topics[3], not data
      topics: [
        erc20Interface.getEventTopic('Transfer'),
        ethers.utils.hexZeroPad(A, 32),
        ethers.utils.hexZeroPad(B, 32),
        ethers.utils.hexZeroPad('0x01', 32), // tokenId
      ],
      transactionHash: '0x' + '7'.repeat(64),
      logIndex: 0,
    }
    chain.logs = [erc721Transfer, transferLog(91, 0, '1000')]

    const result = await scanChainOnce(deps(chain))
    expect(result.transfers).toBe(1) // the real ERC-20 transfer still lands
    expect(await store.getCursor(CHAIN.key)).toBe(95) // cursor advanced past the bad log
    expect((await store.counts()).edges).toBe(1)
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

/**
 * Cross-chain sends.
 *
 * A bridged transfer is a burn here and a mint there, so the burn/mint pair alone says only that
 * the supply moved — and when the DVN blocks the packet, the destination half never happens at all.
 * The sender and the recipient are both knowable on this side: `OFTSent` names one, the packet the
 * other, and the guid ties them together.
 */
describe('scanChainOnce: cross-chain sends', () => {
  const DST_EID = 40232

  /** `header(81) ‖ guid(32) ‖ message`, with the recipient as the message's opening word. */
  function packet(guid: string, to: string): string {
    const header = '01' + '00'.repeat(80)
    const message = '00'.repeat(12) + to.slice(2) + '00'.repeat(8)
    return '0x' + header + guid.slice(2) + message
  }

  function oftSentLog(blockNumber: number, logIndex: number, guid: string, from: string, value: string) {
    const encoded = oftInterface.encodeEventLog(oftInterface.getEvent('OFTSent'), [
      guid,
      DST_EID,
      from,
      ethers.BigNumber.from(value),
      ethers.BigNumber.from(value),
    ])
    return {
      blockNumber, blockHash: '0x', transactionIndex: 0, removed: false, address: TOKEN,
      data: encoded.data, topics: encoded.topics,
      transactionHash: '0x' + String(700000 + blockNumber).padStart(64, '0'), logIndex,
    } as ethers.providers.Log
  }

  function packetSentLog(blockNumber: number, logIndex: number, guid: string, to: string) {
    const encoded = endpointInterface.encodeEventLog(endpointInterface.getEvent('PacketSent'), [
      packet(guid, to), '0x', '0x' + '9'.repeat(40),
    ])
    return {
      blockNumber, blockHash: '0x', transactionIndex: 0, removed: false, address: CHAIN.endpoint,
      data: encoded.data, topics: encoded.topics,
      transactionHash: '0x' + String(700000 + blockNumber).padStart(64, '0'), logIndex,
    } as ethers.providers.Log
  }

  const guid = (n: number) => '0x' + String(n).padStart(64, '0')

  it('records the real counterparties as a bridge edge', async () => {
    const chain = new FakeChain(100)
    chain.logs = [oftSentLog(90, 0, guid(1), A, '5000'), packetSentLog(90, 1, guid(1), B)]
    const result = await scanChainOnce(deps(chain, { chainByEid: () => 'optimismSepolia' }))

    expect(result.bridgeSends).toBe(1)
    const { rows } = await db.query<{ from_addr: string; to_addr: string; value: string; kind: string; dst_chain: string }>(
      'SELECT from_addr, to_addr, value, kind, dst_chain FROM edges',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].from_addr).toBe(A.toLowerCase())
    expect(rows[0].to_addr).toBe(B.toLowerCase())
    expect(String(rows[0].value)).toBe('5000')
    expect(rows[0].kind).toBe('bridge')
    expect(rows[0].dst_chain).toBe('optimismSepolia')
  })

  // The burn is a separate log in the same transaction, so both must land without colliding on the
  // (chain, tx_hash, log_index) key.
  it('keeps the burn and the bridge edge as separate rows', async () => {
    const chain = new FakeChain(100)
    const burn = { ...transferLog(90, 2, '5000'), transactionHash: '0x' + String(700090).padStart(64, '0') }
    chain.logs = [oftSentLog(90, 0, guid(1), A, '5000'), packetSentLog(90, 1, guid(1), B), burn]
    const result = await scanChainOnce(deps(chain))
    expect(result.transfers).toBe(1)
    expect(result.bridgeSends).toBe(1)
    const { rows } = await db.query<{ kind: string }>('SELECT kind FROM edges ORDER BY log_index')
    expect(rows.map((r) => r.kind)).toEqual(['bridge', 'transfer'])
  })

  // Two sends in one transaction share a tx hash, so the guid — not the transaction — has to be
  // what pairs a send with its recipient.
  it('pairs batched sends by guid rather than by transaction', async () => {
    const chain = new FakeChain(100)
    const C = '0x' + '3'.repeat(40)
    chain.logs = [
      oftSentLog(90, 0, guid(1), A, '100'),
      oftSentLog(90, 1, guid(2), A, '200'),
      packetSentLog(90, 2, guid(2), C),
      packetSentLog(90, 3, guid(1), B),
    ]
    await scanChainOnce(deps(chain))
    const { rows } = await db.query<{ to_addr: string; value: string }>(
      "SELECT to_addr, value FROM edges WHERE kind = 'bridge' ORDER BY value",
    )
    expect(rows.map((r) => [r.to_addr, String(r.value)])).toEqual([
      [B.toLowerCase(), '100'],
      [C.toLowerCase(), '200'],
    ])
  })

  it('skips a send whose recipient cannot be read rather than guessing one', async () => {
    const chain = new FakeChain(100)
    chain.logs = [oftSentLog(90, 0, guid(1), A, '5000')] // no PacketSent
    const result = await scanChainOnce(deps(chain))
    expect(result.bridgeSends).toBe(0)
    expect((await db.query('SELECT 1 FROM edges')).rowCount).toBe(0)
  })

  it('records the edge even when the destination chain is not indexed here', async () => {
    const chain = new FakeChain(100)
    chain.logs = [oftSentLog(90, 0, guid(1), A, '5000'), packetSentLog(90, 1, guid(1), B)]
    await scanChainOnce(deps(chain, { chainByEid: () => undefined }))
    const { rows } = await db.query<{ dst_chain: string | null }>("SELECT dst_chain FROM edges WHERE kind = 'bridge'")
    expect(rows).toHaveLength(1)
    expect(rows[0].dst_chain).toBeNull()
  })

  it('reads the recipient from the message, not from the guid that precedes it', () => {
    const decoded = decodePacketRecipient(packet(guid(7), B))
    expect(decoded?.guid).toBe(guid(7))
    expect(decoded?.to).toBe(B.toLowerCase())
    expect(decodePacketRecipient('0x1234')).toBeUndefined()
  })
})
