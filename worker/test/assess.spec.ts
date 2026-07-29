import { describe, it, expect, vi } from 'vitest'
import { makeAssessor, combine, CONTRACT_CHECK_UNAVAILABLE, TOKEN_CHECK_UNAVAILABLE } from '../assess/assess'
import { RiskStore } from '../assess/store'
import type { ContractFacts, ContractInspector } from '../assess/providers/contract'
import type { TokenFacts, TokenInspector, TokenResolution } from '../assess/providers/token'

const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const ADMIN = '0x00000000000000000000000000000000000000cc'
const TOKEN = '0x00000000000000000000000000000000000000dd'
const REAL_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' // canonical on baseSepolia

/** An inspector returning fixed facts, or throwing to simulate an unreachable RPC. */
function inspector(facts: ContractFacts | Error): ContractInspector {
  return {
    inspect: async () => {
      if (facts instanceof Error) throw facts
      return facts
    },
  }
}

/** A token inspector with a fixed resolution and fixed metadata. */
function tokenInspector(resolution: TokenResolution, facts?: TokenFacts | Error): TokenInspector {
  return {
    resolveToken: async () => resolution,
    inspect: async () => {
      if (facts instanceof Error) throw facts
      return facts ?? { address: TOKEN }
    },
  }
}

const EOA: ContractFacts = { isContract: false, proxy: false }
const CONTRACT: ContractFacts = { isContract: true, proxy: false }

describe('assess', () => {
  it('BLOCKS a direct sanctions hit', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac' })
    const r = await makeAssessor(store)(A.toUpperCase())
    expect(r.action).toBe('block')
    expect(r.score).toBe(100)
    expect(r.reasonCodes).toContain('sanctions')
    expect(r.evidence[0]).toMatchObject({ type: 'sanctions', source: 'ofac', weight: 100 })
  })

  it('ALLOWS a clean address with no evidence', async () => {
    const r = await makeAssessor(new RiskStore())(B)
    expect(r.action).toBe('allow')
    expect(r.score).toBe(0)
    expect(r.evidence).toEqual([])
  })

  it('sends a 1-hop label to manual-review, not block', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions_1hop'], source: 'trusted_indexer' })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(70)
    expect(r.action).toBe('manual-review')
  })

  it('delays a weak contract signal', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, subjectType: 'contract', labels: ['contract_admin_risk'], source: 'trusted_indexer' })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(50)
    expect(r.action).toBe('delay')
  })

  it('caps a public_event source at delay even when its score reaches 100', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'public_event' })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(100) // score is unclamped...
    expect(r.action).toBe('delay') // ...but an untrusted source cannot cause a refusal
  })

  it('caps own_verdict_event at manual-review (no self-reinforcing block)', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'own_verdict_event' })
    expect((await makeAssessor(store)(A)).action).toBe('manual-review')
  })

  it('lets a trusted source in the same evidence set restore the block ceiling', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'public_event' })
    store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac' })
    expect((await makeAssessor(store)(A)).action).toBe('block')
  })

  it('sums labels toward a higher action', async () => {
    const store = new RiskStore()
    // 20 + 15 = 35 -> delay; neither label alone reaches the delay threshold.
    store.upsert({ subject: A, labels: ['unverified_contract', 'upgradeable_proxy'], source: 'trusted_indexer' })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(35)
    expect(r.action).toBe('delay')
  })

  it('keeps two separate source claims adding up', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['unverified_contract'], source: 'trusted_indexer' }) // 20
    store.upsert({ subject: A, labels: ['upgradeable_proxy'], source: 'operator' }) // 15
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(35) // separate claims still add up
    expect(r.action).toBe('delay')
  })

  it('does not let one source talk its own labels down with a low asserted score', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac', score: 5 })
    expect((await makeAssessor(store)(A)).score).toBe(100) // max(100, 5)
  })

  it('ignores an expired entry rather than scoring it', async () => {
    let t = 1000
    const store = new RiskStore({ now: () => t })
    store.upsert({ subject: A, labels: ['sanctions'], source: 'trusted_indexer', expiresAt: 2000 })
    expect((await makeAssessor(store)(A)).action).toBe('block')
    t = 2001
    expect((await makeAssessor(store)(A)).action).toBe('allow')
  })
})

/**
 * Only a direct hit justifies an automatic refusal. Derived signals sum toward the score as
 * normal, but however high they stack they escalate to a human instead of blocking.
 */
