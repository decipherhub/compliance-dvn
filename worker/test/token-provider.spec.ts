import { describe, it, expect, vi } from 'vitest'
import {
  RpcTokenInspector,
  decodeStringReturn,
  isRevert,
  isFakeStablecoin,
  CANONICAL_STABLECOINS,
} from '../assess/providers/token'
import { loadScamTokens } from '../assess/ingest/tokens'
import { RiskStore } from '../assess/store'
import type { ChainReader } from '../assess/providers/contract'

const OAPP = '0x' + 'a'.repeat(40)
const TOKEN = '0x' + 'b'.repeat(40)
const EMPTY_WORD = '0x' + '0'.repeat(64)

const SELECTOR_TOKEN = '0xfc0c546a'
const SELECTOR_SYMBOL = '0x95d89b41'
const SELECTOR_DECIMALS = '0x313ce567'

const word = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')
const uint = (n: number) => '0x' + n.toString(16).padStart(64, '0')

/** ABI-encode a dynamic string the way `symbol()` returns one. */
function encodeString(s: string): string {
  const bytes = Buffer.from(s, 'utf8').toString('hex')
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64 || 64, '0')
  return '0x' + uint(32).slice(2) + uint(s.length).slice(2) + padded
}

/** ethers surfaces a revert as CALL_EXCEPTION; mimic that so classification is exercised. */
const revert = () => Object.assign(new Error('call revert exception'), { code: 'CALL_EXCEPTION' })

function reader(handlers: Record<string, () => Promise<string>> = {}): ChainReader {
  return {
    getCode: async () => '0x60006000',
    getStorageAt: async () => EMPTY_WORD,
    call: async ({ data }) => {
      const h = handlers[data]
      if (h) return h()
      return EMPTY_WORD
    },
  }
}

describe('decodeStringReturn', () => {
  it('decodes a dynamic string', () => {
    expect(decodeStringReturn(encodeString('USDC'))).toBe('USDC')
    expect(decodeStringReturn(encodeString('Wrapped Ether'))).toBe('Wrapped Ether')
  })

  it('decodes a legacy bytes32 symbol', () => {
    const b32 = '0x' + Buffer.from('DAI', 'utf8').toString('hex').padEnd(64, '0')
    expect(decodeStringReturn(b32)).toBe('DAI')
  })

  it('returns undefined for empty or nonsense returndata', () => {
    expect(decodeStringReturn('0x')).toBeUndefined()
    expect(decodeStringReturn('')).toBeUndefined()
    expect(decodeStringReturn(EMPTY_WORD)).toBeUndefined()
  })

  it('rejects an absurd declared length instead of allocating on it', () => {
    const bogus = '0x' + uint(32).slice(2) + uint(1_000_000).slice(2) + '00'.repeat(32)
    expect(decodeStringReturn(bogus)).toBeUndefined()
  })
})

describe('isRevert', () => {
  it('recognises an ethers CALL_EXCEPTION', () => {
    expect(isRevert(revert())).toBe(true)
  })

  it('recognises a revert reported only as a message', () => {
    expect(isRevert(new Error('execution reverted: no such function'))).toBe(true)
  })

  it('does NOT treat a transport failure as a revert', () => {
    expect(isRevert(new Error('connect ETIMEDOUT'))).toBe(false)
    expect(isRevert(new Error('token() timed out after 3000ms'))).toBe(false)
    expect(isRevert(undefined)).toBe(false)
  })
})

