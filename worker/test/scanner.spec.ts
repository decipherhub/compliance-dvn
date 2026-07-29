import { describe, it, expect, vi } from 'vitest'
import { scanChainOnce, verifyPacket, processDeferred } from '../runtime/scanner'
import { createMetrics } from '../runtime/metrics'
import { Checkpoint } from '../checkpoint'
import { makeAssessor } from '../assess/assess'
import { RiskStore } from '../assess/store'
import { DELAY_POLICY } from '../assess/policy'
import { ACTION_CODES, decodeReasonMask } from '../assess/verdict'
import type { ResolvedChain } from '../runtime/config'
import type { ParsedPacket } from '../chain/events'
import pino from 'pino'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const silent = pino({ level: 'silent' })

const baseChain: ResolvedChain = {
  key: 'baseSepolia', name: 'base-sepolia', eid: 40245, chainId: 84532,
  rpc: 'x', endpoint: '0xe', sendUln: '0xs', receiveUln: '0xr', dvn: '0xd',
}
const optChain: ResolvedChain = {
  key: 'optimismSepolia', name: 'optimism-sepolia', eid: 40232, chainId: 11155420,
  rpc: 'x', endpoint: '0xe', sendUln: '0xs', receiveUln: '0xr2', dvn: '0xd2',
}

const PAYLOAD = '0x' + 'a'.repeat(64)
const KEY = `${PAYLOAD}:40232`
const SENDER = '0x' + '1'.repeat(40)

function tmpCheckpoint(): Checkpoint {
  const dir = mkdtempSync(join(tmpdir(), 'dvn-cp-'))
  return new Checkpoint(join(dir, 'cp.json'))
}

function packet(overrides: Partial<ParsedPacket> = {}): ParsedPacket {
  return {
    encoded: '0x', header: '0xheader', guid: '0xguid', message: '0xmsg',
    payloadHash: PAYLOAD, srcEid: 40245, dstEid: 40232,
    senderAddress: SENDER, receiverAddress: '0x' + '2'.repeat(40),
    oft: { toAddress: '0x' + '3'.repeat(40), amountSD: 1n, composed: false },
    headerFields: {} as never,
    ...overrides,
  }
}

/** A store whose only entry pushes SENDER to the given action. */
function storeWith(labels: string[], source: 'ofac' | 'trusted_indexer' = 'ofac'): RiskStore {
  const store = new RiskStore()
  store.upsert({ subject: SENDER, labels, source })
  return store
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    assessor: makeAssessor(new RiskStore()),
    resolveDst: (eid: number) => (eid === 40232 ? optChain : undefined),
    verify: vi.fn(async () => '0xverifytx'),
    commit: vi.fn(async () => '0xcommittx'),
    recordVerdict: vi.fn(async () => '0xrecordtx'),
    emitVerdictFor: new Set<string>(['block']),
    checkpoint: tmpCheckpoint(),
    metrics: createMetrics(),
    logger: silent,
    srcChainKey: 'baseSepolia',
    ...overrides,
  } as never as Parameters<typeof verifyPacket>[1] & {
    verify: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
    recordVerdict: ReturnType<typeof vi.fn>
  }
}

