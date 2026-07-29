import { describe, it, expect, beforeEach } from 'vitest'
import { ethers } from 'ethers'
import { canonicalize } from '../src/feed/canonical'
import { buildAndPublish, latestFeed, nextVersion, signFeed, type FeedDocument } from '../src/feed/builder'
import { applySchema, memDb, seedFixture } from './helpers/memdb'

const KEY = '0x' + '7'.repeat(64)
const SIGNER = new ethers.Wallet(KEY)
const SANCTIONED = '0x' + 'a'.repeat(40)
const SUBJECT = '0x' + '1'.repeat(40)
const TOKEN = '0x' + 'd'.repeat(40)
const NOW_MS = 1_800_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1000)

let db: ReturnType<typeof memDb>

beforeEach(() => {
  db = memDb()
  applySchema(db)
})

const opts = {
  source: 'trusted-indexer-a',
  policyVersion: 1,
  ttlSec: 7200,
  signingKey: KEY,
  now: () => NOW_MS,
}

describe('canonicalize', () => {
  /**
   * This fixture is the contract with the worker. `worker/test/feed.spec.ts` exercises the same
   * rules against the same shape; if either side's implementation drifts, one of the two fails.
   */
  it('produces the agreed byte sequence for a representative document', () => {
    const doc = {
      version: 128,
      generatedAt: 1782090000,
      expiresAt: 1782093600,
      source: 'trusted-indexer-a',
      policyVersion: 1,
      entries: [{ address: '0xabc', labels: ['sanctions_1hop', 'mixer_exposure'] }],
    }
    expect(canonicalize(doc)).toBe(
      '{"entries":[{"address":"0xabc","labels":["sanctions_1hop","mixer_exposure"]}],' +
        '"expiresAt":1782093600,"generatedAt":1782090000,"policyVersion":1,' +
        '"source":"trusted-indexer-a","version":128}',
    )
  })

  it('sorts keys and preserves array order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
  })

  it('rejects non-integer numbers, which cannot round-trip across languages', () => {
    expect(() => canonicalize({ confidence: 0.8 })).toThrow(/non-integer/)
  })
})

describe('signFeed', () => {
  it('signs the canonical form excluding the signature field', async () => {
    const doc: FeedDocument = {
      version: 1,
      generatedAt: NOW_SEC,
      expiresAt: NOW_SEC + 3600,
      source: 'trusted-indexer-a',
      policyVersion: 1,
      entries: [{ address: SUBJECT, labels: ['sanctions_1hop'] }],
    }
    const signed = await signFeed(doc, KEY)
    const { signature, ...rest } = signed
    expect(ethers.utils.verifyMessage(canonicalize(rest), signature)).toBe(SIGNER.address)
  })

  it('produces a signature that fails once the document is altered', async () => {
    const doc: FeedDocument = {
      version: 1,
      generatedAt: NOW_SEC,
      expiresAt: NOW_SEC + 3600,
      source: 'trusted-indexer-a',
      policyVersion: 1,
      entries: [{ address: SUBJECT, labels: ['sanctions_1hop'] }],
    }
    const { signature } = await signFeed(doc, KEY)
    const tampered = { ...doc, entries: [{ address: SUBJECT, labels: ['sanctions'] }] }
    expect(ethers.utils.verifyMessage(canonicalize(tampered), signature)).not.toBe(SIGNER.address)
  })
})

describe('buildAndPublish', () => {
  it('publishes the one-hop labels as feed entries', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    const feed = await buildAndPublish(db, opts)
    expect(feed.version).toBe(1)
    expect(feed.generatedAt).toBe(NOW_SEC)
    expect(feed.expiresAt).toBe(NOW_SEC + 7200)
    expect(feed.policyVersion).toBe(1)
    expect(feed.entries).toEqual([{ address: SUBJECT, labels: ['sanctions_1hop'] }])
  })

  // Sanctions and mixer lists are NOT republished: the worker reads them first-hand, and
  // re-feeding one as a trusted_indexer claim would launder an authoritative source into a
  // derived one — which also lowers its enforcement authority.
  it('does not republish the seed labels themselves', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    const feed = await buildAndPublish(db, opts)
    expect(feed.entries.map((e) => e.address)).not.toContain(SANCTIONED)
    expect(feed.entries.flatMap((e) => e.labels)).not.toContain('sanctions')
  })

  // action / confidence / score are all the worker's to decide. Asserting them here would move
  // enforcement authority to the indexer.
  it('emits no action, confidence, or score', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    const feed = await buildAndPublish(db, opts)
    const entry = feed.entries[0] as unknown as Record<string, unknown>
    expect(Object.keys(entry).sort()).toEqual(['address', 'labels'])
  })

  it('increments the version on every publish', async () => {
    expect(await nextVersion(db)).toBe(1)
    await buildAndPublish(db, opts)
    expect(await nextVersion(db)).toBe(2)
    const second = await buildAndPublish(db, opts)
    expect(second.version).toBe(2)
  })

  // The worker refuses a version it has already accepted, so a repeat after a restart would be
  // rejected rather than applied. Persisting the counter is what prevents that.
  it('resumes the version counter from the database, not from memory', async () => {
    await buildAndPublish(db, opts)
    await buildAndPublish(db, opts)
    // A fresh builder over the same database must not reissue version 1.
    expect(await nextVersion(db)).toBe(3)
  })

  it('publishes an empty feed rather than failing when the graph is empty', async () => {
    const feed = await buildAndPublish(db, opts)
    expect(feed.entries).toEqual([])
    expect(feed.signature).toMatch(/^0x[0-9a-f]{130}$/)
  })

  it('stores the signed document so it can be served after a restart', async () => {
    const published = await buildAndPublish(db, opts)
    const served = await latestFeed(db)
    expect(served).toEqual(published)
  })

  it('serves the newest version when several exist', async () => {
    await buildAndPublish(db, opts)
    const newest = await buildAndPublish(db, opts)
    expect((await latestFeed(db))!.version).toBe(newest.version)
  })

  it('has no feed before the first build', async () => {
    expect(await latestFeed(db)).toBeUndefined()
  })
})
