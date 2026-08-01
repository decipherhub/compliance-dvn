import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  ingestFeed,
  parseFeed,
  canonicalize,
  signingPayload,
  verifyFeedSigner,
  FeedError,
  type FeedVersionStore,
} from '../assess/ingest/feed'
import { RiskStore } from '../assess/store'
import { makeAssessor } from '../assess/assess'
import { POLICY_VERSION } from '../assess/policy'

const SIGNER = new ethers.Wallet('0x' + '1'.repeat(64))
const OTHER = new ethers.Wallet('0x' + '2'.repeat(64))
const ADDR = '0x' + 'a'.repeat(40)
const NOW_MS = 1_800_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1000)

/** An in-memory version store, matching what the Checkpoint provides in production. */
function versionStore(initial: Record<string, number> = {}): FeedVersionStore {
  const map = { ...initial }
  return { get: (s) => map[s] ?? 0, set: (s, v) => void (map[s] = v) }
}

type FeedBody = Record<string, unknown>

function feedBody(overrides: FeedBody = {}): FeedBody {
  return {
    version: 1,
    generatedAt: NOW_SEC - 60,
    expiresAt: NOW_SEC + 3600,
    source: 'trusted-indexer-a',
    policyVersion: POLICY_VERSION,
    entries: [{ address: ADDR, labels: ['sanctions_1hop'], score: 82 }],
    ...overrides,
  }
}

/** Sign a body the way the indexer will, and return the deliverable document. */
async function signed(body: FeedBody = feedBody(), wallet = SIGNER): Promise<string> {
  const signature = await wallet.signMessage(signingPayload(body))
  return JSON.stringify({ ...body, signature })
}

function deps(overrides: Partial<Parameters<typeof ingestFeed>[2]> = {}) {
  return {
    now: () => NOW_MS,
    versions: versionStore(),
    ...overrides,
  } as Parameters<typeof ingestFeed>[2]
}

const cfg = { url: 'https://indexer.test/feed.json', signers: [SIGNER.address] }

describe('canonicalize', () => {
  it('sorts object keys so both sides agree on the bytes', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }))
  })

  it('preserves array order, which is semantic', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
  })

  it('sorts nested keys too', () => {
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}')
  })

  // Float formatting is not guaranteed to round-trip across languages, so it is refused
  // outright rather than risk a signature that verifies on one side only.
  it('rejects non-integer numbers', () => {
    expect(() => canonicalize({ confidence: 0.8 })).toThrow(/non-integer/)
    expect(() => canonicalize([1, 2.5])).toThrow(/non-integer/)
  })

  it('excludes the signature from what gets signed', () => {
    const body = feedBody()
    expect(signingPayload({ ...body, signature: '0xdead' })).toBe(canonicalize(body))
  })
})

describe('parseFeed', () => {
  it('rejects non-JSON and non-objects', () => {
    expect(() => parseFeed('not json')).toThrow(FeedError)
    expect(() => parseFeed('[]')).toThrow(/must be a JSON object/)
  })

  it('rejects a malformed signature', async () => {
    expect(() => parseFeed(JSON.stringify({ ...feedBody(), signature: '0x1234' }))).toThrow(/65-byte hex/)
  })

  it('rejects a bad address, empty labels, or an out-of-range score', async () => {
    const bad = (entries: unknown) => () => parseFeed(JSON.stringify({ ...feedBody({ entries }), signature: '0x' + '1'.repeat(130) }))
    expect(bad([{ address: '0xnope', labels: ['x'] }])).toThrow(/EVM address/)
    expect(bad([{ address: ADDR, labels: [] }])).toThrow(/non-empty array/)
    expect(bad([{ address: ADDR, labels: ['x'], score: 101 }])).toThrow(/<= 100/)
    expect(bad([{ address: ADDR, labels: ['x'], score: 1.5 }])).toThrow(/integer/)
  })

  it('keeps unknown fields so the signature still covers them', async () => {
    const body = feedBody({ someFutureField: 'kept' })
    const { raw } = parseFeed(await signed(body))
    expect(raw.someFutureField).toBe('kept')
  })

  it('lowercases a checksummed entry address', async () => {
    const checksummed = '0x' + 'A'.repeat(40) // mixed case is what EIP-55 produces
    const { feed } = parseFeed(await signed(feedBody({ entries: [{ address: checksummed, labels: ['x'] }] })))
    expect(feed.entries[0].address).toBe('0x' + 'a'.repeat(40))
  })
})