describe('block requires a direct hit', () => {
  it('sends stacked derived labels to manual-review, not block', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions_1hop', 'mixer_exposure'], source: 'trusted_indexer' })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(100) // the risk total is reported honestly...
    expect(r.action).toBe('manual-review') // ...but an inference does not auto-refuse
  })

  it('still blocks a direct sanctions hit', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac' })
    expect((await makeAssessor(store)(A)).action).toBe('block')
  })

  it('blocks when a direct hit accompanies derived labels', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions_1hop', 'sanctioned_mixer'], source: 'trusted_indexer' })
    expect((await makeAssessor(store)(A)).action).toBe('block')
  })

  it('blocks a confirmed scam token', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, subjectType: 'token', labels: ['scam_token'], source: 'operator' })
    expect((await makeAssessor(store)(A)).action).toBe('block')
  })

  // The hole that makes the check per-claim rather than global: neither claim alone is grounds
  // for a refusal, so combining them must not produce one.
  it('does not combine an untrusted direct hit with a trusted derived label into a block', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'public_event' }) // direct but untrusted
    store.upsert({ subject: A, labels: ['sanctions_1hop'], source: 'ofac' }) // trusted but derived
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(100)
    expect(r.action).toBe('manual-review')
  })

  it('an asserted score cannot manufacture a direct hit', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['unverified_contract'], source: 'trusted_indexer', score: 100 })
    const r = await makeAssessor(store)(A)
    expect(r.score).toBe(100)
    expect(r.action).toBe('manual-review')
  })

  it('leaves the delay and allow bands untouched', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['contract_admin_risk'], source: 'trusted_indexer' })
    expect((await makeAssessor(store)(A)).action).toBe('delay') // 50
    const clean = new RiskStore()
    clean.upsert({ subject: A, labels: ['upgradeable_proxy'], source: 'trusted_indexer' })
    expect((await makeAssessor(clean)(A)).action).toBe('allow') // 15
  })

  it('keeps the source ceiling as the tighter of the two caps', async () => {
    const store = new RiskStore()
    // Direct hit, but from a source that may never refuse on its own.
    store.upsert({ subject: A, labels: ['sanctions'], source: 'public_event' })
    expect((await makeAssessor(store)(A)).action).toBe('delay')
  })

  it('ignores an expired entry rather than scoring it (regression guard)', async () => {
    let t = 1000
    const store = new RiskStore({ now: () => t })
    store.upsert({ subject: A, labels: ['sanctions'], source: 'trusted_indexer', expiresAt: 2000 })
    expect((await makeAssessor(store)(A)).action).toBe('block')
    t = 2001
    expect((await makeAssessor(store)(A)).action).toBe('allow')
  })
})

describe('assess with contract checks', () => {
  it('skips live checks entirely when no chainKey is given', async () => {
    const inspect = vi.fn()
    const assess = makeAssessor(new RiskStore(), {
      contracts: { inspect },
      tokens: tokenInspector({ kind: 'token', address: TOKEN }),
    })
    const r = await assess(A) // no chainKey
    expect(inspect).not.toHaveBeenCalled()
    expect(r.action).toBe('allow')
    expect(r.reasonCodes).toEqual([])
  })

  it('adds no evidence for an EOA', async () => {
    const assess = makeAssessor(new RiskStore(), { contracts: inspector(EOA) })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('allow')
    expect(r.evidence).toEqual([])
  })

  it('labels an upgradeable proxy and records the implementation', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector({ isContract: true, proxy: true, implementation: B }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.reasonCodes).toEqual(['upgradeable_proxy'])
    expect(r.score).toBe(15)
    expect(r.action).toBe('allow') // 15 alone is below the delay threshold
    expect(r.evidence[0].details).toMatchObject({ implementation: B })
  })

  it('flags admin risk when the controller itself carries labels', async () => {
    const store = new RiskStore()
    store.upsert({ subject: ADMIN, labels: ['sanctions'], source: 'ofac' })
    const assess = makeAssessor(store, {
      contracts: inspector({ isContract: true, proxy: true, controller: ADMIN }),
    })
    const r = await assess(A, 'baseSepolia')
    // upgradeable_proxy (15) + contract_admin_risk (50) = 65 -> manual-review
    expect(r.reasonCodes.sort()).toEqual(['contract_admin_risk', 'upgradeable_proxy'])
    expect(r.score).toBe(65)
    expect(r.action).toBe('manual-review')
    const admin = r.evidence.find((e) => e.type === 'contract_admin_risk')!
    expect(admin.details).toMatchObject({ controller: ADMIN, controllerLabels: ['sanctions'] })
  })

  it('does not flag admin risk for a clean controller', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector({ isContract: true, proxy: false, controller: ADMIN }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.reasonCodes).toEqual([])
    expect(r.action).toBe('allow')
  })

  it('FAILS CLOSED to delay when the contract check is unavailable', async () => {
    const assess = makeAssessor(new RiskStore(), { contracts: inspector(new Error('rpc timeout')) })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('delay')
    expect(r.reasonCodes).toContain(CONTRACT_CHECK_UNAVAILABLE)
    expect(r.evidence[r.evidence.length - 1]).toMatchObject({ type: CONTRACT_CHECK_UNAVAILABLE, weight: 0 })
  })

  it('keeps a block verdict when the contract check is unavailable (never downgrades)', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac' })
    const assess = makeAssessor(store, { contracts: inspector(new Error('rpc timeout')) })
    expect((await assess(A, 'baseSepolia')).action).toBe('block')
  })

  it('does not let an unavailable check inflate a score into a block', async () => {
    const store = new RiskStore()
    store.upsert({ subject: A, labels: ['sanctions_1hop'], source: 'trusted_indexer' })
    const assess = makeAssessor(store, { contracts: inspector(new Error('rpc timeout')) })
    const r = await assess(A, 'baseSepolia')
    expect(r.score).toBe(70) // unchanged — the failure contributes no weight
    expect(r.action).toBe('manual-review')
  })
})

