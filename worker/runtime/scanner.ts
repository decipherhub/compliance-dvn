import type { Logger } from 'pino'
import type { Metrics } from './metrics'
import type { ResolvedChain } from './config'
import type { DvnState } from './denylist-manager'
import type { ParsedPacket } from '../chain/events'
import type { Assessor, Assessment } from '../assess/assess'
import { combine } from '../assess/assess'
import { DELAY_POLICY, type RiskAction } from '../assess/policy'
import { encodeVerdict, type OnChainVerdict } from '../assess/verdict'
import { Checkpoint, type DeferredAction, type DeferredRecord, type Party } from '../checkpoint'

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
  /** Maximum blocks per getLogs range. */
  scanChunk: number
  /** Current fail-closed state — verification proceeds only when READY. */
  state: () => DvnState
  checkpoint: Checkpoint
  scanAssigned: (fromBlock: number, toBlock: number) => Promise<Set<string>>
  scanPackets: (fromBlock: number, toBlock: number) => Promise<ParsedPacket[]>
  scanApproved: (fromBlock: number, toBlock: number) => Promise<Set<string>>
  handlePacket: (p: ParsedPacket) => Promise<void>
  metrics: Metrics
  logger: Logger
}

/**
 * Scan one chain once: read the safe head, and only when READY, record owner approvals,
 * process packets assigned to our DVN, and advance the checkpoint.
 *
 * Fail-closed freeze: when not READY we return without scanning OR advancing the checkpoint,
 * so every packet in the unscreened window is processed once the worker recovers — no packet
 * passes the verification window unscreened. Approvals ride the same cursor, so a freeze
 * delays them rather than losing them. Errors are counted and rethrown so the caller can
 * isolate one chain's failure from the others.
 */