describe('scanChainOnce', () => {
  const noScans = { scanAssigned: vi.fn(), scanPackets: vi.fn(), scanApproved: vi.fn() }

  it('FREEZES checkpoints and skips scanning when not READY (fail-closed)', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 100)
    const scanPackets = vi.fn()
    const handlePacket = vi.fn()
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => 'HALTED',
      checkpoint: cp,
      scanAssigned: vi.fn(),
      scanPackets,
      scanApproved: vi.fn(),
      handlePacket,
      metrics: createMetrics(),
      logger: silent,
    })
    expect(scanPackets).not.toHaveBeenCalled()
    expect(handlePacket).not.toHaveBeenCalled()
    expect(cp.getLastBlock('baseSepolia')).toBe(100) // frozen
  })

  it('scans, handles only assigned packets, and advances the checkpoint when READY', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 100)
    const handlePacket = vi.fn(async () => {})
    const metrics = createMetrics()
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => 'READY',
      checkpoint: cp,
      scanAssigned: async () => new Set([PAYLOAD]),
      scanPackets: async () => [packet(), packet({ payloadHash: '0x' + 'b'.repeat(64) })],
      scanApproved: async () => new Set<string>(),
      handlePacket,
      metrics,
      logger: silent,
    })
    expect(handlePacket).toHaveBeenCalledTimes(1) // only the assigned one
    expect(cp.getLastBlock('baseSepolia')).toBe(995) // 1000 - 5 confirmations
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_checkpoint_block\{[^}]*chain="baseSepolia"[^}]*\} 995/)
  })

  it('records owner approvals seen in the window', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 100)
    const metrics = createMetrics()
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => 'READY',
      checkpoint: cp,
      scanAssigned: async () => new Set<string>(),
      scanPackets: async () => [],
      scanApproved: async () => new Set([PAYLOAD]),
      handlePacket: vi.fn(),
      metrics,
      logger: silent,
    })
    expect(cp.isApproved(PAYLOAD)).toBe(true)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_approvals_total\{[^}]*chain="baseSepolia"[^}]*\} 1/)
  })

  it('aborts mid-scan and freezes the checkpoint if state flips to HALTED during the awaits (TOCTOU)', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 100)
    let state: 'READY' | 'HALTED' = 'READY'
    const handlePacket = vi.fn(async () => {})
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => state,
      checkpoint: cp,
      scanAssigned: async () => new Set([PAYLOAD]),
      // Simulate the risk store aging into HALTED during the RPC await window.
      scanPackets: async () => {
        state = 'HALTED'
        return [packet()]
      },
      scanApproved: async () => new Set<string>(),
      handlePacket,
      metrics: createMetrics(),
      logger: silent,
    })
    expect(handlePacket).not.toHaveBeenCalled() // never verified against the stale store
    expect(cp.getLastBlock('baseSepolia')).toBe(100) // checkpoint frozen, not advanced to 995
  })

  it('does nothing when the safe head has not advanced past the checkpoint', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 995) // safeHead = 1000 - 5 = 995, not past checkpoint
    const scanPackets = vi.fn()
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => 'READY',
      checkpoint: cp,
      ...noScans,
      scanPackets,
      handlePacket: vi.fn(),
      metrics: createMetrics(),
      logger: silent,
    })
    expect(scanPackets).not.toHaveBeenCalled()
  })

  // The fail-closed freeze holds the checkpoint through an outage, so on recovery the gap can be
  // far wider than an RPC's getLogs cap. Without chunking every tick fails and the gap only grows.
  it('walks a gap wider than the RPC range cap in bounded chunks', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 1000)
    const ranges: Array<[number, number]> = []
    const scanPackets = vi.fn(async (from: number, to: number) => {
      if (to - from + 1 > 2000) throw new Error('query exceeds max block range 2000')
      ranges.push([from, to])
      return []
    })
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 6005 }, // safeHead 6000 => a 5000-block gap
      confirmations: 5,
      scanWindow: 50,
      scanChunk: 2000,
      state: () => 'READY',
      checkpoint: cp,
      scanAssigned: async () => new Set<string>(),
      scanPackets,
      scanApproved: async () => new Set<string>(),
      handlePacket: vi.fn(),
      metrics: createMetrics(),
      logger: silent,
    })
    expect(ranges).toEqual([
      [1001, 3000],
      [3001, 5000],
      [5001, 6000],
    ])
    expect(cp.getLastBlock('baseSepolia')).toBe(6000)
  })

  // Per-chunk advance is what makes recovery possible: a failure mid-gap must keep the chunks
  // already screened, or the worker restarts the whole gap every tick and never converges.
  it('keeps the chunks it already screened when a later chunk fails', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 1000)
    let calls = 0
    await expect(
      scanChainOnce({
        chain: baseChain,
        provider: { getBlockNumber: async () => 6005 },
        confirmations: 5,
        scanWindow: 50,
        scanChunk: 2000,
        state: () => 'READY',
        checkpoint: cp,
        scanAssigned: async () => new Set<string>(),
        scanPackets: async () => {
          if (++calls === 2) throw new Error('rpc down')
          return []
        },
        scanApproved: async () => new Set<string>(),
        handlePacket: vi.fn(),
        metrics: createMetrics(),
        logger: silent,
      }),
    ).rejects.toThrow(/rpc down/)
    expect(cp.getLastBlock('baseSepolia')).toBe(3000) // first chunk kept, not rewound to 1000
  })

  it('counts a scan error and rethrows for the caller to isolate', async () => {
    const metrics = createMetrics()
    await expect(
      scanChainOnce({
        chain: baseChain,
        provider: { getBlockNumber: async () => { throw new Error('rpc down') } },
        confirmations: 5,
        scanWindow: 50,
        scanChunk: 2000,
        state: () => 'READY',
        checkpoint: tmpCheckpoint(),
        ...noScans,
        handlePacket: vi.fn(),
        metrics,
        logger: silent,
      }),
    ).rejects.toThrow(/rpc down/)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_scan_errors_total\{[^}]*chain="baseSepolia"[^}]*\} 1/)
  })
})

