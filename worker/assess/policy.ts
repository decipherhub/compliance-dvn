import { SOURCE_TRUST, type EnforcementLevel, type LabelSource } from './sources'

/**
 * Risk policy — the weights, thresholds, and timings that turn evidence into an action.
 *
 * These are code constants rather than env config on purpose: a policy change is a reviewed
 * change, and `POLICY_VERSION` is bumped with it so an indexer feed generated under a
 * different policy is rejected instead of silently mixed in.
 */

/** v2: graph proximity extended from 1 hop to 3, with per-depth labels and weights. */
export const POLICY_VERSION = 2

export type RiskAction = 'allow' | 'delay' | 'manual-review' | 'block'

/** Severity order. Used to pick the worse of two actions and to apply source ceilings. */
const SEVERITY: Record<RiskAction, number> = { allow: 0, delay: 1, 'manual-review': 2, block: 3 }

/** The more severe of two actions. */
export function worseAction(a: RiskAction, b: RiskAction): RiskAction {
  return SEVERITY[a] >= SEVERITY[b] ? a : b
}

/** The less severe of two actions — used to clamp a verdict to what its source may cause. */
export function clampAction(action: RiskAction, ceiling: RiskAction): RiskAction {
  return SEVERITY[action] <= SEVERITY[ceiling] ? action : ceiling
}

/**
 * Score each label contributes. Contributions are summed per subject and capped at 100.
 *
 * Graph proximity is graded by distance: each hop roughly halves the weight, because every
 * intermediary between the subject and the seed weakens what the edge proves. A 3-hop label on
 * its own moves no action (25 < the delay threshold) — it exists to combine with other signals.
 */
export const LABEL_WEIGHTS: Record<string, number> = {
  sanctions: 100, // OFAC / OpenSanctions direct hit
  sanctioned_mixer: 100,
  scam_token: 100, // confirmed, not suspected
  operator_deny: 100,
  sanctions_1hop: 70, // subject sent TO a sanctioned address
  fake_stablecoin_suspect: 65,
  mixer_exposure: 60,
  honeypot_suspect: 55,
  contract_admin_risk: 50,
  sanctions_2hop: 45, // one intermediary between the subject and a sanctioned address
  sanctions_1hop_inbound: 40, // a sanctioned address sent TO the subject — see N_HOP
  mixer_exposure_2hop: 35,
  sanctions_3hop: 25, // two intermediaries — context that combines, never acts alone
  sanctions_2hop_inbound: 20,
  unverified_contract: 20,
  mixer_exposure_3hop: 20,
  upgradeable_proxy: 15,
  sanctions_3hop_inbound: 10,
}

/**
 * Labels that assert the subject IS the thing, rather than that it is near one.
 *
 * Only these can drive an automatic refusal. Derived signals sum toward the score normally, but
 * however high they stack they escalate to a human rather than blocking on their own: "1 hop from
 * a sanctioned address AND exposed to a mixer" is strong evidence, not a confirmed hit, and
 * refusing on it alone would freeze funds on an inference.
 */
export const DIRECT_HIT_LABELS: ReadonlySet<string> = new Set([
  'sanctions',
  'sanctioned_mixer',
  'scam_token',
  'operator_deny',
])

/** Lowest score selecting each action; evaluated highest-first. */
export const ACTION_THRESHOLDS: ReadonlyArray<readonly [number, RiskAction]> = [
  [90, 'block'],
  [60, 'manual-review'],
  [30, 'delay'],
  [0, 'allow'],
]

/** The most severe action each enforcement level permits its source to cause. */
const ENFORCEMENT_CEILING: Record<EnforcementLevel, RiskAction> = {
  block: 'block',
  manual_review_only: 'manual-review',
  // Contributes to the score and can hold a packet for re-screening, but never demands a
  // human decision or a refusal on its own.
  score_only: 'delay',
}

/** The most severe action a claim carrying only derived labels may cause. */
const DERIVED_ONLY_CEILING: RiskAction = 'manual-review'

/**
 * `delay` re-evaluation. The total wait (40 min) deliberately exceeds the default RiskStore
 * refresh interval (`DENYLIST_REFRESH_MS`, 30 min), so a deferred packet is always re-scored
 * against at least one fresh feed before it escalates.
 */
export const DELAY_POLICY = {
  retryAfterMs: 5 * 60_000,
  maxAttempts: 8,
  escalateTo: 'manual-review' as RiskAction,
}