export async function scanChainOnce(deps: ScanChainDeps): Promise<void> {
  const { chain, metrics, logger } = deps
  const log = logger.child({ chain: chain.key })
  try {
    const head = await deps.provider.getBlockNumber()
    metrics.chainHeadBlock.set({ chain: chain.key }, head)
    const safeHead = head - deps.confirmations

    let cursor = deps.checkpoint.getLastBlock(chain.key)
    if (cursor === 0) cursor = Math.max(0, safeHead - deps.scanWindow)
    if (safeHead <= cursor) return

    // FAIL-CLOSED FREEZE: do not scan, verify, or advance while not READY.
    if (deps.state() !== 'READY') {
      log.warn({ state: deps.state(), from: cursor, safeHead }, 'not READY — freezing checkpoint, withholding verification')
      return
    }

    // Bounded chunks, and the checkpoint advances per chunk. Public RPCs cap getLogs ranges
    // (2000 blocks is typical), and the freeze above deliberately holds the checkpoint through an
    // outage — so the gap on recovery can exceed that cap. Querying it whole would fail every
    // tick while the gap only grew, wedging the worker permanently instead of catching up.
    while (cursor < safeHead) {
      const from = cursor + 1
      const to = Math.min(from + deps.scanChunk - 1, safeHead)

      const [assigned, packets, approved] = await Promise.all([
        deps.scanAssigned(from, to),
        deps.scanPackets(from, to),
        deps.scanApproved(from, to),
      ])
      metrics.packetsScanned.inc({ chain: chain.key }, packets.length)

      for (const payloadHash of approved) {
        deps.checkpoint.addApproval(payloadHash)
        metrics.approvals.inc({ chain: chain.key })
        log.warn({ payloadHash }, 'owner approval observed on-chain')
      }

      for (const p of packets) {
        // Re-check at packet granularity: the risk store can age into HALTED during the awaits
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

      deps.checkpoint.setLastBlock(chain.key, to)
      deps.checkpoint.save()
      metrics.checkpointBlock.set({ chain: chain.key }, to)
      cursor = to
    }
  } catch (err) {
    metrics.scanErrors.inc({ chain: chain.key })
    throw err
  }
}

/** Everything both the live path and the deferred-queue path need. */
export interface ProcessDeferredDeps {
  assessor: Assessor
  resolveDst: (eid: number) => ResolvedChain | undefined
  verify: (
    dst: ResolvedChain,
    header: string,
    payloadHash: string,
    verdict: OnChainVerdict,
  ) => Promise<string>
  commit: (dst: ResolvedChain, header: string, payloadHash: string) => Promise<string>
  /**
   * Emit a verdict for a packet that was not verified. Optional: omitted, the outcome is still
   * enforced and simply not recorded on-chain.
   */
  recordVerdict?: (dst: ResolvedChain, payloadHash: string, verdict: OnChainVerdict) => Promise<string>
  /** Which non-allow actions get a separate `recordVerdict` transaction. */
  emitVerdictFor?: ReadonlySet<RiskAction>
  checkpoint: Checkpoint
  metrics: Metrics
  logger: Logger
  now?: () => number
}

export interface VerifyPacketDeps extends ProcessDeferredDeps {
  srcChainKey: string
}

/** What a decision is applied to, independent of whether it arrived live or from the queue. */
interface Subject {
  key: string
  payloadHash: string
  header: string
  dstEid: number
  dst: ResolvedChain
  srcChainKey: string
  parties: Party[]
}

/** Screen every party concurrently and fold the results into one verdict. */
function screen(parties: Party[], assessor: Assessor): Promise<Assessment> {
  return Promise.all(parties.map((p) => assessor(p.subject, p.chainKey))).then(combine)
}

function publishPending(deps: ProcessDeferredDeps): void {
  const counts = deps.checkpoint.deferredCounts()
  for (const [action, n] of Object.entries(counts)) deps.metrics.pendingPackets.set({ action }, n)
}

/** Encode the verdict for the chain, logging any reason code that has no assigned bit. */
function encodeFor(
  s: Subject,
  verdict: Assessment,
  log: Logger,
  opts: { overrideAction?: RiskAction; extraReasons?: string[] } = {},
): OnChainVerdict {
  const { encoded, unmapped } = encodeVerdict(s.payloadHash, verdict, s.parties, opts)
  if (unmapped.length) {
    log.warn({ unmapped }, 'reason codes have no reasonMask bit — recorded as unmapped; add them to REASON_BITS')
  }
  return encoded
}

/**
 * Submit verification, then drive commit so the default executor delivers the message (it does
 * not commit for custom DVNs). Verification is recorded as processed only after it lands
 * on-chain; commit is best-effort, so a commit failure does not undo the verify.
 *
 * The verdict travels with `submitVerification` at no extra transaction cost, so an allowed
 * packet always carries an on-chain reason for having been allowed.
 */
async function submitAndCommit(
  s: Subject,
  verdict: Assessment,
  deps: ProcessDeferredDeps,
  log: Logger,
  opts: { overrideAction?: RiskAction; extraReasons?: string[] } = {},
): Promise<void> {
  // The contract accepts only ACTION_ALLOW on a verification, so a release keeps its reasons
  // while reporting the action actually taken.
  const encoded = encodeFor(s, verdict, log, { overrideAction: 'allow', ...opts })
  try {
    const verifyTx = await deps.verify(s.dst, s.header, s.payloadHash, encoded)
    deps.metrics.verifications.inc({ chain: s.srcChainKey, result: 'success' })
    log.info({ tx: verifyTx, dst: s.dst.key }, 'VERIFY submitted')
    deps.checkpoint.markProcessed(s.key)
    deps.checkpoint.save()
    publishPending(deps)
  } catch (err) {
    deps.metrics.verifications.inc({ chain: s.srcChainKey, result: 'failure' })
    log.error({ err: (err as Error).message }, 'submitVerification failed; will retry next scan')
    return
  }

  try {
    const commitTx = await deps.commit(s.dst, s.header, s.payloadHash)
    deps.metrics.commits.inc({ chain: s.srcChainKey, result: 'success' })
    log.info({ tx: commitTx, dst: s.dst.key }, 'COMMIT driven')
  } catch (err) {
    deps.metrics.commits.inc({ chain: s.srcChainKey, result: 'failure' })
    log.warn({ err: (err as Error).message }, 'commit pending (verified on-chain; executor/next run may commit)')
  }
}

/** Withhold the packet and record why, so the next tick can reconsider it. */
function hold(
  s: Subject,
  verdict: Assessment,
  action: DeferredAction,
  attempts: number,
  deps: ProcessDeferredDeps,
  log: Logger,
): void {
  const now = (deps.now ?? Date.now)()
  const existing = deps.checkpoint.getDeferred(s.key)
  const record: DeferredRecord = {
    payloadHash: s.payloadHash,
    dstEid: s.dstEid,
    header: s.header,
    srcChainKey: s.srcChainKey,
    parties: s.parties,
    action,
    score: verdict.score,
    reasonCodes: verdict.reasonCodes,
    attempts,
    // A manual-review hold is released by an on-chain approval, never by the clock.
    retryAfter: action === 'delay' ? now + DELAY_POLICY.retryAfterMs : Number.MAX_SAFE_INTEGER,
    firstDeferredAt: existing?.firstDeferredAt ?? now,
  }
  deps.checkpoint.defer(s.key, record)
  deps.checkpoint.save()
  publishPending(deps)
  log.warn(
    { action, score: verdict.score, reasonCodes: verdict.reasonCodes, attempts },
    action === 'manual-review'
      ? 'WITHHELD — awaiting owner approval (approvePacket)'
      : 'WITHHELD — will re-screen after delay',
  )
}

/**
 * Refuse the packet for good. Withholding verification IS the veto; nothing is submitted.
 *
 * The refusal is settled locally BEFORE any attempt to record it on-chain, and the recording is
 * best-effort. Enforcement must not depend on a transaction succeeding — a failed record costs
 * an audit entry, whereas a failed enforcement would let the packet through. The trade is
 * deliberate: `dvn_verdict_records_total{result="failure"}` counts what was lost.
 */
async function veto(s: Subject, verdict: Assessment, deps: ProcessDeferredDeps, log: Logger): Promise<void> {
  log.warn(
    { score: verdict.score, reasonCodes: verdict.reasonCodes },
    'VETO — withholding verification for sanctioned transfer',
  )
  deps.checkpoint.markProcessed(s.key)
  deps.checkpoint.save()
  publishPending(deps)
  await recordOutcome(s, verdict, deps, log)
}

/** Emit a verdict for a packet that was not verified, if configured and available. */
async function recordOutcome(
  s: Subject,
  verdict: Assessment,
  deps: ProcessDeferredDeps,
  log: Logger,
): Promise<void> {
  if (!deps.recordVerdict || !deps.emitVerdictFor?.has(verdict.action)) return
  try {
    const tx = await deps.recordVerdict(s.dst, s.payloadHash, encodeFor(s, verdict, log))
    deps.metrics.verdictRecords.inc({ chain: s.srcChainKey, result: 'success' })
    log.info({ tx, action: verdict.action }, 'verdict recorded on-chain')
  } catch (err) {
    deps.metrics.verdictRecords.inc({ chain: s.srcChainKey, result: 'failure' })
    log.error(
      { err: (err as Error).message, action: verdict.action },
      'verdict record FAILED — outcome is still enforced, but this decision has no on-chain record',
    )
  }
}

/**
 * Screen one freshly scanned packet and act on the verdict:
 *   - allow         -> submit verification, then drive commit
 *   - delay         -> withhold, re-screen after DELAY_POLICY.retryAfterMs
 *   - manual-review -> withhold until the owner calls approvePacket
 *   - block         -> veto, settled for good
 */
export async function verifyPacket(p: ParsedPacket, deps: VerifyPacketDeps): Promise<void> {
  const key = `${p.payloadHash}:${p.dstEid}`
  if (deps.checkpoint.isProcessed(key)) return
  // Already held: the deferred queue owns its lifecycle, including re-screening.
  if (deps.checkpoint.getDeferred(key)) return

  const dst = deps.resolveDst(p.dstEid)
  if (!dst) {
    deps.logger.warn({ dstEid: p.dstEid, payloadHash: p.payloadHash }, 'skip: unknown destination EID')
    return
  }
  const log = deps.logger.child({ chain: deps.srcChainKey, payloadHash: p.payloadHash })

  // The sender is an OApp on the source chain; the receiver OApp and the OFT recipient are on
  // the destination. Contract checks read chain state, so each party carries its own chain.
  const parties: Party[] = [
    { subject: p.senderAddress, chainKey: deps.srcChainKey },
    { subject: p.receiverAddress, chainKey: dst.key },
    { subject: p.oft.toAddress, chainKey: dst.key },
  ]
  const verdict = await screen(parties, deps.assessor)
  const s: Subject = {
    key,
    payloadHash: p.payloadHash,
    header: p.header,
    dstEid: p.dstEid,
    dst,
    srcChainKey: deps.srcChainKey,
    parties,
  }

  deps.metrics.decisions.inc({ chain: deps.srcChainKey, action: verdict.action })
  switch (verdict.action) {
    case 'allow':
      return submitAndCommit(s, verdict, deps, log)
    case 'block':
      return veto(s, verdict, deps, log)
    default:
      hold(s, verdict, verdict.action, 0, deps, log)
      return recordOutcome(s, verdict, deps, log)
  }
}

/**
 * Reconsider every held packet once. Runs independently of the per-chain scan cursor, so a
 * hold is never lost by the checkpoint advancing past the block it came from.
 *
 * Two things release a hold: the clock (a `delay` whose `retryAfter` has passed is re-screened
 * against the current risk store) and an owner approval observed on-chain. A `delay` that
 * keeps scoring `delay` escalates to `manual-review` once `DELAY_POLICY.maxAttempts` is
 * exhausted, so nothing loops forever waiting for a signal that is not coming.
 *
 * `dvn_decisions_total` counts terminal outcomes and action changes only — a retry that lands
 * on the same action is not a new decision, or a single delayed packet would look like eight.
 */
export async function processDeferred(deps: ProcessDeferredDeps): Promise<void> {
  const now = (deps.now ?? Date.now)()

  for (const [key, rec] of deps.checkpoint.deferredEntries()) {
    if (deps.checkpoint.isProcessed(key)) {
      deps.checkpoint.clearDeferred(key)
      continue
    }
    const approved = deps.checkpoint.isApproved(rec.payloadHash)
    if (!approved && (rec.action === 'manual-review' || rec.retryAfter > now)) continue

    const dst = deps.resolveDst(rec.dstEid)
    if (!dst) {
      deps.logger.warn({ dstEid: rec.dstEid, payloadHash: rec.payloadHash }, 'held packet: unknown destination EID')
      continue
    }
    const log = deps.logger.child({ chain: rec.srcChainKey, payloadHash: rec.payloadHash })
    const verdict = await screen(rec.parties, deps.assessor)
    const s: Subject = {
      key,
      payloadHash: rec.payloadHash,
      header: rec.header,
      dstEid: rec.dstEid,
      dst,
      srcChainKey: rec.srcChainKey,
      parties: rec.parties,
    }

    if (approved) {
      // An approval overrides a hold, not a refusal. If the packet now scores `block` — a
      // direct sanctions hit landed after the operator signed off — the refusal wins.
      if (verdict.action === 'block') {
        deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'block' })
        log.error(
          { score: verdict.score, reasonCodes: verdict.reasonCodes },
          'approval REFUSED — packet now scores block; vetoing despite owner approval',
        )
        await veto(s, verdict, deps, log)
        continue
      }
      deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'allow' })
      log.warn({ heldMs: now - rec.firstDeferredAt }, 'owner-approved — releasing held packet')
      // The hold is dropped by markProcessed once verification lands, never before: if the
      // send fails here, the record must survive or the packet is lost — its source block is
      // long behind the scan cursor and cannot be re-read.
      //
      // Recorded as `allow` with `owner_approved` in the mask: the action taken was to allow it,
      // and the audit trail should say a human did that rather than a re-screen.
      await submitAndCommit(s, verdict, deps, log, { extraReasons: ['owner_approved'] })
      continue
    }

    if (verdict.action === 'allow') {
      deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'allow' })
      log.info({ attempts: rec.attempts }, 're-screened clean — releasing held packet')
      await submitAndCommit(s, verdict, deps, log)
      continue
    }
    if (verdict.action === 'block') {
      deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'block' })
      await veto(s, verdict, deps, log)
      continue
    }
    if (verdict.action === 'manual-review') {
      const changed = rec.action !== 'manual-review'
      if (changed) deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'manual-review' })
      hold(s, verdict, 'manual-review', rec.attempts, deps, log)
      // Only a change of action is a new decision; a retry landing on the same one is not, so
      // a held packet does not re-emit the same verdict every tick.
      if (changed) await recordOutcome(s, verdict, deps, log)
      continue
    }

    const attempts = rec.attempts + 1
    if (attempts >= DELAY_POLICY.maxAttempts) {
      deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: DELAY_POLICY.escalateTo })
      log.warn({ attempts, escalateTo: DELAY_POLICY.escalateTo }, 'delay exhausted — escalating')
      hold(s, verdict, DELAY_POLICY.escalateTo as DeferredAction, attempts, deps, log)
      await recordOutcome(s, { ...verdict, action: DELAY_POLICY.escalateTo }, deps, log)
      continue
    }
    hold(s, verdict, 'delay', attempts, deps, log)
  }
}
