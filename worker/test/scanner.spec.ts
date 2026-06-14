import { describe, it, expect, vi } from 'vitest'
import { scanChainOnce, verifyPacket } from '../runtime/scanner'
import { createMetrics } from '../runtime/metrics'
import { Checkpoint } from '../checkpoint'
import { makeAssessor } from '../assess/assess'
import { Denylist } from '../assess/store'
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

function tmpCheckpoint(): Checkpoint {
  const dir = mkdtempSync(join(tmpdir(), 'dvn-cp-'))
  return new Checkpoint(join(dir, 'cp.json'))
}

function packet(overrides: Partial<ParsedPacket> = {}): ParsedPacket {
  return {
    encoded: '0x', header: '0xheader', guid: '0xguid', message: '0xmsg',
    payloadHash: '0x' + 'a'.repeat(64), srcEid: 40245, dstEid: 40232,
    senderAddress: '0x' + '1'.repeat(40), receiverAddress: '0x' + '2'.repeat(40),
    oft: { toAddress: '0x' + '3'.repeat(40), amountSD: 1n, composed: false },
    headerFields: {} as never,
    ...overrides,
  }
}

describe('scanChainOnce', () => {
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
      state: () => 'HALTED',
      checkpoint: cp,
      scanAssigned: vi.fn(),
      scanPackets,
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
    const assignedHash = '0x' + 'a'.repeat(64)
    const handlePacket = vi.fn(async () => {})
    const metrics = createMetrics()
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      state: () => 'READY',
      checkpoint: cp,
      scanAssigned: async () => new Set([assignedHash]),
      scanPackets: async () => [packet({ payloadHash: assignedHash }), packet({ payloadHash: '0x' + 'b'.repeat(64) })],
      handlePacket,
      metrics,
      logger: silent,
    })
    expect(handlePacket).toHaveBeenCalledTimes(1) // only the assigned one
    expect(cp.getLastBlock('baseSepolia')).toBe(995) // 1000 - 5 confirmations
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_checkpoint_block\{[^}]*chain="baseSepolia"[^}]*\} 995/)
  })

  it('aborts mid-scan and freezes the checkpoint if state flips to HALTED during the awaits (TOCTOU)', async () => {
    const cp = tmpCheckpoint()
    cp.setLastBlock('baseSepolia', 100)
    const assignedHash = '0x' + 'a'.repeat(64)
    let state: 'READY' | 'HALTED' = 'READY'
    const handlePacket = vi.fn(async () => {})
    await scanChainOnce({
      chain: baseChain,
      provider: { getBlockNumber: async () => 1000 },
      confirmations: 5,
      scanWindow: 50,
      state: () => state,
      checkpoint: cp,
      scanAssigned: async () => new Set([assignedHash]),
      // Simulate the denylist aging into HALTED during the RPC await window.
      scanPackets: async () => {
        state = 'HALTED'
        return [packet({ payloadHash: assignedHash })]
      },
      handlePacket,
      metrics: createMetrics(),
      logger: silent,
    })
    expect(handlePacket).not.toHaveBeenCalled() // never verified against the stale list
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
      state: () => 'READY',
      checkpoint: cp,
      scanAssigned: vi.fn(),
      scanPackets,
      handlePacket: vi.fn(),
      metrics: createMetrics(),
      logger: silent,
    })
    expect(scanPackets).not.toHaveBeenCalled()
  })

  it('counts a scan error and rethrows for the caller to isolate', async () => {
    const cp = tmpCheckpoint()
    const metrics = createMetrics()
    await expect(
      scanChainOnce({
        chain: baseChain,
        provider: { getBlockNumber: async () => { throw new Error('rpc down') } },
        confirmations: 5,
        scanWindow: 50,
        state: () => 'READY',
        checkpoint: cp,
        scanAssigned: vi.fn(),
        scanPackets: vi.fn(),
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
  const resolveDst = (eid: number) => (eid === 40232 ? optChain : undefined)

  it('verifies and commits a clean packet, then marks it processed', async () => {
    const cp = tmpCheckpoint()
    const verify = vi.fn(async () => '0xverifytx')
    const commit = vi.fn(async () => '0xcommittx')
    await verifyPacket(packet(), {
      assessor: makeAssessor(new Denylist()),
      resolveDst,
      verify,
      commit,
      checkpoint: cp,
      metrics: createMetrics(),
      logger: silent,
      srcChainKey: 'baseSepolia',
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledOnce()
    expect(cp.isProcessed('0x' + 'a'.repeat(64) + ':40232')).toBe(true)
  })

  it('VETOES a sanctioned packet: no verify, marks processed, increments veto metric', async () => {
    const cp = tmpCheckpoint()
    const dl = new Denylist()
    dl.add('0x' + '1'.repeat(40), 'ofac', 'sanctioned sender')
    const verify = vi.fn()
    const commit = vi.fn()
    const metrics = createMetrics()
    await verifyPacket(packet(), {
      assessor: makeAssessor(dl),
      resolveDst,
      verify,
      commit,
      checkpoint: cp,
      metrics,
      logger: silent,
      srcChainKey: 'baseSepolia',
    })
    expect(verify).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(cp.isProcessed('0x' + 'a'.repeat(64) + ':40232')).toBe(true)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_vetoes_total\{[^}]*tag="ofac"[^}]*\} 1/)
  })

  it('skips a packet already processed', async () => {
    const cp = tmpCheckpoint()
    cp.markProcessed('0x' + 'a'.repeat(64) + ':40232')
    const verify = vi.fn()
    await verifyPacket(packet(), {
      assessor: makeAssessor(new Denylist()),
      resolveDst, verify, commit: vi.fn(),
      checkpoint: cp, metrics: createMetrics(), logger: silent, srcChainKey: 'baseSepolia',
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('skips a packet whose destination EID is unknown', async () => {
    const cp = tmpCheckpoint()
    const verify = vi.fn()
    await verifyPacket(packet({ dstEid: 99999 }), {
      assessor: makeAssessor(new Denylist()),
      resolveDst, verify, commit: vi.fn(),
      checkpoint: cp, metrics: createMetrics(), logger: silent, srcChainKey: 'baseSepolia',
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('still marks processed when commit fails (verification already on-chain)', async () => {
    const cp = tmpCheckpoint()
    const verify = vi.fn(async () => '0xverifytx')
    const commit = vi.fn(async () => { throw new Error('commit not ready') })
    const metrics = createMetrics()
    await verifyPacket(packet(), {
      assessor: makeAssessor(new Denylist()),
      resolveDst, verify, commit,
      checkpoint: cp, metrics, logger: silent, srcChainKey: 'baseSepolia',
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(cp.isProcessed('0x' + 'a'.repeat(64) + ':40232')).toBe(true)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_commits_total\{[^}]*result="failure"[^}]*\} 1/)
  })
})