describe('verifyPacket', () => {
  it('ALLOW: verifies and commits a clean packet, then marks it processed', async () => {
    const d = deps()
    await verifyPacket(packet(), d)
    expect(d.verify).toHaveBeenCalledOnce()
    expect(d.commit).toHaveBeenCalledOnce()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
  })

  it('BLOCK: vetoes a sanctioned packet, marks processed, counts the decision', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions'])) })
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_decisions_total\{[^}]*action="block"[^}]*\} 1/)
  })

  it('MANUAL-REVIEW: withholds and holds indefinitely, awaiting approval', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')) })
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.isProcessed(KEY)).toBe(false) // NOT settled
    const rec = d.checkpoint.getDeferred(KEY)!
    expect(rec.action).toBe('manual-review')
    expect(rec.score).toBe(70)
    // Each party keeps its own chain: the sender is on the source, the rest on the destination.
    expect(rec.parties).toEqual([
      { subject: SENDER, chainKey: 'baseSepolia' },
      { subject: '0x' + '2'.repeat(40), chainKey: 'optimismSepolia' },
      { subject: '0x' + '3'.repeat(40), chainKey: 'optimismSepolia' },
    ])
    expect(rec.retryAfter).toBe(Number.MAX_SAFE_INTEGER) // clock never releases it
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_pending_packets\{[^}]*action="manual-review"[^}]*\} 1/)
  })

  it('DELAY: withholds with a clock-based retry', async () => {
    const now = 1_000_000
    const d = deps({ assessor: makeAssessor(storeWith(['contract_admin_risk'], 'trusted_indexer')), now: () => now })
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled()
    const rec = d.checkpoint.getDeferred(KEY)!
    expect(rec.action).toBe('delay')
    expect(rec.retryAfter).toBe(now + DELAY_POLICY.retryAfterMs)
    expect(rec.attempts).toBe(0)
  })

  it('skips a packet already processed', async () => {
    const d = deps()
    d.checkpoint.markProcessed(KEY)
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled()
  })

  it('skips a packet already held — the deferred queue owns it', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')) })
    await verifyPacket(packet(), d)
    d.verify.mockClear()
    await verifyPacket(packet(), d) // second sighting of the same packet
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.deferredEntries().length).toBe(1)
  })

  it('skips a packet whose destination EID is unknown', async () => {
    const d = deps()
    await verifyPacket(packet({ dstEid: 99999 }), d)
    expect(d.verify).not.toHaveBeenCalled()
  })

  it('still marks processed when commit fails (verification already on-chain)', async () => {
    const d = deps({ commit: vi.fn(async () => { throw new Error('commit not ready') }) })
    await verifyPacket(packet(), d)
    expect(d.verify).toHaveBeenCalledOnce()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_commits_total\{[^}]*result="failure"[^}]*\} 1/)
  })

  it('leaves the packet unprocessed when submitVerification fails, so it retries', async () => {
    const d = deps({ verify: vi.fn(async () => { throw new Error('nonce too low') }) })
    await verifyPacket(packet(), d)
    expect(d.checkpoint.isProcessed(KEY)).toBe(false)
    expect(d.commit).not.toHaveBeenCalled()
  })
})

