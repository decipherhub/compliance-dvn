import { describe, expect, it } from 'vitest'

import { CHAIN_REGISTRY, loadConfig } from '../src/config'
import { MIXER_ADDRESSES, parseOfacList, parseOpenSanctionsNdjson, refreshSeeds } from '../src/ingest/seeds'
import { IngestStore } from '../src/ingest/store'

import { applySchema, memDb } from './helpers/memdb'

const KEY = '0x' + '7'.repeat(64)
const ADDR = '0x' + 'a'.repeat(40)

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://indexer:indexer@localhost:5432/indexer',
    FEED_SIGNING_KEY: KEY,
    DVN_BASE_SEPOLIA: ADDR,
    DVN_OPTIMISM_SEPOLIA: ADDR,
    ...overrides,
  }
}

describe('loadConfig', () => {
  it('loads a valid config with defaults applied', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.pollMs).toBe(15000)
    expect(cfg.confirmations).toBe(5)
    expect(cfg.reorgDepth).toBe(32)
    expect(cfg.feedSource).toBe('trusted-indexer-a')
    expect(cfg.feedTtlSec).toBe(7200)
    expect(cfg.policyVersion).toBe(2) // v2: 3-hop graph proximity
    expect(cfg.httpPort).toBe(9091)
    expect(cfg.chains.map((c) => c.key).sort()).toEqual(Object.keys(CHAIN_REGISTRY).sort())
  })

  it('accepts a bare 64-hex signing key and normalizes it to the 0x form', () => {
    // ethers accepts either notation, so rejecting the bare form would block a working config.
    const bare = '7'.repeat(64)
    expect(loadConfig(baseEnv({ FEED_SIGNING_KEY: bare })).feedSigningKey).toBe(`0x${bare}`)
  })

  it('requires a database url and a signing key', () => {
    expect(() => loadConfig(baseEnv({ DATABASE_URL: undefined }))).toThrowError(/DATABASE_URL/)
    expect(() => loadConfig(baseEnv({ FEED_SIGNING_KEY: undefined }))).toThrowError(/FEED_SIGNING_KEY/)
    expect(() => loadConfig(baseEnv({ FEED_SIGNING_KEY: '0xnope' }))).toThrowError(/FEED_SIGNING_KEY/)
  })

  it('requires a DVN address for every enabled chain', () => {
    expect(() => loadConfig(baseEnv({ DVN_BASE_SEPOLIA: undefined }))).toThrowError(/DVN_BASE_SEPOLIA/)
    const cfg = loadConfig(baseEnv({ CHAINS_ENABLED: 'optimismSepolia', DVN_BASE_SEPOLIA: undefined }))
    expect(cfg.chains.map((c) => c.key)).toEqual(['optimismSepolia'])
  })

  it('rejects an unknown chain key', () => {
    expect(() => loadConfig(baseEnv({ CHAINS_ENABLED: 'ethereum' }))).toThrowError(/unknown chain/)
  })

  it('parses and lowercases tracked tokens', () => {
    const cfg = loadConfig(baseEnv({ TRACKED_TOKENS: `${'0x' + 'A'.repeat(40)}, ${'0x' + 'b'.repeat(40)}` }))
    expect(cfg.trackedTokens).toEqual(['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40)])
  })

  it('rejects a malformed tracked token', () => {
    expect(() => loadConfig(baseEnv({ TRACKED_TOKENS: '0xnope' }))).toThrowError(/TRACKED_TOKENS/)
  })

  // A document that can expire before its replacement is built would make the worker's screening
  // flap between having feed labels and not.
  it('rejects a TTL that does not exceed the rebuild interval', () => {
    expect(() => loadConfig(baseEnv({ FEED_TTL_SEC: '60', FEED_REBUILD_MS: '600000' }))).toThrowError(
      /FEED_TTL_SEC/,
    )
  })

  it('defaults to the public Sourcify instance', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.verifierUrl).toBe('https://sourcify.dev/server')
    expect(cfg.verifyBatch).toBe(50)
    expect(cfg.verifyTtlSec).toBe(604_800)
  })

  it('allows a self-hosted verifier and an explicit opt-out', () => {
    expect(loadConfig(baseEnv({ VERIFIER_URL: 'https://my-sourcify.internal/server' })).verifierUrl).toBe(
      'https://my-sourcify.internal/server',
    )
    // Empty disables verification rather than falling back to the public instance.
    expect(loadConfig(baseEnv({ VERIFIER_URL: '' })).verifierUrl).toBe('')
  })

  it('exposes the EVM chain id the verifier keys on, distinct from the LayerZero eid', () => {
    const base = loadConfig(baseEnv()).chains.find((c) => c.key === 'baseSepolia')!
    expect(base.eid).toBe(40245)
    expect(base.chainId).toBe(84532)
  })

  it('has no token minimums by default', () => {
    expect(loadConfig(baseEnv()).tokenMinimums).toEqual([])
  })

  it('parses chain:token:minValue triples and lowercases the token', () => {
    const cfg = loadConfig(
      baseEnv({
        TOKEN_MINIMUMS: `baseSepolia:${'0x' + 'A'.repeat(40)}:10000000000000000, optimismSepolia:${'0x' + 'b'.repeat(40)}:10000`,
      }),
    )
    expect(cfg.tokenMinimums).toEqual([
      { chain: 'baseSepolia', token: '0x' + 'a'.repeat(40), minValue: '10000000000000000' },
      { chain: 'optimismSepolia', token: '0x' + 'b'.repeat(40), minValue: '10000' },
    ])
  })

  // A uint256 threshold does not fit a JS number, so it stays a decimal string end to end.
  it('keeps a uint256-scale minimum exact', () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const cfg = loadConfig(baseEnv({ TOKEN_MINIMUMS: `baseSepolia:${'0x' + 'a'.repeat(40)}:${huge}` }))
    expect(cfg.tokenMinimums[0].minValue).toBe(huge)
  })

  it('rejects malformed token minimums', () => {
    const bad = (v: string) => () => loadConfig(baseEnv({ TOKEN_MINIMUMS: v }))
    expect(bad(`baseSepolia:${'0x' + 'a'.repeat(40)}`)).toThrowError(/chain:token:minValue/)
    expect(bad(`ethereum:${'0x' + 'a'.repeat(40)}:1`)).toThrowError(/unknown chain/)
    expect(bad('baseSepolia:0xnope:1')).toThrowError(/not a 20-byte EVM address/)
    expect(bad(`baseSepolia:${'0x' + 'a'.repeat(40)}:0.01`)).toThrowError(/decimal integer/)
    expect(bad(`baseSepolia:${'0x' + 'a'.repeat(40)}:1e16`)).toThrowError(/decimal integer/)
  })

  it('rejects a duplicate chain/token pair rather than silently picking one', () => {
    const t = '0x' + 'a'.repeat(40)
    expect(() => loadConfig(baseEnv({ TOKEN_MINIMUMS: `baseSepolia:${t}:1,baseSepolia:${t}:2` }))).toThrowError(
      /duplicate entry/,
    )
  })

  it('aggregates every problem into one error', () => {
    try {
      loadConfig({ TRACKED_TOKENS: '0xnope' })
      expect.fail('expected a config error')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('DATABASE_URL')
      expect(message).toContain('FEED_SIGNING_KEY')
      expect(message).toContain('DVN_BASE_SEPOLIA')
      expect(message).toContain('TRACKED_TOKENS')
    }
  })
})