describe('verifyFeedSigner', () => {
  it('recovers the signer', async () => {
    const body = feedBody()
    const signature = await SIGNER.signMessage(signingPayload(body))
    expect(verifyFeedSigner(body, signature, [SIGNER.address])).toBe(SIGNER.address.toLowerCase())
  })

  it('rejects a correct signature from a key that is not allowlisted', async () => {
    const body = feedBody()
    const signature = await OTHER.signMessage(signingPayload(body))
    expect(() => verifyFeedSigner(body, signature, [SIGNER.address])).toThrow(/not in the signer allowlist/)
  })

  it('rejects a tampered body', async () => {
    const body = feedBody()
    const signature = await SIGNER.signMessage(signingPayload(body))
    const tampered = { ...body, entries: [{ address: ADDR, labels: ['sanctions'] }] }
    expect(() => verifyFeedSigner(tampered, signature, [SIGNER.address])).toThrow(/not in the signer allowlist/)
  })
})

describe('ingestFeed', () => {
  it('applies a valid feed as trusted_indexer entries with the feed TTL', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody()
    const n = await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))
    expect(n).toBe(1)
    const entry = store.lookup(ADDR)[0]
    expect(entry.source).toBe('trusted_indexer')
    expect(entry.labels).toEqual(['sanctions_1hop'])
    expect(entry.score).toBe(82)
    expect(entry.confidence).toBe(0.8) // from SOURCE_TRUST, not asserted by the feed
    expect(entry.expiresAt).toBe((body.expiresAt as number) * 1000)
  })

  it('feeds straight into a manual-review verdict', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed() }))
    const r = await makeAssessor(store)(ADDR)
    expect(r.score).toBe(82) // asserted score beats the label weight of 70
    expect(r.action).toBe('manual-review')
  })

  // An asserted score describes the subject, so it counts once per claim. Applying it per label
  // multiplied it by the label count and turned a review into a block.
  it('counts an asserted score once, not once per label', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({
      entries: [{ address: ADDR, labels: ['unverified_contract', 'upgradeable_proxy'], score: 82 }],
    })
    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))
    const r = await makeAssessor(store)(ADDR)
    // max(20 + 15, 82) = 82, NOT 82 + 82.
    expect(r.score).toBe(82)
    expect(r.action).toBe('manual-review')
  })

  it('lets the label sum win when it exceeds the asserted score', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ entries: [{ address: ADDR, labels: ['sanctions_1hop'], score: 10 }] })
    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))
    // A source cannot talk its own labels down: max(70, 10) = 70.
    expect((await makeAssessor(store)(ADDR)).score).toBe(70)
  })

  // A feed may carry its own `action`; honouring it would move enforcement authority to the
  // indexer, which is exactly what SOURCE_TRUST exists to prevent.
  it('ignores a feed-supplied action', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ entries: [{ address: ADDR, labels: ['unverified_contract'], action: 'block' }] })
    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))
    const r = await makeAssessor(store)(ADDR)
    expect(r.score).toBe(20)
    expect(r.action).toBe('allow') // our policy decides, not the feed
  })

  it('rejects an unsigned or wrongly signed feed', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    await expect(
      ingestFeed(store, cfg, deps({ fetcher: async () => await signed(feedBody(), OTHER) })),
    ).rejects.toThrow(/untrusted_signer/)
    expect(store.size).toBe(0)
  })

  it('rejects a policyVersion mismatch', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ policyVersion: POLICY_VERSION + 1 })
    await expect(ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))).rejects.toThrow(
      /policy_mismatch/,
    )
    expect(store.size).toBe(0)
  })

  it('rejects a rollback to an older version', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const versions = versionStore({ 'trusted-indexer-a': 5 })
    await expect(
      ingestFeed(store, cfg, deps({ fetcher: async () => await signed(feedBody({ version: 4 })), versions })),
    ).rejects.toThrow(/replayed/)
    expect(store.size).toBe(0)
    expect(versions.get('trusted-indexer-a')).toBe(5)

    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(feedBody({ version: 6 })), versions }))
    expect(versions.get('trusted-indexer-a')).toBe(6)
  })

  // A fresh store on a rebuild or a restart holds the version but not the labels, so refusing the
  // current version would leave it with no feed-derived labels at all until the indexer published.
  it('re-applies the version already accepted, so a fresh store recovers its labels', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const versions = versionStore({ 'trusted-indexer-a': 5 })
    const applied = await ingestFeed(
      store,
      cfg,
      deps({ fetcher: async () => await signed(feedBody({ version: 5 })), versions }),
    )
    expect(applied).toBeGreaterThan(0)
    expect(store.size).toBeGreaterThan(0)
    expect(versions.get('trusted-indexer-a')).toBe(5)
  })

  it('tracks versions per source, so two indexers do not block each other', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const versions = versionStore({ 'indexer-a': 9 })
    await ingestFeed(
      store,
      cfg,
      deps({ fetcher: async () => await signed(feedBody({ source: 'indexer-b', version: 1 })), versions }),
    )
    expect(versions.get('indexer-b')).toBe(1)
    expect(versions.get('indexer-a')).toBe(9)
  })

  it('rejects an already-expired feed', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ expiresAt: NOW_SEC - 1 })
    await expect(ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body) }))).rejects.toThrow(/expired/)
  })

  it('rejects a future-dated feed beyond the skew allowance', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ generatedAt: NOW_SEC + 3000 })
    await expect(
      ingestFeed(store, { ...cfg, maxSkewSec: 300 }, deps({ fetcher: async () => await signed(body) })),
    ).rejects.toThrow(/future_dated/)
  })

  it('tolerates clock skew inside the allowance', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const body = feedBody({ generatedAt: NOW_SEC + 100 })
    await expect(
      ingestFeed(store, { ...cfg, maxSkewSec: 300 }, deps({ fetcher: async () => await signed(body) })),
    ).resolves.toBe(1)
  })

  it('reports a fetch failure as fetch_failed', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    await expect(
      ingestFeed(store, cfg, deps({ fetcher: async () => { throw new Error('502 bad gateway') } })),
    ).rejects.toThrow(/fetch_failed/)
  })

  it('does not bump the accepted version when the feed is rejected', async () => {
    const store = new RiskStore({ now: () => NOW_MS })
    const versions = versionStore()
    const set = vi.spyOn(versions, 'set')
    await expect(
      ingestFeed(store, cfg, deps({ fetcher: async () => await signed(feedBody(), OTHER), versions })),
    ).rejects.toThrow()
    expect(set).not.toHaveBeenCalled()
  })

  it('lets feed labels expire on their own once the feed goes stale', async () => {
    let t = NOW_MS
    const store = new RiskStore({ now: () => t })
    const body = feedBody({ expiresAt: NOW_SEC + 60 })
    await ingestFeed(store, cfg, deps({ fetcher: async () => await signed(body), now: () => t }))
    expect((await makeAssessor(store)(ADDR)).action).toBe('manual-review')
    t = NOW_MS + 61_000
    expect((await makeAssessor(store)(ADDR)).action).toBe('allow')
  })
})