describe('RpcTokenInspector.resolveToken', () => {
  it('resolves the underlying token of an OFT', async () => {
    const inspector = new RpcTokenInspector({
      readers: { base: reader({ [SELECTOR_TOKEN]: async () => word(TOKEN) }) },
    })
    expect(await inspector.resolveToken(OAPP, 'base')).toEqual({ kind: 'token', address: TOKEN })
  })

  it('reports not-a-token when token() reverts', async () => {
    const inspector = new RpcTokenInspector({
      readers: { base: reader({ [SELECTOR_TOKEN]: async () => { throw revert() } }) },
    })
    expect(await inspector.resolveToken(OAPP, 'base')).toEqual({ kind: 'not-a-token' })
  })

  it('reports not-a-token when token() returns the zero address', async () => {
    const inspector = new RpcTokenInspector({ readers: { base: reader() } })
    expect(await inspector.resolveToken(OAPP, 'base')).toEqual({ kind: 'not-a-token' })
  })

  // The distinction that keeps an RPC outage from silently skipping token screening.
  it('reports unknown — NOT not-a-token — on a transport failure', async () => {
    const inspector = new RpcTokenInspector({
      readers: { base: reader({ [SELECTOR_TOKEN]: async () => { throw new Error('connect ECONNREFUSED') } }) },
    })
    const r = await inspector.resolveToken(OAPP, 'base')
    expect(r.kind).toBe('unknown')
  })

  it('reports unknown on a timeout rather than hanging', async () => {
    const inspector = new RpcTokenInspector({
      readers: { base: reader({ [SELECTOR_TOKEN]: () => new Promise(() => {}) }) },
      timeoutMs: 10,
    })
    const r = await inspector.resolveToken(OAPP, 'base')
    expect(r).toMatchObject({ kind: 'unknown' })
    expect((r as { reason: string }).reason).toMatch(/timed out/)
  })

  it('reports unknown for an unconfigured chain', async () => {
    const inspector = new RpcTokenInspector({ readers: { base: reader() } })
    expect((await inspector.resolveToken(OAPP, 'nope')).kind).toBe('unknown')
  })

  it('caches a definite resolution but never an unknown one', async () => {
    let fail = true
    const call = vi.fn(async () => {
      if (fail) throw new Error('connect ECONNREFUSED')
      return word(TOKEN)
    })
    const inspector = new RpcTokenInspector({ readers: { base: { ...reader(), call } } })

    expect((await inspector.resolveToken(OAPP, 'base')).kind).toBe('unknown')
    fail = false
    expect(await inspector.resolveToken(OAPP, 'base')).toEqual({ kind: 'token', address: TOKEN })
    expect(call).toHaveBeenCalledTimes(2)
    await inspector.resolveToken(OAPP, 'base') // now served from cache
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('RpcTokenInspector.inspect', () => {
  it('reads symbol and decimals', async () => {
    const inspector = new RpcTokenInspector({
      readers: {
        base: reader({
          [SELECTOR_SYMBOL]: async () => encodeString('USDC'),
          [SELECTOR_DECIMALS]: async () => uint(6),
        }),
      },
    })
    expect(await inspector.inspect(TOKEN, 'base')).toEqual({ address: TOKEN, symbol: 'USDC', decimals: 6 })
  })

  it('tolerates missing metadata — both fields are optional per ERC-20', async () => {
    const inspector = new RpcTokenInspector({
      readers: {
        base: reader({
          [SELECTOR_SYMBOL]: async () => { throw revert() },
          [SELECTOR_DECIMALS]: async () => { throw revert() },
        }),
      },
    })
    expect(await inspector.inspect(TOKEN, 'base')).toEqual({
      address: TOKEN,
      symbol: undefined,
      decimals: undefined,
    })
  })

  it('rejects on timeout so the caller can hold the packet', async () => {
    const inspector = new RpcTokenInspector({
      readers: { base: reader({ [SELECTOR_SYMBOL]: () => new Promise(() => {}) }) },
      timeoutMs: 10,
    })
    await expect(inspector.inspect(TOKEN, 'base')).rejects.toThrow(/timed out/)
  })

  it('rejects for an unconfigured chain rather than reporting empty metadata', async () => {
    const inspector = new RpcTokenInspector({ readers: { base: reader() } })
    await expect(inspector.inspect(TOKEN, 'nope')).rejects.toThrow(/no chain reader configured/)
  })
})

describe('isFakeStablecoin', () => {
  const chain = 'baseSepolia'
  const canonical = CANONICAL_STABLECOINS[chain].USDC

  it('flags a watched symbol at a non-canonical address', () => {
    expect(isFakeStablecoin({ address: TOKEN, symbol: 'USDC' }, chain)).toBe(true)
  })

  it('accepts the canonical address, case-insensitively', () => {
    expect(isFakeStablecoin({ address: canonical, symbol: 'USDC' }, chain)).toBe(false)
    expect(isFakeStablecoin({ address: canonical.toUpperCase(), symbol: 'usdc' }, chain)).toBe(false)
  })

  it('ignores unwatched symbols', () => {
    expect(isFakeStablecoin({ address: TOKEN, symbol: 'WETH' }, chain)).toBe(false)
  })

  it('ignores a token with no symbol', () => {
    expect(isFakeStablecoin({ address: TOKEN }, chain)).toBe(false)
  })

  // Guessing would flag the genuine token, so an unknown pairing yields no judgement.
  it('does not judge when the chain has no canonical entry for the symbol', () => {
    expect(isFakeStablecoin({ address: TOKEN, symbol: 'USDT' }, chain)).toBe(false)
    expect(isFakeStablecoin({ address: TOKEN, symbol: 'USDC' }, 'someUnlistedChain')).toBe(false)
  })
})

describe('loadScamTokens', () => {
  it('ships empty when no env value is set', () => {
    const store = new RiskStore()
    expect(loadScamTokens(store, '')).toBe(0)
    expect(store.size).toBe(0)
  })

  it('loads addresses as operator-sourced scam tokens', () => {
    const store = new RiskStore()
    expect(loadScamTokens(store, `${TOKEN},0xNOTANADDRESS,${OAPP.toUpperCase()}`)).toBe(2)
    const entry = store.lookup(TOKEN)[0]
    expect(entry.labels).toEqual(['scam_token'])
    expect(entry.subjectType).toBe('token')
    expect(entry.source).toBe('operator')
    expect(store.has(OAPP)).toBe(true) // normalized to lowercase
  })
})
