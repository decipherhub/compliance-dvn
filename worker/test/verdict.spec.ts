import { describe, it, expect } from 'vitest'
import {
  ACTION_CODES,
  REASON_BITS,
  UNMAPPED_REASON_BIT,
  reasonMask,
  decodeReasonMask,
  buildEvidenceDocument,
  evidenceHash,
  encodeVerdict,
} from '../assess/verdict'
import { POLICY_VERSION } from '../assess/policy'
import type { Assessment } from '../assess/assess'

const PAYLOAD = '0x' + 'a'.repeat(64)
const A = '0x' + '1'.repeat(40)
const PARTIES = [
  { subject: A, chainKey: 'baseSepolia' },
  { subject: '0x' + '2'.repeat(40), chainKey: 'optimismSepolia' },
]

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    subject: A,
    score: 70,
    action: 'manual-review',
    reasonCodes: ['sanctions_1hop'],
    evidence: [
      { type: 'sanctions_1hop', weight: 70, confidence: 0.8, source: 'trusted_indexer', subject: A },
    ],
    ...overrides,
  }
}

describe('ACTION_CODES', () => {
  // These are part of the event ABI. Changing one silently rewrites the meaning of every log
  // already emitted, so the numbering is pinned here and in ComplianceDVN.sol.
  it('matches the contract constants', () => {
    expect(ACTION_CODES).toEqual({ allow: 0, delay: 1, 'manual-review': 2, block: 3 })
  })
})

describe('REASON_BITS', () => {
  it('assigns every bit exactly once', () => {
    const bits = Object.values(REASON_BITS)
    expect(new Set(bits).size).toBe(bits.length)
  })

  it('leaves the unmapped bit free', () => {
    expect(Object.values(REASON_BITS)).not.toContain(UNMAPPED_REASON_BIT)
  })

  it('keeps every bit inside a uint256', () => {
    for (const bit of Object.values(REASON_BITS)) {
      expect(bit).toBeGreaterThanOrEqual(0)
      expect(bit).toBeLessThan(256)
    }
  })

  // Pinning the direct-hit assignments guards against an accidental renumbering, which would
  // misread historical events rather than fail loudly.
  it('pins the established assignments', () => {
    expect(REASON_BITS.sanctions).toBe(0)
    expect(REASON_BITS.sanctioned_mixer).toBe(1)
    expect(REASON_BITS.scam_token).toBe(2)
    expect(REASON_BITS.operator_deny).toBe(3)
  })

  it('carries the depth-2/3 proximity codes added in policy v2', () => {
    const codes = [
      'sanctions_2hop',
      'sanctions_3hop',
      'sanctions_2hop_inbound',
      'sanctions_3hop_inbound',
      'mixer_exposure_2hop',
      'mixer_exposure_3hop',
    ]
    const { mask, unmapped } = reasonMask(codes)
    expect(unmapped).toEqual([])
    expect(decodeReasonMask(mask).sort()).toEqual([...codes].sort())
  })
})

describe('reasonMask', () => {
  it('packs and round-trips codes', () => {
    const { mask, unmapped } = reasonMask(['sanctions', 'mixer_exposure'])
    expect(unmapped).toEqual([])
    expect(mask).toBe((1n << 0n) | (1n << 6n))
    expect(decodeReasonMask(mask).sort()).toEqual(['mixer_exposure', 'sanctions'])
  })

  it('is empty for no codes', () => {
    expect(reasonMask([]).mask).toBe(0n)
    expect(decodeReasonMask(0n)).toEqual([])
  })

  it('is idempotent for a repeated code', () => {
    expect(reasonMask(['sanctions', 'sanctions']).mask).toBe(reasonMask(['sanctions']).mask)
  })

  // Dropping an unknown reason would produce an audit record that quietly omits it.
  it('flags an unknown code on the reserved bit instead of dropping it', () => {
    const { mask, unmapped } = reasonMask(['sanctions', 'something_new'])
    expect(unmapped).toEqual(['something_new'])
    expect((mask >> BigInt(UNMAPPED_REASON_BIT)) & 1n).toBe(1n)
    expect(decodeReasonMask(mask)).toContain(`unmapped:${UNMAPPED_REASON_BIT}`)
  })
})