/**
 * Graph traversal bounds. Depth is 3, computed by the external indexer (`graph/proximity.ts`)
 * and delivered via the signed feed — the DVN itself never walks the graph.
 *
 * Direction is what makes this dusting-resistant. Anyone can push a tainted transfer at a
 * victim, so INBOUND edges are weak evidence: every edge on an inbound path must clear the
 * indexer's per-token minimum. An OUTBOUND path starts with the subject's own act (no
 * threshold), but every edge after the first is someone else's — those must clear the minimum
 * too, or anyone the subject ever paid could smear them by dusting a sanctioned address.
 *
 * A path counts only if funds could have flowed along it: hops stay on one chain, in
 * non-decreasing block order, with no seed anywhere but the far endpoint. A token with no
 * configured minimum records its edges but never extends a path.
 */
export const N_HOP = {
  depth: 3,
  outbound: { minValueEth: 0, labels: ['sanctions_1hop', 'sanctions_2hop', 'sanctions_3hop'] },
  inbound: {
    minValueEth: 0.01,
    labels: ['sanctions_1hop_inbound', 'sanctions_2hop_inbound', 'sanctions_3hop_inbound'],
  },
}

/**
 * One source's claim about a subject: the labels it applied, and optionally its own score.
 *
 * Grouping by source matters. `assertedScore` describes the subject as a whole, so it is worth
 * counting once — not once per label, which would multiply it by however many labels happened to
 * accompany it.
 */
export interface PolicyEntry {
  source: LabelSource
  labels: string[]
  /** Source-asserted score for the subject; competes with the label sum rather than adding. */
  assertedScore?: number
}

export interface PolicyDecision {
  score: number
  action: RiskAction
  reasonCodes: string[]
}

/**
 * Score a subject's signals and choose an action.
 *
 * Two independent gates decide the outcome. The score, capped at 100, picks a candidate action
 * from `ACTION_THRESHOLDS`. That candidate is then clamped to a ceiling, so a pile of
 * `public_event` labels can total 100 and still only reach `delay`.
 *
 * The ceiling is computed **per claim** and the most permissive claim wins. Each claim is capped
 * by both how far its source is trusted AND whether it actually asserts a direct hit. Pairing
 * the two per claim is what closes the obvious hole: a `public_event` shouting "sanctions" next
 * to an `ofac` entry carrying only derived labels must not combine into a block, because neither
 * claim on its own is grounds for one.
 *
 * Each source contributes the greater of its label weights summed, or the score it asserted for
 * the subject; those per-source figures then add up. A source that says "82" alongside three
 * labels contributes 82 once, not 82 three times.
 *
 * Confidence deliberately does NOT scale the score. Weighting by it would silently shift
 * outcomes off the agreed threshold table — a `trusted_indexer` 1-hop label would land on
 * `delay` instead of the `manual-review` the policy calls for. Confidence is carried on the
 * evidence for observability and for the indexer's own use.
 */
export function evaluate(entries: readonly PolicyEntry[]): PolicyDecision {
  if (entries.length === 0) return { score: 0, action: 'allow', reasonCodes: [] }

  let score = 0
  let ceiling: RiskAction = 'allow'
  const reasonCodes: string[] = []

  for (const entry of entries) {
    let labelSum = 0
    let hasDirectHit = false
    for (const label of entry.labels) {
      labelSum += LABEL_WEIGHTS[label] ?? 0
      if (DIRECT_HIT_LABELS.has(label)) hasDirectHit = true
      if (!reasonCodes.includes(label)) reasonCodes.push(label)
    }
    score += Math.max(labelSum, entry.assertedScore ?? 0)

    // An asserted score cannot manufacture a direct hit: a source claiming 100 with only
    // derived labels still tops out at manual-review.
    const claimCeiling = clampAction(
      ENFORCEMENT_CEILING[SOURCE_TRUST[entry.source].enforcement],
      hasDirectHit ? 'block' : DERIVED_ONLY_CEILING,
    )
    ceiling = worseAction(ceiling, claimCeiling)
  }
  score = Math.min(100, score)

  const candidate = ACTION_THRESHOLDS.find(([min]) => score >= min)?.[1] ?? 'allow'
  return { score, action: clampAction(candidate, ceiling), reasonCodes }
}
