import { RiskStore } from './store'
import { evaluate, worseAction, LABEL_WEIGHTS, type PolicyEntry, type RiskAction } from './policy'
import type { LabelSource } from './sources'
import type { ContractInspector, ContractFacts } from './providers/contract'
import { isFakeStablecoin, type TokenInspector } from './providers/token'
import { ingestOfac } from './ingest/ofac'
import { ingestOpenSanctions } from './ingest/opensanctions'
import { ingestMixers } from './ingest/mixers'
import { loadScamTokens } from './ingest/tokens'
import { ingestFeed, type FeedConfig, type IngestFeedDeps } from './ingest/feed'
import { loadTestDenylist } from './testDenylist'

export type { RiskAction } from './policy'

/** One scored signal, carrying enough context to explain the verdict after the fact. */
export interface Evidence {
  /** The label, which doubles as the reason code. */
  type: string
  weight: number
  confidence: number
  source: LabelSource
  /**
   * What the signal is about. Usually the assessed subject, but not always: token evidence
   * discovered through an OFT names the token, not the OApp that moves it.
   */
  subject: string
  details?: Record<string, unknown>
}

export interface Assessment {
  subject: string
  score: number
  action: RiskAction
  reasonCodes: string[]
  evidence: Evidence[]
}

/**
 * Screen one subject. `chainKey` selects which chain's state the live checks run against —
 * a packet's parties do not all live on the same chain, so it cannot be inferred. Omit it for
 * store-only screening (the CLI's one-shot lookups and the tracer).
 */
export type Assessor = (subject: string, chainKey?: string) => Promise<Assessment>

/** Reason codes for a live check that could not be completed. Never scored — see below. */
export const CONTRACT_CHECK_UNAVAILABLE = 'contract_check_unavailable'
export const TOKEN_CHECK_UNAVAILABLE = 'token_check_unavailable'

export interface AssessorProviders {
  /** Live contract-state checks (code, proxy, controller). */
  contracts?: ContractInspector
  /** Resolves the ERC-20 an OFT moves and reads its metadata. */
  tokens?: TokenInspector
}

/** A label plus the subject it is about and any supporting detail. */
interface Finding {
  label: string
  subject: string
  source: LabelSource
  confidence: number
  assertedScore?: number
  details?: Record<string, unknown>
}

/**
 * Group findings the way the policy scores them: one entry per (subject, source) claim.
 *
 * An asserted score describes a subject, so it must be counted once per claim. Keying by subject
 * as well as source keeps a token's labels from merging into the OApp's — they are separate
 * claims about separate things that happen to share a source.
 */
function toPolicyEntries(findings: Finding[]): PolicyEntry[] {
  const byClaim = new Map<string, PolicyEntry>()
  for (const f of findings) {
    const key = `${f.subject}|${f.source}`
    const existing = byClaim.get(key)
    if (existing) {
      existing.labels.push(f.label)
      if (f.assertedScore !== undefined) {
        existing.assertedScore = Math.max(existing.assertedScore ?? 0, f.assertedScore)
      }
    } else {
      byClaim.set(key, { source: f.source, labels: [f.label], assertedScore: f.assertedScore })
    }
  }
  return [...byClaim.values()]
}

/** Every label the store holds about a subject, as findings. */
function storeFindings(subject: string, store: RiskStore): Finding[] {
  return store.lookup(subject).flatMap((entry) =>
    entry.labels.map((label) => ({
      label,
      subject,
      source: entry.source,
      confidence: entry.confidence,
      assertedScore: entry.score,
      details: { subjectType: entry.subjectType, ...(entry.evidenceHash ? { evidenceHash: entry.evidenceHash } : {}) },
    })),
  )
}

