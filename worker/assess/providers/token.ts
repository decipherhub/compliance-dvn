import type { ChainReader } from './contract'

/**
 * Token risk provider — resolves the ERC-20 an OFT actually moves, and reads the static
 * metadata needed to spot an impersonating token.
 *
 * Curated scam/phishing token labels are NOT here; they live in the `RiskStore` like every
 * other list-based signal (see `ingest/tokens.ts`). This provider only supplies what has to be
 * read from the chain at decision time. Honeypot simulation is deliberately out of scope.
 */

const SELECTOR_TOKEN = '0xfc0c546a' // token()
const SELECTOR_SYMBOL = '0x95d89b41' // symbol()
const SELECTOR_DECIMALS = '0x313ce567' // decimals()

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * What we could establish about the OApp's underlying token.
 *
 * `not-a-token` and `unknown` are kept apart on purpose. A plain OApp that does not implement
 * `token()` reverts, and that is a definite answer. An RPC that times out is not — collapsing
 * the two would let an outage silently skip token screening on every packet.
 */
export type TokenResolution =
  | { kind: 'token'; address: string }
  | { kind: 'not-a-token' }
  | { kind: 'unknown'; reason: string }

export interface TokenFacts {
  address: string
  symbol?: string
  decimals?: number
}

export interface TokenInspector {
  resolveToken(oapp: string, chainKey: string): Promise<TokenResolution>
  inspect(token: string, chainKey: string): Promise<TokenFacts>
}

export interface TokenInspectorOptions {
  readers: Record<string, ChainReader>
  timeoutMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  now?: () => number
}

/**
 * Whether a failed `eth_call` was the contract refusing (a definite "no such function") rather
 * than the transport failing. ethers tags reverts as CALL_EXCEPTION; the message check covers
 * providers that only surface a string.
 */
export function isRevert(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  if (e?.code === 'CALL_EXCEPTION') return true
  return /revert|invalid opcode|execution reverted|function selector was not recognized/i.test(e?.message ?? '')
}

function wordToAddress(word: string): string | undefined {
  if (!word || word === '0x') return undefined
  const hex = word.replace(/^0x/, '').padStart(64, '0')
  const addr = '0x' + hex.slice(24)
  return addr === ZERO ? undefined : addr.toLowerCase()
}

/**
 * Decode a `symbol()` return value. Modern tokens return a dynamic `string`; a handful of early
 * ones return a fixed `bytes32`, so both shapes are handled.
 */
export function decodeStringReturn(data: string): string | undefined {
  const hex = data.replace(/^0x/, '')
  if (hex.length === 0) return undefined

  // Dynamic string: offset word (0x20) + length word + padded bytes.
  if (hex.length >= 192 && BigInt('0x' + hex.slice(0, 64)) === 32n) {
    const len = Number(BigInt('0x' + hex.slice(64, 128)))
    if (len === 0 || len > 128) return undefined
    const bytes = hex.slice(128, 128 + len * 2)
    if (bytes.length < len * 2) return undefined
    return Buffer.from(bytes, 'hex').toString('utf8').replace(/\0+$/, '') || undefined
  }

  // bytes32: trailing zero padding.
  if (hex.length === 64) {
    const trimmed = hex.replace(/(00)+$/, '')
    if (!trimmed) return undefined
    return Buffer.from(trimmed, 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '') || undefined
  }
  return undefined
}

