import { describe, it, expect } from 'vitest'
import { loadConfig, CHAIN_REGISTRY } from '../runtime/config'

const PK = '0x' + '1'.repeat(64)
const ADDR = '0x' + 'a'.repeat(40)

/** Minimal env that should validate cleanly: PK + a DVN address for every enabled chain. */
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    OPERATOR_PRIVATE_KEY: PK,
    DVN_BASE_SEPOLIA: ADDR,
    DVN_OPTIMISM_SEPOLIA: ADDR,
    ...overrides,
  }
}

describe('loadConfig', () => {
  it('loads a valid config with defaults applied', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.operatorPrivateKey).toBe(PK)
    expect(cfg.pollMs).toBe(15000)
    expect(cfg.confirmations).toBe(5)
    expect(cfg.maxDenylistStalenessMs).toBe(3_600_000)
    expect(cfg.httpPort).toBe(9090)
    expect(cfg.logLevel).toBe('info')
    expect(cfg.chains.map((c) => c.key).sort()).toEqual(Object.keys(CHAIN_REGISTRY).sort())
    const base = cfg.chains.find((c) => c.key === 'baseSepolia')!
    expect(base.dvn).toBe(ADDR)
    expect(base.eid).toBe(40245)
    expect(base.endpoint).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('rejects a missing operator key', () => {
    expect(() => loadConfig(baseEnv({ OPERATOR_PRIVATE_KEY: undefined }))).toThrowError(/OPERATOR_PRIVATE_KEY/)
  })

  it('accepts a bare 64-hex operator key and normalizes it to the 0x form', () => {
    // ethers accepts either notation, so rejecting the bare form would block a working config.
    const bare = '1'.repeat(64)
    expect(loadConfig(baseEnv({ OPERATOR_PRIVATE_KEY: bare })).operatorPrivateKey).toBe(`0x${bare}`)
  })

  it('rejects a malformed operator key', () => {
    expect(() => loadConfig(baseEnv({ OPERATOR_PRIVATE_KEY: '0xdeadbeef' }))).toThrowError(/OPERATOR_PRIVATE_KEY/)
  })

  it('aggregates multiple errors into one message', () => {
    let msg = ''
    try {
      loadConfig({ OPERATOR_PRIVATE_KEY: 'nope', POLL_MS: 'abc' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/OPERATOR_PRIVATE_KEY/)
    expect(msg).toMatch(/POLL_MS/)
    // both DVN addresses also missing for the enabled chains
    expect(msg).toMatch(/DVN_BASE_SEPOLIA/)
  })

  it('honors CHAINS_ENABLED to restrict the active set', () => {
    const cfg = loadConfig(baseEnv({ CHAINS_ENABLED: 'baseSepolia' }))
    expect(cfg.chains.map((c) => c.key)).toEqual(['baseSepolia'])
  })

  it('rejects an unknown chain key in CHAINS_ENABLED', () => {
    expect(() => loadConfig(baseEnv({ CHAINS_ENABLED: 'mainnet' }))).toThrowError(/CHAINS_ENABLED.*mainnet/s)
  })

  it('requires a DVN address only for enabled chains', () => {
    // optimism disabled -> its missing DVN address is not an error
    const cfg = loadConfig({ OPERATOR_PRIVATE_KEY: PK, DVN_BASE_SEPOLIA: ADDR, CHAINS_ENABLED: 'baseSepolia' })
    expect(cfg.chains).toHaveLength(1)
  })

  it('rejects a malformed DVN address', () => {
    expect(() => loadConfig(baseEnv({ DVN_BASE_SEPOLIA: '0x123' }))).toThrowError(/DVN_BASE_SEPOLIA/)
  })

  it('parses numeric and override RPC env vars', () => {
    const cfg = loadConfig(baseEnv({ POLL_MS: '5000', RPC_URL_BASE_SEPOLIA: 'https://example.test' }))
    expect(cfg.pollMs).toBe(5000)
    expect(cfg.chains.find((c) => c.key === 'baseSepolia')!.rpc).toBe('https://example.test')
  })

  it('rejects a non-positive poll interval', () => {
    expect(() => loadConfig(baseEnv({ POLL_MS: '0' }))).toThrowError(/POLL_MS/)
  })

  /**
   * Two different things wore one name. The attested value must satisfy the pathway's ULN
   * `confirmations` or the destination refuses the packet; how far behind the head we scan is only
   * a latency choice. Tying them together meant lowering latency broke verification.
   */
  describe('scan depth vs attested confirmations', () => {
    it('defaults the scan depth to the attested value', () => {
      const cfg = loadConfig(baseEnv({ DVN_CONFIRMATIONS: '5' }))
      expect(cfg.confirmations).toBe(5)
      expect(cfg.scanConfirmations).toBe(5)
    })

    it('lets the scan run closer to the head without lowering what is attested', () => {
      const cfg = loadConfig(baseEnv({ DVN_CONFIRMATIONS: '5', SCAN_CONFIRMATIONS: '1' }))
      expect(cfg.confirmations).toBe(5)
      expect(cfg.scanConfirmations).toBe(1)
    })

    it('accepts a scan depth of zero', () => {
      expect(loadConfig(baseEnv({ SCAN_CONFIRMATIONS: '0' })).scanConfirmations).toBe(0)
    })
  })

  it('validates max staleness is at least one refresh interval', () => {
    expect(() =>
      loadConfig(baseEnv({ DENYLIST_REFRESH_MS: '600000', MAX_DENYLIST_STALENESS_MS: '300000' })),
    ).toThrowError(/MAX_DENYLIST_STALENESS_MS/)
  })

  it('leaves the indexer feed disabled by default', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.indexerFeedUrl).toBe('')
    expect(cfg.indexerSigners).toEqual([])
    expect(cfg.degradedMode).toBe('degrade')
    expect(cfg.feedMaxSkewSec).toBe(300)
  })

  it('parses the feed URL and lowercases the signer allowlist', () => {
    const cfg = loadConfig(
      baseEnv({
        INDEXER_FEED_URL: 'https://indexer.test/feed.json',
        INDEXER_SIGNERS: `${ADDR.toUpperCase().replace('0X', '0x')}, ${'0x' + 'b'.repeat(40)}`,
        DEGRADED_MODE: 'halt',
      }),
    )
    expect(cfg.indexerFeedUrl).toBe('https://indexer.test/feed.json')
    expect(cfg.indexerSigners).toEqual([ADDR, '0x' + 'b'.repeat(40)])
    expect(cfg.degradedMode).toBe('halt')
  })

  // An ingested-but-unverified feed is worse than no feed at all, so refuse to boot.
  it('requires a signer allowlist when a feed URL is set', () => {
    expect(() => loadConfig(baseEnv({ INDEXER_FEED_URL: 'https://indexer.test/feed.json' }))).toThrowError(
      /INDEXER_SIGNERS/,
    )
  })

  it('rejects a malformed signer address', () => {
    expect(() =>
      loadConfig(baseEnv({ INDEXER_FEED_URL: 'https://indexer.test/feed.json', INDEXER_SIGNERS: '0xnope' })),
    ).toThrowError(/INDEXER_SIGNERS/)
  })

  it('ignores signers when no feed URL is set', () => {
    expect(() => loadConfig(baseEnv({ INDEXER_SIGNERS: '0xnope' }))).not.toThrow()
  })

  /**
   * The repo root's .env uses PRIVATE_KEY for the OWNER key. Copying it here would previously
   * have started the worker with owner rights, letting it approve the packets it withheld.
   */
  it('names the cause when the root .env was copied here', () => {
    let msg = ''
    try {
      loadConfig({ PRIVATE_KEY: PK, DVN_BASE_SEPOLIA: ADDR, DVN_OPTIMISM_SEPOLIA: ADDR })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/OPERATOR_PRIVATE_KEY/)
    expect(msg).toMatch(/OWNER key/)
    expect(msg).toMatch(/approves held packets/)
  })

  it('does not complain about PRIVATE_KEY when the operator key is set', () => {
    // A stray PRIVATE_KEY in the shell is not itself a problem; only its use as the signer is.
    expect(() => loadConfig(baseEnv({ PRIVATE_KEY: '0x' + '9'.repeat(64) }))).not.toThrow()
  })

  /**
   * The service refuses owner-capable keys even alongside a valid operator key: the owner key
   * approves the very packets the worker withholds, so the two must never share an environment.
   * Default options keep accepting them — deploy scripts and one-off shells legitimately hold one.
   */
  describe('forbidOwnerKeys (service mode)', () => {
    it('refuses PRIVATE_KEY even when the operator key is also set', () => {
      expect(() =>
        loadConfig(baseEnv({ PRIVATE_KEY: '0x' + '9'.repeat(64) }), { forbidOwnerKeys: true }),
      ).toThrowError(/PRIVATE_KEY must not be set in the worker service's environment/)
    })

    it('refuses OWNER_PRIVATE_KEY', () => {
      expect(() =>
        loadConfig(baseEnv({ OWNER_PRIVATE_KEY: '0x' + '9'.repeat(64) }), { forbidOwnerKeys: true }),
      ).toThrowError(/OWNER_PRIVATE_KEY must not be set/)
    })

    it('boots normally when only the operator key is present', () => {
      expect(() => loadConfig(baseEnv(), { forbidOwnerKeys: true })).not.toThrow()
    })
  })

  it('rejects an unknown degraded mode', () => {
    expect(() => loadConfig(baseEnv({ DEGRADED_MODE: 'ignore' }))).toThrowError(/DEGRADED_MODE/)
  })
})