/** Turn on-chain contract facts into findings. Controller risk is looked up in the store. */
function contractFindings(subject: string, facts: ContractFacts, store: RiskStore): Finding[] {
  if (!facts.isContract) return []
  const out: Finding[] = []
  const own = { subject, source: 'operator' as LabelSource, confidence: 1 }

  if (facts.proxy) {
    out.push({ ...own, label: 'upgradeable_proxy', details: { implementation: facts.implementation } })
  }
  if (facts.controller) {
    const controllerLabels = store.lookup(facts.controller).flatMap((e) => e.labels)
    if (controllerLabels.length) {
      out.push({ ...own, label: 'contract_admin_risk', details: { controller: facts.controller, controllerLabels } })
    }
  }
  return out
}

/**
 * Assessor over a risk store, optionally enriched with live chain checks.
 *
 * With no providers this is a pure store lookup. With them, a subject that holds code also
 * contributes proxy and controller-risk evidence, and an OFT contributes evidence about the
 * token it moves — curated labels on that token, plus a stablecoin-impersonation check.
 *
 * A failed live check does NOT become a scored label. Scoring it would let an RPC hiccup stack
 * on top of an existing 70-point label and cross the block threshold. Instead the verdict is
 * floored at `delay`: the packet is held and re-screened, which is the honest outcome when a
 * signal is missing rather than clean.
 */
export function makeAssessor(store: RiskStore, providers: AssessorProviders = {}): Assessor {
  return async (subject: string, chainKey?: string): Promise<Assessment> => {
    const normalized = subject.toLowerCase()
    const findings: Finding[] = storeFindings(normalized, store)
    const unavailable: string[] = []

    if (chainKey) {
      let facts: ContractFacts | undefined
      if (providers.contracts) {
        try {
          facts = await providers.contracts.inspect(normalized, chainKey)
          findings.push(...contractFindings(normalized, facts, store))
        } catch (err) {
          unavailable.push(CONTRACT_CHECK_UNAVAILABLE)
          findings.push(unavailableFinding(CONTRACT_CHECK_UNAVAILABLE, normalized, chainKey, err))
        }
      }

      // Only OApps that hold code can be an OFT. When contract facts are missing we still try,
      // since a wrong skip here would silently drop token screening.
      if (providers.tokens && facts?.isContract !== false) {
        const resolution = await providers.tokens.resolveToken(normalized, chainKey)
        if (resolution.kind === 'unknown') {
          unavailable.push(TOKEN_CHECK_UNAVAILABLE)
          findings.push(unavailableFinding(TOKEN_CHECK_UNAVAILABLE, normalized, chainKey, new Error(resolution.reason)))
        } else if (resolution.kind === 'token') {
          // Curated labels on the token need no RPC, so they are collected BEFORE the metadata
          // read — otherwise an unrelated RPC failure would discard a definite `scam_token`
          // block and downgrade the packet to a mere hold.
          findings.push(...storeFindings(resolution.address, store))
          try {
            const facts = await providers.tokens.inspect(resolution.address, chainKey)
            if (isFakeStablecoin(facts, chainKey)) {
              findings.push({
                label: 'fake_stablecoin_suspect',
                subject: resolution.address,
                source: 'operator',
                confidence: 1,
                details: { symbol: facts.symbol, decimals: facts.decimals, chainKey },
              })
            }
          } catch (err) {
            unavailable.push(TOKEN_CHECK_UNAVAILABLE)
            findings.push(unavailableFinding(TOKEN_CHECK_UNAVAILABLE, resolution.address, chainKey, err))
          }
        }
      }
    }

    const decision = evaluate(toPolicyEntries(findings.filter((f) => !unavailable.includes(f.label))))

    const evidence: Evidence[] = findings.map((f) => ({
      type: f.label,
      weight: unavailable.includes(f.label) ? 0 : LABEL_WEIGHTS[f.label] ?? 0,
      confidence: f.confidence,
      source: f.source,
      subject: f.subject,
      details: f.details,
    }))

    if (unavailable.length === 0) return { subject: normalized, ...decision, evidence }

    // Fail closed: hold rather than pass on a subject we could not fully screen.
    return {
      subject: normalized,
      score: decision.score,
      action: worseAction(decision.action, 'delay'),
      reasonCodes: [...decision.reasonCodes, ...unavailable],
      evidence,
    }
  }
}