describe('verdict emission', () => {
  it('ALLOW: carries the verdict on submitVerification, with no extra transaction', async () => {
    const d = deps()
    await verifyPacket(packet(), d)
    const verdict = d.verify.mock.calls[0][3]
    expect(verdict.action).toBe(ACTION_CODES.allow)
    expect(verdict.score).toBe(0)
    expect(verdict.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(d.recordVerdict).not.toHaveBeenCalled() // no separate tx for an allow
  })

  it('BLOCK: records the verdict in a separate transaction with the reason mask', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions'])) })
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.recordVerdict).toHaveBeenCalledOnce()
    const [, payloadHash, verdict] = d.recordVerdict.mock.calls[0]
    expect(payloadHash).toBe(PAYLOAD)
    expect(verdict.action).toBe(ACTION_CODES.block)
    expect(verdict.score).toBe(100)
    expect(decodeReasonMask(verdict.reasonMask)).toEqual(['sanctions'])
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_verdict_records_total\{[^}]*result="success"[^}]*\} 1/)
  })

  // Withholding the attestation is what stops the packet; the record is only the audit trail.
  it('still enforces the veto when recording it fails', async () => {
    const d = deps({
      assessor: makeAssessor(storeWith(['sanctions'])),
      recordVerdict: vi.fn(async () => { throw new Error('rpc down') }),
    })
    await verifyPacket(packet(), d)
    expect(d.verify).not.toHaveBeenCalled() // still vetoed
    expect(d.checkpoint.isProcessed(KEY)).toBe(true) // still settled
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_verdict_records_total\{[^}]*result="failure"[^}]*\} 1/)
  })

  it('does not emit for a held packet when the action is not configured', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')) })
    await verifyPacket(packet(), d)
    expect(d.recordVerdict).not.toHaveBeenCalled() // emitVerdictFor is {block}
  })

  it('emits for a held packet when the action IS configured', async () => {
    const d = deps({
      assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')),
      emitVerdictFor: new Set(['block', 'manual-review']),
    })
    await verifyPacket(packet(), d)
    expect(d.recordVerdict).toHaveBeenCalledOnce()
    expect(d.recordVerdict.mock.calls[0][2].action).toBe(ACTION_CODES['manual-review'])
  })

  it('works with no recordVerdict wired at all', async () => {
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions'])), recordVerdict: undefined })
    await verifyPacket(packet(), d)
    expect(d.checkpoint.isProcessed(KEY)).toBe(true) // enforced regardless
  })

  it('reports an owner-approved release as allow, flagged owner_approved', async () => {
    const t0 = 1_000_000
    const d = deps({ assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')), now: () => t0 })
    await verifyPacket(packet(), d)
    d.checkpoint.addApproval(PAYLOAD)
    await processDeferred({ ...d, now: () => t0 + 1000 })

    const verdict = d.verify.mock.calls[0][3]
    expect(verdict.action).toBe(ACTION_CODES.allow) // the contract accepts only allow here
    expect(decodeReasonMask(verdict.reasonMask).sort()).toEqual(['owner_approved', 'sanctions_1hop'])
    expect(verdict.score).toBe(70) // the score is not rewritten
  })

  it('emits once on escalation, not on every delay retry', async () => {
    let t = 1_000_000
    const d = deps({
      assessor: makeAssessor(storeWith(['contract_admin_risk'], 'trusted_indexer')),
      emitVerdictFor: new Set(['block', 'manual-review']),
      now: () => t,
    })
    await verifyPacket(packet(), d)
    expect(d.recordVerdict).not.toHaveBeenCalled() // delay is not in emitVerdictFor
    for (let i = 0; i < DELAY_POLICY.maxAttempts; i++) {
      t += DELAY_POLICY.retryAfterMs
      await processDeferred({ ...d, now: () => t })
    }
    // One emission for the escalation to manual-review, not one per retry.
    expect(d.recordVerdict).toHaveBeenCalledOnce()
    expect(d.recordVerdict.mock.calls[0][2].action).toBe(ACTION_CODES['manual-review'])
  })
})

