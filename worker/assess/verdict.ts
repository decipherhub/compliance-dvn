import { ethers } from 'ethers'
import { canonicalize } from './canonical'
import { POLICY_VERSION, type RiskAction } from './policy'
import type { Assessment } from './assess'

/**
 * On-chain encoding of a risk verdict.
 *
 * The contract stores nothing; it only emits. So these encodings ARE the audit trail, and an
 * indexer decoding a two-year-old log depends on them still meaning the same thing. Both the
 * action codes and the reason-bit assignments below are therefore permanent: append, never
 * renumber or reuse.
 */

/** Must match `ACTION_*` in ComplianceDVN.sol. */
export const ACTION_CODES: Record<RiskAction, number> = {
  allow: 0,
  delay: 1,
  'manual-review': 2,
  block: 3,
}

/**
 * Reason code -> bit position in the `reasonMask` uint256.
 *
 * APPEND-ONLY. Renumbering a bit silently rewrites the meaning of every event already emitted,
 * so a new reason takes the next free index and retired ones are left in place.
 */
export const REASON_BITS: Record<string, number> = {
  // Direct hits
  sanctions: 0,
  sanctioned_mixer: 1,
  scam_token: 2,
  operator_deny: 3,
  // Graph-derived
  sanctions_1hop: 4,
  sanctions_1hop_inbound: 5,
  mixer_exposure: 6,
  // Token
  fake_stablecoin_suspect: 7,
  honeypot_suspect: 8,
  // Contract
  contract_admin_risk: 9,
  unverified_contract: 10,
  upgradeable_proxy: 11,
  // Operational
  contract_check_unavailable: 12,
  token_check_unavailable: 13,
  /** Set when a held packet was released by an owner approval rather than by re-screening. */
  owner_approved: 14,
}

/** Reserved top bit, set when a reason code has no assigned bit — so nothing vanishes silently. */
export const UNMAPPED_REASON_BIT = 255

export interface OnChainVerdict {
  action: number
  score: number
  reasonMask: bigint
  evidenceHash: string
}

/**
 * Pack reason codes into a bitmask.
 *
 * A code with no assigned bit sets `UNMAPPED_REASON_BIT` instead of being dropped: an audit
 * record that quietly omits a reason is worse than one that says "there was a reason I cannot
 * name". Returns the unmapped codes so the caller can log them.
 */
export function reasonMask(codes: readonly string[]): { mask: bigint; unmapped: string[] } {
  let mask = 0n
  const unmapped: string[] = []
  for (const code of codes) {
    const bit = REASON_BITS[code]
    if (bit === undefined) {
      unmapped.push(code)
      mask |= 1n << BigInt(UNMAPPED_REASON_BIT)
    } else {
      mask |= 1n << BigInt(bit)
    }
  }
  return { mask, unmapped }
}

/** Decode a mask back to reason codes. Used by tests and available to the indexer. */
export function decodeReasonMask(mask: bigint): string[] {
  const byBit = new Map(Object.entries(REASON_BITS).map(([code, bit]) => [bit, code]))
  const out: string[] = []
  for (let bit = 0; bit <= UNMAPPED_REASON_BIT; bit++) {
    if ((mask >> BigInt(bit)) & 1n) out.push(byBit.get(bit) ?? `unmapped:${bit}`)
  }
  return out
}

/** One scored signal, as committed to by `evidenceHash`. */
export interface EvidenceRecord {
  type: string
  weight: number
  /** Confidence as an integer percent — the document must canonicalize, and floats cannot. */
  confidencePct: number
  source: string
  subject: string
}

/**
 * The off-chain document `evidenceHash` commits to.
 *
 * It covers the verdict and the scored evidence that produced it. Free-form `details` on the
 * internal evidence (a controller address, a decoded symbol) are deliberately excluded: they
 * hold arbitrary values, and a future provider adding a float there would break hashing at
 * runtime. Everything committed here is either derived from chain state the indexer can re-read
 * independently, or from the feed it published itself.
 */
export interface EvidenceDocument {
  policyVersion: number
  payloadHash: string
  action: RiskAction
  score: number
  reasonCodes: string[]
  parties: Array<{ subject: string; chainKey: string }>
  evidence: EvidenceRecord[]
}

export function buildEvidenceDocument(
  payloadHash: string,
  verdict: Assessment,
  parties: ReadonlyArray<{ subject: string; chainKey: string }>,
): EvidenceDocument {
  return {
    policyVersion: POLICY_VERSION,
    payloadHash: payloadHash.toLowerCase(),
    action: verdict.action,
    score: verdict.score,
    reasonCodes: [...verdict.reasonCodes],
    parties: parties.map((p) => ({ subject: p.subject.toLowerCase(), chainKey: p.chainKey })),
    evidence: verdict.evidence.map((e) => ({
      type: e.type,
      weight: e.weight,
      confidencePct: Math.round(e.confidence * 100),
      source: e.source,
      subject: e.subject,
    })),
  }
}

export function evidenceHash(doc: EvidenceDocument): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalize(doc)))
}

/**
 * Encode a verdict for the chain.
 *
 * `overrideAction` exists for the owner-approved release: the action taken was `allow` (a human
 * allowed it) even though re-screening still scores it `manual-review`, and the contract refuses
 * to accept a verification claiming anything but allow. The reason mask still carries why it had
 * been held, plus `owner_approved`.
 */
export function encodeVerdict(
  payloadHash: string,
  verdict: Assessment,
  parties: ReadonlyArray<{ subject: string; chainKey: string }>,
  opts: { overrideAction?: RiskAction; extraReasons?: string[] } = {},
): { encoded: OnChainVerdict; unmapped: string[] } {
  const action = opts.overrideAction ?? verdict.action
  const codes = [...verdict.reasonCodes, ...(opts.extraReasons ?? [])]
  const { mask, unmapped } = reasonMask(codes)
  const doc = buildEvidenceDocument(payloadHash, { ...verdict, action, reasonCodes: codes }, parties)
  return {
    encoded: {
      action: ACTION_CODES[action],
      // uint16 on-chain; the policy caps the score at 100 but clamp rather than overflow.
      score: Math.max(0, Math.min(65535, Math.round(verdict.score))),
      reasonMask: mask,
      evidenceHash: evidenceHash(doc),
    },
    unmapped,
  }
}