function unavailableFinding(label: string, subject: string, chainKey: string, err: unknown): Finding {
  return {
    label,
    subject,
    source: 'operator',
    confidence: 0,
    details: { chainKey, error: (err as Error).message },
  }
}

/**
 * Fold per-party assessments into the packet's verdict: the worst action wins.
 *
 * Scores are maxed rather than summed — a sender and a receiver each scoring 70 describes two
 * separate risks, not one at 140, and summing them would silently promote two `manual-review`
 * parties into a `block`.
 */
export function combine(parts: Assessment[]): Assessment {
  return {
    subject: parts.map((p) => p.subject).join(','),
    score: Math.max(0, ...parts.map((p) => p.score)),
    action: parts.reduce<RiskAction>((acc, p) => worseAction(acc, p.action), 'allow'),
    reasonCodes: [...new Set(parts.flatMap((p) => p.reasonCodes))],
    evidence: parts.flatMap((p) => p.evidence),
  }
}

/** The outcome of one build, not just its result. */
export interface RiskStoreBuild {
  store: RiskStore
  /**
   * Sources that failed but were tolerated, so the caller can decide whether to keep verifying.
   * Empty on a clean build. Authoritative sanctions sources are never listed here — their
   * failure aborts the build outright.
   */
  degraded: string[]
}

export interface BuildRiskStoreOptions {
  /** Signed indexer feed. Omit to run on authoritative sources only. */
  feed?: FeedConfig
  feedDeps?: IngestFeedDeps
  /** Called when a tolerated source fails, so the caller can log and count it. */
  onDegraded?: (source: string, err: Error) => void
}

/**
 * Build a risk store from all sources.
 *
 * The sanctions sources are load-bearing: if OFAC or OpenSanctions cannot be fetched we throw,
 * and the caller's fail-closed lifecycle withholds verification. The indexer feed is not treated
 * the same way — losing graph labels should not also cost us sanctions screening — so a feed
 * failure is reported as degraded and the build still succeeds. Whether degraded is allowed to
 * keep verifying is the operator's call, not this function's.
 */
/**
 * Re-ingest just the indexer feed into an existing store.
 *
 * A full rebuild re-downloads OFAC and OpenSanctions, which is why it runs on a long timer. The
 * feed is a single local request, so it can be refreshed far more often — which is what makes a
 * newly published graph label visible in seconds instead of on the next rebuild.
 *
 * Feed entries expire on their own (`expiresAt`), so ingesting into a live store rather than a
 * fresh one is safe: an address the indexer drops stops being scored when its TTL lapses, and the
 * next full rebuild removes it outright.
 */
export async function refreshFeedInto(store: RiskStore, opts: BuildRiskStoreOptions = {}): Promise<number> {
  if (!opts.feed || !opts.feedDeps) return 0
  try {
    return await ingestFeed(store, opts.feed, opts.feedDeps)
  } catch (err) {
    opts.onDegraded?.('trusted_indexer', err as Error)
    return 0
  }
}

export async function buildRiskStore(opts: BuildRiskStoreOptions = {}): Promise<RiskStoreBuild> {
  const store = new RiskStore()
  await ingestOfac(store)
  await ingestOpenSanctions(store)
  ingestMixers(store)
  loadScamTokens(store)
  loadTestDenylist(store)

  const degraded: string[] = []
  if (opts.feed && opts.feedDeps) {
    try {
      await ingestFeed(store, opts.feed, opts.feedDeps)
    } catch (err) {
      degraded.push('trusted_indexer')
      opts.onDegraded?.('trusted_indexer', err as Error)
    }
  }
  return { store, degraded }
}