describe('processDeferred', () => {
  /** Hold a packet, then hand back deps for the second pass. */
  async function held(labels: string[], now: number) {
    const d = deps({ assessor: makeAssessor(storeWith(labels, 'trusted_indexer')), now: () => now })
    await verifyPacket(packet(), d)
    return d
  }

  it('leaves a delayed packet alone before retryAfter', async () => {
    const t0 = 1_000_000
    const d = await held(['contract_admin_risk'], t0)
    await processDeferred({ ...d, now: () => t0 + 1000 })
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.getDeferred(KEY)!.attempts).toBe(0)
  })

  it('re-screens a due delay and releases it when it now scores clean', async () => {
    const t0 = 1_000_000
    const d = await held(['contract_admin_risk'], t0)
    // The risk store no longer knows anything about the sender.
    await processDeferred({ ...d, assessor: makeAssessor(new RiskStore()), now: () => t0 + DELAY_POLICY.retryAfterMs })
    expect(d.verify).toHaveBeenCalledOnce()
    expect(d.commit).toHaveBeenCalledOnce()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
    expect(d.checkpoint.getDeferred(KEY)).toBeUndefined()
  })

  it('vetoes a due delay that has since become a direct hit', async () => {
    const t0 = 1_000_000
    const d = await held(['contract_admin_risk'], t0)
    await processDeferred({
      ...d,
      assessor: makeAssessor(storeWith(['sanctions'])),
      now: () => t0 + DELAY_POLICY.retryAfterMs,
    })
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
    expect(d.checkpoint.getDeferred(KEY)).toBeUndefined()
  })

  it('escalates to manual-review once maxAttempts is exhausted', async () => {
    let t = 1_000_000
    const d = await held(['contract_admin_risk'], t)
    for (let i = 0; i < DELAY_POLICY.maxAttempts; i++) {
      t += DELAY_POLICY.retryAfterMs
      await processDeferred({ ...d, now: () => t })
    }
    const rec = d.checkpoint.getDeferred(KEY)!
    expect(rec.action).toBe('manual-review')
    expect(rec.attempts).toBe(DELAY_POLICY.maxAttempts)
    expect(d.verify).not.toHaveBeenCalled()
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_decisions_total\{[^}]*action="manual-review"[^}]*\} 1/)
  })

  it('promotes a delay straight to manual-review when the score rises', async () => {
    const t0 = 1_000_000
    const d = await held(['contract_admin_risk'], t0)
    await processDeferred({
      ...d,
      assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')),
      now: () => t0 + DELAY_POLICY.retryAfterMs,
    })
    expect(d.checkpoint.getDeferred(KEY)!.action).toBe('manual-review')
  })

  it('never releases a manual-review hold on the clock alone', async () => {
    const t0 = 1_000_000
    const d = await held(['sanctions_1hop'], t0)
    await processDeferred({ ...d, now: () => t0 + 365 * 24 * 3600_000 })
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.getDeferred(KEY)!.action).toBe('manual-review')
  })

  it('releases a manual-review hold on an owner approval', async () => {
    const t0 = 1_000_000
    const d = await held(['sanctions_1hop'], t0)
    d.checkpoint.addApproval(PAYLOAD)
    await processDeferred({ ...d, now: () => t0 + 1000 })
    expect(d.verify).toHaveBeenCalledOnce()
    expect(d.commit).toHaveBeenCalledOnce()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
    const text = await d.metrics.registry.metrics()
    expect(text).toMatch(/dvn_pending_packets\{[^}]*action="manual-review"[^}]*\} 0/)
  })

  it('REFUSES an approval when the packet has since become a direct sanctions hit', async () => {
    const t0 = 1_000_000
    const d = await held(['sanctions_1hop'], t0)
    d.checkpoint.addApproval(PAYLOAD)
    await processDeferred({
      ...d,
      assessor: makeAssessor(storeWith(['sanctions'])), // OFAC direct hit landed after approval
      now: () => t0 + 1000,
    })
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true) // settled as a veto, not released
  })

  it('KEEPS the hold when releasing it fails to send — the packet must not be lost', async () => {
    const t0 = 1_000_000
    const d = await held(['sanctions_1hop'], t0)
    d.checkpoint.addApproval(PAYLOAD)
    const failing = { ...d, verify: vi.fn(async () => { throw new Error('rpc down') }), now: () => t0 + 1000 }
    await processDeferred(failing)
    expect(d.checkpoint.isProcessed(KEY)).toBe(false)
    expect(d.checkpoint.getDeferred(KEY)).toBeDefined() // still held, retried next tick

    // ...and the next pass, with a working RPC, still releases it.
    await processDeferred({ ...d, now: () => t0 + 2000 })
    expect(d.verify).toHaveBeenCalledOnce()
    expect(d.checkpoint.isProcessed(KEY)).toBe(true)
  })

  it('drops a deferred record for a packet that was settled elsewhere', async () => {
    const t0 = 1_000_000
    const d = await held(['sanctions_1hop'], t0)
    d.checkpoint.markProcessed(KEY)
    await processDeferred({ ...d, now: () => t0 + 1000 })
    expect(d.checkpoint.getDeferred(KEY)).toBeUndefined()
    expect(d.verify).not.toHaveBeenCalled()
  })

  it('survives a restart — holds and approvals are persisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dvn-cp-'))
    const path = join(dir, 'cp.json')
    const t0 = 1_000_000

    const first = deps({
      assessor: makeAssessor(storeWith(['sanctions_1hop'], 'trusted_indexer')),
      checkpoint: new Checkpoint(path),
      now: () => t0,
    })
    await verifyPacket(packet(), first)
    first.checkpoint.addApproval(PAYLOAD)
    first.checkpoint.save()

    const reloaded = new Checkpoint(path)
    expect(reloaded.getDeferred(KEY)!.action).toBe('manual-review')
    expect(reloaded.isApproved(PAYLOAD)).toBe(true)

    const second = deps({ checkpoint: reloaded, now: () => t0 + 1000 })
    await processDeferred(second)
    expect(second.verify).toHaveBeenCalledOnce()
  })
})
