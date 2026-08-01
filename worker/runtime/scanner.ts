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
import { briefError } from './errors'

/** The slice of an ethers provider the scanner needs (kept tiny for testability). */
export interface BlockHeightSource {
  getBlockNumber(): Promise<number>
}

export interface ScanChainDeps {
  chain: ResolvedChain
  provider: BlockHeightSource
  /** Blocks to stay behind the head while scanning — NOT the value attested on-chain. */
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

/**
 * How far a packet has already got on the destination, independent of who took it there.
 *
 *  - `pending`   nothing has committed it; a commit failure here is a real failure
 *  - `committed` the payload is committed and waiting to be executed
 *  - `cleared`   the slot has moved on — executed, or abandoned by a skip
 */
export type CommitState = 'pending' | 'committed' | 'cleared'

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
   * Deliver the message by running `lzReceive`. Optional: omitted, the packet is still verified and
   * committed, and delivery waits on whatever executor is watching the pathway.
   */
  execute?: (dst: ResolvedChain, header: string, guid: string, message: string) => Promise<string>
  /**
   * Emit a verdict for a packet that was not verified. Optional: omitted, the outcome is still
   * enforced and simply not recorded on-chain.
   */
  recordVerdict?: (dst: ResolvedChain, payloadHash: string, verdict: OnChainVerdict) => Promise<string>
  /** Which non-allow actions get a separate `recordVerdict` transaction. */
  emitVerdictFor?: ReadonlySet<RiskAction>
  /**
   * Whether the owner has abandoned a held packet by skipping its nonce. Optional: omitted, a
   * rejected packet simply stays in the queue being re-screened.
   */
  abandoned?: (dst: ResolvedChain, header: string) => Promise<boolean>
  /**
   * What the destination already knows about a packet, used to tell a lost race from a real
   * failure. Optional: omitted, a race is reported as a failure — noisy, but never wrong about
   * enforcement.
   */
  commitState?: (dst: ResolvedChain, header: string, payloadHash: string) => Promise<CommitState>
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
  /** Needed to deliver the message; absent for holds persisted before delivery was driven here. */
  guid?: string
  message?: string
}

/** Screen every party concurrently and fold the results into one verdict. */
function screen(parties: Party[], assessor: Assessor): Promise<Assessment> {
  return Promise.all(parties.map((p) => assessor(p.subject, p.chainKey))).then(combine)
}

/** Count each evidence record a screening produced, so the dashboard shows which signals fire. */
function countEvidence(verdict: Assessment, metrics: Metrics): void {
  for (const e of verdict.evidence) metrics.screeningEvidence.inc({ type: e.type, source: e.source })
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
 *
 * Returns whether the verification landed. On failure the caller must leave the packet
 * somewhere the next tick can find it — the scan cursor advances past its block, so a packet
 * that is neither processed nor deferred is lost, not retried.
 */
async function submitAndCommit(
  s: Subject,
  verdict: Assessment,
  deps: ProcessDeferredDeps,
  log: Logger,
  opts: { overrideAction?: RiskAction; extraReasons?: string[] } = {},
): Promise<boolean> {
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
    log.error({ err: briefError(err) }, 'submitVerification failed; packet stays held for retry')
    return false
  }

  try {
    const commitTx = await deps.commit(s.dst, s.header, s.payloadHash)
    deps.metrics.commits.inc({ chain: s.srcChainKey, result: 'success' })
    log.info({ tx: commitTx, dst: s.dst.key }, 'COMMIT driven')
  } catch (err) {
    // The LayerZero executor watches this pathway too and sometimes commits first. When it does,
    // our commit reverts with the same `LZ_ULN_Verifying` the ULN uses for "not verified yet" —
    // committing consumes the attestation from storage, so the two are indistinguishable from the
    // error alone. Asking the destination what state the packet is in tells them apart.
    const state = await commitStateOf(s, deps, log)
    if (state === 'pending' || state === 'unknown') {
      deps.metrics.commits.inc({ chain: s.srcChainKey, result: 'failure' })
      log.warn(
        { err: briefError(err), state },
        'commit pending (verified on-chain; executor/next run may commit)',
      )
      // Nothing to deliver until the packet is committed.
      return true
    }
    deps.metrics.commits.inc({ chain: s.srcChainKey, result: 'raced' })
    log.info({ state, dst: s.dst.key }, 'COMMIT already done by the executor')
    if (state === 'cleared') return true // executed as well — nothing left to deliver
  }

  // Delivery. Committing only makes the packet executable — for a custom DVN pathway no executor
  // runs `lzReceive`, so the message would sit undelivered. Best-effort like the commit: the
  // enforcement decision is already settled, and a failure here costs delivery latency, not safety.
  if (deps.execute && s.guid && s.message) {
    try {
      const tx = await deps.execute(s.dst, s.header, s.guid, s.message)
      deps.metrics.deliveries.inc({ chain: s.srcChainKey, result: 'success' })
      log.info({ tx, dst: s.dst.key }, 'DELIVERED (lzReceive driven)')
    } catch (err) {
      // Same race, one step later: the executor may have run `lzReceive` between our commit and
      // this call, which leaves the nonce cleared and our call reverting.
      if ((await commitStateOf(s, deps, log)) === 'cleared') {
        deps.metrics.deliveries.inc({ chain: s.srcChainKey, result: 'raced' })
        log.info({ dst: s.dst.key }, 'DELIVERED by the executor')
      } else {
        deps.metrics.deliveries.inc({ chain: s.srcChainKey, result: 'failure' })
        log.warn(
          { err: briefError(err) },
          'lzReceive failed (committed on-chain; an executor or a later run may still deliver)',
        )
      }
    }
  }
  return true
}