function decodeUint8(data: string): number | undefined {
  const hex = data.replace(/^0x/, '')
  if (hex.length === 0) return undefined
  const n = Number(BigInt('0x' + hex.slice(0, 64)))
  return n >= 0 && n <= 255 ? n : undefined
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export class RpcTokenInspector implements TokenInspector {
  private resolutions = new Map<string, { value: TokenResolution; expiresAt: number }>()
  private facts = new Map<string, { value: TokenFacts; expiresAt: number }>()
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly now: () => number

  constructor(private readonly opts: TokenInspectorOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000
    this.maxCacheEntries = opts.maxCacheEntries ?? 5000
    this.now = opts.now ?? Date.now
  }

  async resolveToken(oapp: string, chainKey: string): Promise<TokenResolution> {
    const key = `${chainKey}:${oapp.toLowerCase()}`
    const cached = this.resolutions.get(key)
    // Never cache `unknown`: it is a transport failure, not a fact about the contract.
    if (cached && cached.expiresAt > this.now()) return cached.value

    const reader = this.opts.readers[chainKey]
    if (!reader) return { kind: 'unknown', reason: `no chain reader configured for '${chainKey}'` }

    let resolution: TokenResolution
    try {
      const data = await withTimeout(
        reader.call({ to: oapp.toLowerCase(), data: SELECTOR_TOKEN }),
        this.timeoutMs,
        `token() on ${key}`,
      )
      const address = wordToAddress(data)
      // An OFT whose token() returns nothing useful is not something we can screen.
      resolution = address ? { kind: 'token', address } : { kind: 'not-a-token' }
    } catch (err) {
      if (!isRevert(err)) return { kind: 'unknown', reason: (err as Error).message }
      resolution = { kind: 'not-a-token' }
    }

    remember(this.resolutions, key, resolution, this.now() + this.cacheTtlMs, this.maxCacheEntries)
    return resolution
  }

  async inspect(token: string, chainKey: string): Promise<TokenFacts> {
    const address = token.toLowerCase()
    const key = `${chainKey}:${address}`
    const cached = this.facts.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const reader = this.opts.readers[chainKey]
    if (!reader) throw new Error(`no chain reader configured for '${chainKey}'`)

    // Metadata is optional per ERC-20, so a reverting symbol()/decimals() is not a failure.
    const [symbolData, decimalsData] = await withTimeout(
      Promise.all([
        reader.call({ to: address, data: SELECTOR_SYMBOL }).catch(() => '0x'),
        reader.call({ to: address, data: SELECTOR_DECIMALS }).catch(() => '0x'),
      ]),
      this.timeoutMs,
      `token metadata ${key}`,
    )

    const value: TokenFacts = {
      address,
      symbol: decodeStringReturn(symbolData),
      decimals: decodeUint8(decimalsData),
    }
    remember(this.facts, key, value, this.now() + this.cacheTtlMs, this.maxCacheEntries)
    return value
  }
}

function remember<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T, expiresAt: number, max: number): void {
  if (cache.size >= max) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, expiresAt })
}

/**
 * Symbols worth impersonating. A token claiming one of these while sitting at an address other
 * than the chain's canonical one is the fake-stablecoin pattern.
 */
export const WATCHED_STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'PYUSD', 'FDUSD', 'USDE'])

/**
 * Canonical stablecoin addresses per chain, lowercased.
 *
 * IMPORTANT: an entry that is wrong or out of date makes the REAL token look like an
 * impersonator (a `manual-review` false positive, never a block). A symbol with no entry for the
 * chain is simply not judged — so leaving a chain out is safe, while guessing is not. Verify
 * every address against the issuer before adding one.
 */
export const CANONICAL_STABLECOINS: Record<string, Record<string, string>> = {
  baseSepolia: {
    // Circle's official Base Sepolia USDC. Re-verify against Circle's docs before relying on it.
    USDC: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  },
  optimismSepolia: {
    // Circle's official OP Sepolia USDC. Re-verify against Circle's docs before relying on it.
    USDC: '0x5fd84259d66cd46123540766be93dfe6d43130d7',
  },
}

/**
 * Whether `facts` describe a token impersonating a major stablecoin on `chainKey`.
 *
 * Returns false when the symbol is not watched, or when we hold no canonical address for that
 * symbol on that chain — an unknown pairing is not evidence of anything.
 */
export function isFakeStablecoin(facts: TokenFacts, chainKey: string): boolean {
  if (!facts.symbol) return false
  const symbol = facts.symbol.trim().toUpperCase()
  if (!WATCHED_STABLE_SYMBOLS.has(symbol)) return false
  const canonical = CANONICAL_STABLECOINS[chainKey]?.[symbol]
  if (!canonical) return false
  return canonical !== facts.address.toLowerCase()
}
