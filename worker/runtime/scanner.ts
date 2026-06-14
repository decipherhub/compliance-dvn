import type { Logger } from 'pino'
import type { Metrics } from './metrics'
import type { ResolvedChain } from './config'
import type { DvnState } from './denylist-manager'
import type { ParsedPacket } from '../chain/events'
import type { Assessor } from '../assess/assess'
import { combine } from '../assess/assess'
import { Checkpoint } from '../checkpoint'

/** The slice of an ethers provider the scanner needs (kept tiny for testability). */
export interface BlockHeightSource {
  getBlockNumber(): Promise<number>
}

export interface ScanChainDeps {
  chain: ResolvedChain
  provider: BlockHeightSource
  confirmations: number
  /** How far back to backfill on a cold checkpoint. */
  scanWindow: number
  /** Current fail-closed state — verification proceeds only when READY. */
  state: () => DvnState
  checkpoint: Checkpoint
  scanAssigned: (fromBlock: number, toBlock: number) => Promise<Set<string>>
  scanPackets: (fromBlock: number, toBlock: number) => Promise<ParsedPacket[]>
  handlePacket: (p: ParsedPacket) => Promise<void>
  metrics: Metrics
  logger: Logger
}

/**
 * Scan one chain once: read the safe head, and only when READY, process packets assigned to
 * our DVN and advance the checkpoint.
 *
 * Fail-closed freeze: when not READY we return without scanning OR advancing the checkpoint,
 * so every packet in the unscreened window is processed once the worker recovers — no packet
 * passes the verification window unscreened. Errors are counted and rethrown so the caller
 * can isolate one chain's failure from the others.
 */
export async function scanChainOnce(deps: ScanChainDeps): Promise<void> {
  const { chain, metrics, logger } = deps
  const log = logger.child({ chain: chain.key })
  try {
    const head = await deps.provider.getBlockNumber()
    metrics.chainHeadBlock.set({ chain: chain.key }, head)
    const safeHead = head - deps.confirmations

    let from = deps.checkpoint.getLastBlock(chain.key)
    if (from === 0) from = Math.max(0, safeHead - deps.scanWindow)
    if (safeHead <= from) return

    // FAIL-CLOSED FREEZE: do not scan, verify, or advance while not READY.
    if (deps.state() !== 'READY') {
      log.warn({ state: deps.state(), from, safeHead }, 'not READY — freezing checkpoint, withholding verification')
      return
    }

    const [assigned, packets] = await Promise.all([
      deps.scanAssigned(from + 1, safeHead),
      deps.scanPackets(from + 1, safeHead),
    ])
    metrics.packetsScanned.inc({ chain: chain.key }, packets.length)

    for (const p of packets) {
      // Re-check at packet granularity: the denylist can age into HALTED during the awaits
      // above (TOCTOU). If so, abort WITHOUT advancing the checkpoint so the window stays
      // frozen and every packet is re-screened once we recover.
      if (deps.state() !== 'READY') {
        log.warn({ state: deps.state() }, 'state changed mid-scan — aborting; checkpoint frozen')
        return
      }
      if (!assigned.has(p.payloadHash.toLowerCase())) continue
      metrics.packetsAssigned.inc({ chain: chain.key })
      await deps.handlePacket(p)
    }

    deps.checkpoint.setLastBlock(chain.key, safeHead)
    deps.checkpoint.save()
    metrics.checkpointBlock.set({ chain: chain.key }, safeHead)
  } catch (err) {
    metrics.scanErrors.inc({ chain: chain.key })
    throw err
  }
}

export interface VerifyPacketDeps {
  assessor: Assessor
  resolveDst: (eid: number) => ResolvedChain | undefined
  verify: (dst: ResolvedChain, header: string, payloadHash: string) => Promise<string>
  commit: (dst: ResolvedChain, header: string, payloadHash: string) => Promise<string>
  checkpoint: Checkpoint
  metrics: Metrics
  logger: Logger
  srcChainKey: string
}

/**
 * Screen one packet and act on the verdict:
 *   - sanctioned  -> VETO (withhold verification), mark processed so we don't reconsider it
 *   - clean       -> submit verification, then drive commit so the message can be delivered
 *
 * Verification is recorded as processed only after it lands on-chain; commit is best-effort
 * (the executor or a later run can commit), so a commit failure does not undo the verify.
 */
export async function verifyPacket(p: ParsedPacket, deps: VerifyPacketDeps): Promise<void> {
  const key = `${p.payloadHash}:${p.dstEid}`
  if (deps.checkpoint.isProcessed(key)) return

  const dst = deps.resolveDst(p.dstEid)
  if (!dst) {
    deps.logger.warn({ dstEid: p.dstEid, payloadHash: p.payloadHash }, 'skip: unknown destination EID')
    return
  }
  const log = deps.logger.child({ chain: deps.srcChainKey, payloadHash: p.payloadHash })

  const verdict = combine([
    deps.assessor(p.senderAddress),
    deps.assessor(p.receiverAddress),
    deps.assessor(p.oft.toAddress),
  ])

  if (verdict.blocked) {
    for (const tag of verdict.tags.length ? verdict.tags : ['unknown']) {
      deps.metrics.vetoes.inc({ chain: deps.srcChainKey, tag })
    }
    log.warn({ reasons: verdict.reasons, tags: verdict.tags }, 'VETO — withholding verification for sanctioned transfer')
    deps.checkpoint.markProcessed(key)
    deps.checkpoint.save()
    return
  }

  try {
    const verifyTx = await deps.verify(dst, p.header, p.payloadHash)
    deps.metrics.verifications.inc({ chain: deps.srcChainKey, result: 'success' })
    log.info({ tx: verifyTx, dst: dst.key }, 'VERIFY submitted')
    deps.checkpoint.markProcessed(key)
    deps.checkpoint.save()
  } catch (err) {
    deps.metrics.verifications.inc({ chain: deps.srcChainKey, result: 'failure' })
    log.error({ err: (err as Error).message }, 'submitVerification failed; will retry next scan')
    return
  }

  // Drive commit so the default executor delivers the message (it does not commit for
  // custom DVNs). Best-effort: verification is already on-chain.
  try {
    const commitTx = await deps.commit(dst, p.header, p.payloadHash)
    deps.metrics.commits.inc({ chain: deps.srcChainKey, result: 'success' })
    log.info({ tx: commitTx, dst: dst.key }, 'COMMIT driven')
  } catch (err) {
    deps.metrics.commits.inc({ chain: deps.srcChainKey, result: 'failure' })
    log.warn({ err: (err as Error).message }, 'commit pending (verified on-chain; executor/next run may commit)')
  }
}