/** The destination's own account of a packet. `unknown` when it cannot be read — never assumed. */
async function commitStateOf(
  s: Subject,
  deps: ProcessDeferredDeps,
  log: Logger,
): Promise<CommitState | 'unknown'> {
  if (!deps.commitState) return 'unknown'
  try {
    return await deps.commitState(s.dst, s.header, s.payloadHash)
  } catch (err) {
    log.debug({ err: briefError(err) }, 'could not read the packet state on the destination')
    return 'unknown'
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
    // Carried so a released packet can still be delivered: by then its source block is far behind
    // the scan cursor and the message cannot be read again.
    guid: s.guid,
    message: s.message,
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
      { err: briefError(err), action: verdict.action },
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
  countEvidence(verdict, deps.metrics)
  const s: Subject = {
    key,
    payloadHash: p.payloadHash,
    header: p.header,
    dstEid: p.dstEid,
    dst,
    srcChainKey: deps.srcChainKey,
    parties,
    guid: p.guid,
    message: p.message,
  }

  deps.metrics.decisions.inc({ chain: deps.srcChainKey, action: verdict.action })
  switch (verdict.action) {
    case 'allow': {
      if (await submitAndCommit(s, verdict, deps, log)) return
      // The send failed after screening said allow. Defer rather than drop: the scan cursor
      // advances past this packet's block, so without a deferred record it would never be
      // presented again. The delay queue re-screens and re-sends until it lands (or, if the
      // failure persists past DELAY_POLICY.maxAttempts, escalates to a human).
      hold(s, verdict, 'delay', 0, deps, log)
      return
    }
    case 'block':
      return veto(s, verdict, deps, log)
    default:
      hold(s, verdict, verdict.action, 0, deps, log)
      return recordOutcome(s, verdict, deps, log)
  }
}

/**
 * Drop a held packet whose nonce the owner skipped, and report whether it was dropped.
 *
 * This is the owner's refusal, observed rather than obeyed: skipping is signed on the endpoint by
 * the OApp's delegate, and the endpoint enforces it — the worker has no say and no key for it. All
 * that is left here is to stop carrying a packet that can never be delivered.
 *
 * A failed read leaves the packet in the queue. Guessing "abandoned" from an RPC error would throw
 * away a legitimate hold, which is the one outcome that cannot be undone.
 */
async function dropIfAbandoned(
  key: string,
  rec: DeferredRecord,
  dst: ResolvedChain,
  deps: ProcessDeferredDeps,
  log: Logger,
): Promise<boolean> {
  if (!deps.abandoned) return false
  try {
    if (!(await deps.abandoned(dst, rec.header))) return false
  } catch (err) {
    log.warn({ err: briefError(err) }, 'could not check whether the packet was skipped; keeping the hold')
    return false
  }

  deps.checkpoint.clearDeferred(key)
  deps.checkpoint.markProcessed(key)
  deps.checkpoint.save()
  publishPending(deps)
  deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'rejected' })
  log.warn(
    { heldMs: (deps.now ?? Date.now)() - rec.firstDeferredAt, action: rec.action },
    'owner REJECTED — nonce skipped on the destination; dropping the held packet',
  )
  return true
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
    const dst = deps.resolveDst(rec.dstEid)
    if (!dst) {
      deps.logger.warn({ dstEid: rec.dstEid, payloadHash: rec.payloadHash }, 'held packet: unknown destination EID')
      continue
    }
    const log = deps.logger.child({ chain: rec.srcChainKey, payloadHash: rec.payloadHash })

    // Checked ahead of the retry gate, and ahead of approval: a manual-review hold is otherwise
    // skipped outright here, and rejection is exactly the decision an operator makes about one.
    //
    // A rejected packet must leave the queue rather than be re-screened forever — and not only for
    // tidiness. Holds are released when a re-screen comes back clean, so a packet the owner refused
    // would be released the moment its risk label expired, into a channel that can no longer carry
    // it. Dropping it makes the refusal stick.
    if (await dropIfAbandoned(key, rec, dst, deps, log)) continue

    const approved = deps.checkpoint.isApproved(rec.payloadHash)
    if (!approved && (rec.action === 'manual-review' || rec.retryAfter > now)) continue
    const verdict = await screen(rec.parties, deps.assessor)
    countEvidence(verdict, deps.metrics)
    const s: Subject = {
      key,
      payloadHash: rec.payloadHash,
      header: rec.header,
      dstEid: rec.dstEid,
      dst,
      srcChainKey: rec.srcChainKey,
      parties: rec.parties,
      guid: rec.guid,
      message: rec.message,
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
      if (await submitAndCommit(s, verdict, deps, log)) continue
      // The send failed: fall through to the retry accounting below, so a destination chain
      // that stays unreachable escalates to a human instead of retrying forever.
    } else if (verdict.action === 'block') {
      deps.metrics.decisions.inc({ chain: rec.srcChainKey, action: 'block' })
      await veto(s, verdict, deps, log)
      continue
    } else if (verdict.action === 'manual-review') {
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