describe('assess with token checks', () => {
  it('does nothing for an OApp that is not an OFT', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'not-a-token' }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('allow')
    expect(r.evidence).toEqual([])
  })

  it('skips token resolution for a known EOA', async () => {
    const resolveToken = vi.fn()
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(EOA),
      tokens: { resolveToken, inspect: async () => ({ address: TOKEN }) },
    })
    await assess(A, 'baseSepolia')
    expect(resolveToken).not.toHaveBeenCalled()
  })

  it('BLOCKS an OFT moving a curated scam token, naming the token as the subject', async () => {
    const store = new RiskStore()
    store.upsert({ subject: TOKEN, subjectType: 'token', labels: ['scam_token'], source: 'operator' })
    const assess = makeAssessor(store, {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'token', address: TOKEN }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('block')
    expect(r.score).toBe(100)
    // The verdict is about the OApp, but the evidence points at the token itself.
    expect(r.subject).toBe(A)
    expect(r.evidence[0]).toMatchObject({ type: 'scam_token', subject: TOKEN })
  })

  it('flags a stablecoin impersonator', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'token', address: TOKEN }, { address: TOKEN, symbol: 'USDC', decimals: 6 }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.reasonCodes).toEqual(['fake_stablecoin_suspect'])
    expect(r.score).toBe(65)
    expect(r.action).toBe('manual-review')
    expect(r.evidence[0]).toMatchObject({ subject: TOKEN, details: { symbol: 'USDC' } })
  })

  it('does NOT flag the canonical stablecoin', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector(
        { kind: 'token', address: REAL_USDC },
        { address: REAL_USDC, symbol: 'USDC', decimals: 6 },
      ),
    })
    expect((await assess(A, 'baseSepolia')).action).toBe('allow')
  })

  it('does not judge a watched symbol on a chain with no canonical address', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'token', address: TOKEN }, { address: TOKEN, symbol: 'USDC', decimals: 6 }),
    })
    expect((await assess(A, 'someUnlistedChain')).action).toBe('allow')
  })

  it('FAILS CLOSED when token resolution is unknown (transport failure, not a revert)', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'unknown', reason: 'rpc timeout' }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('delay')
    expect(r.reasonCodes).toContain(TOKEN_CHECK_UNAVAILABLE)
  })

  it('FAILS CLOSED when token metadata cannot be read', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'token', address: TOKEN }, new Error('rpc down')),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.action).toBe('delay')
    expect(r.reasonCodes).toContain(TOKEN_CHECK_UNAVAILABLE)
  })

  it('still blocks a curated scam token when metadata is unreadable', async () => {
    const store = new RiskStore()
    store.upsert({ subject: TOKEN, subjectType: 'token', labels: ['scam_token'], source: 'operator' })
    const assess = makeAssessor(store, {
      contracts: inspector(CONTRACT),
      tokens: tokenInspector({ kind: 'token', address: TOKEN }, new Error('rpc down')),
    })
    // The store label needs no RPC, so the refusal survives the failed metadata read.
    expect((await assess(A, 'baseSepolia')).action).toBe('block')
  })

  it('reports both failures when contract and token checks are down', async () => {
    const assess = makeAssessor(new RiskStore(), {
      contracts: inspector(new Error('rpc timeout')),
      tokens: tokenInspector({ kind: 'unknown', reason: 'rpc timeout' }),
    })
    const r = await assess(A, 'baseSepolia')
    expect(r.reasonCodes.sort()).toEqual([CONTRACT_CHECK_UNAVAILABLE, TOKEN_CHECK_UNAVAILABLE].sort())
    expect(r.action).toBe('delay')
    expect(r.score).toBe(0)
  })
})

describe('combine', () => {
  const store = new RiskStore()
  store.upsert({ subject: A, labels: ['sanctions'], source: 'ofac' })
  store.upsert({ subject: B, labels: ['sanctions_1hop'], source: 'trusted_indexer' })
  const assess = makeAssessor(store)

  it('takes the worst action across parties', async () => {
    const [clean, b, a] = await Promise.all([assess('0x' + '9'.repeat(40)), assess(B), assess(A)])
    expect(combine([clean, clean]).action).toBe('allow')
    expect(combine([clean, b]).action).toBe('manual-review')
    expect(combine([clean, b, a]).action).toBe('block')
  })

  it('maxes scores instead of summing them, so two review parties are not a block', async () => {
    const b = await assess(B)
    const both = combine([b, b])
    expect(both.score).toBe(70)
    expect(both.action).toBe('manual-review')
  })

  it('unions reason codes and keeps every piece of evidence', async () => {
    const c = combine(await Promise.all([assess(A), assess(B)]))
    expect(c.reasonCodes.sort()).toEqual(['sanctions', 'sanctions_1hop'])
    expect(c.evidence.length).toBe(2)
  })

  it('allows an empty party list', () => {
    expect(combine([]).action).toBe('allow')
    expect(combine([]).score).toBe(0)
  })
})