describe('seed parsing', () => {
  it('parses the OFAC address list', () => {
    expect(parseOfacList(JSON.stringify(['0xAAA', '0xbbb', 'nothex', '']))).toEqual(['0xaaa', '0xbbb'])
  })

  it('extracts EVM publicKeys from OpenSanctions CryptoWallet entities', () => {
    const ndjson = [
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['0x' + '1'.repeat(40)] } }),
      JSON.stringify({ schema: 'Person', properties: { name: ['Bob'] } }),
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['bc1qxyz'] } }),
      'not json',
      '',
    ].join('\n')
    expect(parseOpenSanctionsNdjson(ndjson)).toEqual(['0x' + '1'.repeat(40)])
  })
})

describe('refreshSeeds', () => {
  it('loads sanctions and mixer seeds', async () => {
    const db = memDb()
    applySchema(db)
    const store = new IngestStore(db)
    const ofac = '0x' + '1'.repeat(40)
    const os = '0x' + '2'.repeat(40)

    const n = await refreshSeeds(store, async (url) =>
      url.includes('opensanctions')
        ? JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: [os] } })
        : JSON.stringify([ofac]),
    )
    expect(n).toBe(2 + MIXER_ADDRESSES.length)

    const rows = await db.query<{ subject: string; label: string }>('SELECT subject, label FROM seed_labels')
    const labels = new Map(rows.rows.map((r) => [r.subject, r.label]))
    expect(labels.get(ofac)).toBe('sanctions')
    expect(labels.get(os)).toBe('sanctions')
    expect(labels.get(MIXER_ADDRESSES[0])).toBe('sanctioned_mixer')
  })

  // A sanction lifted upstream must stop seeding proximity, so seeds are replaced not merged.
  it('replaces a source rather than merging into it', async () => {
    const db = memDb()
    applySchema(db)
    const store = new IngestStore(db)
    const first = '0x' + '1'.repeat(40)
    const second = '0x' + '2'.repeat(40)

    await refreshSeeds(store, async (url) => (url.includes('opensanctions') ? '' : JSON.stringify([first])))
    await refreshSeeds(store, async (url) => (url.includes('opensanctions') ? '' : JSON.stringify([second])))

    const rows = await db.query<{ subject: string }>("SELECT subject FROM seed_labels WHERE label = 'sanctions'")
    expect(rows.rows.map((r) => r.subject)).toEqual([second])
  })
})