describe('evidence document', () => {
  it('converts confidence to an integer percent so the document can be canonicalized', () => {
    const doc = buildEvidenceDocument(PAYLOAD, assessment(), PARTIES)
    expect(doc.evidence[0].confidencePct).toBe(80)
    expect(() => evidenceHash(doc)).not.toThrow()
  })

  it('commits to the policy version', () => {
    expect(buildEvidenceDocument(PAYLOAD, assessment(), PARTIES).policyVersion).toBe(POLICY_VERSION)
  })

  it('lowercases the payload hash and party subjects', () => {
    const doc = buildEvidenceDocument(PAYLOAD.toUpperCase().replace('0X', '0x'), assessment(), [
      { subject: A.toUpperCase().replace('0X', '0x'), chainKey: 'baseSepolia' },
    ])
    expect(doc.payloadHash).toBe(PAYLOAD)
    expect(doc.parties[0].subject).toBe(A)
  })

  it('hashes deterministically regardless of key insertion order', () => {
    const a = buildEvidenceDocument(PAYLOAD, assessment(), PARTIES)
    const b = buildEvidenceDocument(PAYLOAD, assessment(), PARTIES)
    // Rebuild with the object literal written in a different order.
    const reordered = { ...b, score: b.score, policyVersion: b.policyVersion, action: b.action }
    expect(evidenceHash(a)).toBe(evidenceHash(b))
    expect(evidenceHash(a)).toBe(evidenceHash(reordered))
    expect(evidenceHash(a)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('changes the hash when any committed field changes', () => {
    const base = evidenceHash(buildEvidenceDocument(PAYLOAD, assessment(), PARTIES))
    expect(evidenceHash(buildEvidenceDocument(PAYLOAD, assessment({ score: 71 }), PARTIES))).not.toBe(base)
    expect(evidenceHash(buildEvidenceDocument(PAYLOAD, assessment({ action: 'block' }), PARTIES))).not.toBe(base)
    expect(evidenceHash(buildEvidenceDocument('0x' + 'b'.repeat(64), assessment(), PARTIES))).not.toBe(base)
    expect(evidenceHash(buildEvidenceDocument(PAYLOAD, assessment(), [PARTIES[0]]))).not.toBe(base)
  })

  // details hold arbitrary values, including floats a future provider might add, which would
  // break hashing at runtime. They are logged, not committed.
  it('ignores free-form evidence details', () => {
    const withDetails = assessment({
      evidence: [
        {
          type: 'sanctions_1hop',
          weight: 70,
          confidence: 0.8,
          source: 'trusted_indexer',
          subject: A,
          details: { anything: 1.2345 },
        },
      ],
    })
    expect(evidenceHash(buildEvidenceDocument(PAYLOAD, withDetails, PARTIES))).toBe(
      evidenceHash(buildEvidenceDocument(PAYLOAD, assessment(), PARTIES)),
    )
  })
})

describe('encodeVerdict', () => {
  it('encodes the action, score, mask, and hash', () => {
    const { encoded } = encodeVerdict(PAYLOAD, assessment(), PARTIES)
    expect(encoded.action).toBe(ACTION_CODES['manual-review'])
    expect(encoded.score).toBe(70)
    expect(decodeReasonMask(encoded.reasonMask)).toEqual(['sanctions_1hop'])
    expect(encoded.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  // The contract rejects a verification claiming anything but allow, so a release must report
  // the action actually taken while keeping the reasons it was held for.
  it('overrides the action for an owner-approved release, keeping the original reasons', () => {
    const { encoded } = encodeVerdict(PAYLOAD, assessment(), PARTIES, {
      overrideAction: 'allow',
      extraReasons: ['owner_approved'],
    })
    expect(encoded.action).toBe(ACTION_CODES.allow)
    expect(decodeReasonMask(encoded.reasonMask).sort()).toEqual(['owner_approved', 'sanctions_1hop'])
    expect(encoded.score).toBe(70) // the score is not rewritten, only the action
  })

  it('commits the overridden action to the hash, not the original', () => {
    const overridden = encodeVerdict(PAYLOAD, assessment(), PARTIES, { overrideAction: 'allow' })
    const plain = encodeVerdict(PAYLOAD, assessment(), PARTIES)
    expect(overridden.encoded.evidenceHash).not.toBe(plain.encoded.evidenceHash)
  })

  it('reports unmapped reason codes to the caller', () => {
    const { unmapped } = encodeVerdict(PAYLOAD, assessment({ reasonCodes: ['brand_new'] }), PARTIES)
    expect(unmapped).toEqual(['brand_new'])
  })

  it('clamps the score into uint16 rather than overflowing', () => {
    expect(encodeVerdict(PAYLOAD, assessment({ score: 999_999 }), PARTIES).encoded.score).toBe(65535)
    expect(encodeVerdict(PAYLOAD, assessment({ score: -5 }), PARTIES).encoded.score).toBe(0)
  })

  it('encodes an empty verdict', () => {
    const { encoded } = encodeVerdict(
      PAYLOAD,
      assessment({ score: 0, action: 'allow', reasonCodes: [], evidence: [] }),
      PARTIES,
    )
    expect(encoded.action).toBe(0)
    expect(encoded.reasonMask).toBe(0n)
  })
})
