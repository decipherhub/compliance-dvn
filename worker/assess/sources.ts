/**
 * Label sources and how far each one is trusted to push an enforcement action.
 *
 * Not every signal deserves the same authority. A direct OFAC match may block a transfer
 * outright; a label scraped from a public event may only move the score. `SOURCE_TRUST` is
 * the single place that distinction lives — the policy engine reads it and caps each piece
 * of evidence accordingly, so a permissive source can never be escalated by accident.
 */

export type LabelSource =
  | 'ofac'
  | 'opensanctions'
  | 'operator'
  | 'trusted_indexer'
  | 'own_verdict_event'
  | 'public_event'

/** The most severe action a source's evidence is allowed to cause on its own. */
export type EnforcementLevel = 'block' | 'manual_review_only' | 'score_only'

export interface SourceTrust {
  enforcement: EnforcementLevel
  /** Default confidence for entries this source asserts, when it states none itself. */
  confidence: number
}

export const SOURCE_TRUST: Record<LabelSource, SourceTrust> = {
  // Authoritative sanctions lists: a direct hit is grounds to refuse outright.
  ofac: { enforcement: 'block', confidence: 1 },
  opensanctions: { enforcement: 'block', confidence: 1 },
  // Operator's own denylist — blocking is an explicit operational choice.
  operator: { enforcement: 'block', confidence: 1 },
  // Indexer feeds are only admitted after signature + allowlist verification, so they may
  // block; the lower confidence reflects derived (graph) rather than asserted labels.
  trusted_indexer: { enforcement: 'block', confidence: 0.8 },
  // Our own past verdicts: useful for propagation and audit, but self-reinforcing. Capped
  // so a stale verdict of ours can never harden into an automatic block.
  own_verdict_event: { enforcement: 'manual_review_only', confidence: 0.6 },
  // Anyone can emit an event. Contributes to the score, never drives an automatic refusal.
  public_event: { enforcement: 'score_only', confidence: 0.3 },
}

export function isLabelSource(s: string): s is LabelSource {
  return s in SOURCE_TRUST
}
