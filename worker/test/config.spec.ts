import { describe, it, expect } from 'vitest'
import { loadConfig, CHAIN_REGISTRY } from '../runtime/config'

const PK = '0x' + '1'.repeat(64)
const ADDR = '0x' + 'a'.repeat(40)

/** Minimal env that should validate cleanly: PK + a DVN address for every enabled chain. */
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PRIVATE_KEY: PK,
    DVN_BASE_SEPOLIA: ADDR,
    DVN_OPTIMISM_SEPOLIA: ADDR,
    ...overrides,
  }
}

describe('loadConfig', () => {
  it('loads a valid config with defaults applied', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.privateKey).toBe(PK)
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

  it('rejects a missing private key', () => {
    expect(() => loadConfig(baseEnv({ PRIVATE_KEY: undefined }))).toThrowError(/PRIVATE_KEY/)
  })

  it('rejects a malformed private key', () => {
    expect(() => loadConfig(baseEnv({ PRIVATE_KEY: '0xdeadbeef' }))).toThrowError(/PRIVATE_KEY/)
  })

  it('aggregates multiple errors into one message', () => {
    let msg = ''
    try {
      loadConfig({ PRIVATE_KEY: 'nope', POLL_MS: 'abc' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/PRIVATE_KEY/)
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
    const cfg = loadConfig({ PRIVATE_KEY: PK, DVN_BASE_SEPOLIA: ADDR, CHAINS_ENABLED: 'baseSepolia' })
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

  it('validates max staleness is at least one refresh interval', () => {
    expect(() =>
      loadConfig(baseEnv({ DENYLIST_REFRESH_MS: '600000', MAX_DENYLIST_STALENESS_MS: '300000' })),
    ).toThrowError(/MAX_DENYLIST_STALENESS_MS/)
  })
})
