/**
 * Source-verification lookup against Sourcify's v2 API.
 *
 * v1 (`/check-all-by-addresses`) is in a scheduled brownout and returns 503 telling callers to
 * migrate, so this targets `GET /v2/contract/{chainId}/{address}`. v2 answers per address rather
 * than in batches, which is why the caller caches aggressively and caps how many it resolves per
 * pass — see `refresh.ts`.
 *
 * The three-way result is the whole point. "Not verified" and "we could not find out" must stay
 * distinct: recording the second as the first would let a verifier outage label every contract in
 * the graph as unverified.
 *
 * `baseUrl` is configurable so a self-hosted Sourcify can be used instead of the public instance.
 */

export type VerificationStatus = 'verified' | 'unverified' | 'unknown'

export interface HttpResponse {
  status: number
  body: string
}

/** Returns the status alongside the body: 404 is a definitive answer, 503 is not. */
export type Fetcher = (url: string) => Promise<HttpResponse>

/**
 * Match values that count as "source available".
 *
 * v2 uses `match` / `exact_match`. The older `perfect` / `partial` are accepted too, since
 * `baseUrl` may point at a self-hosted instance on an earlier release.
 */
const VERIFIED_MATCHES = new Set(['match', 'exact_match', 'perfect', 'partial', 'full_match', 'partial_match'])

export const DEFAULT_SOURCIFY_URL = 'https://sourcify.dev/server'

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  return { status: res.status, body: await res.text() }
}

/**
 * Read a verification verdict out of a v2 contract response.
 *
 * `match: null` is an explicit "known to Sourcify, no source match" and means unverified. A body
 * this cannot interpret returns `unknown` rather than a guess — biasing toward not labelling,
 * since a missed label costs a weak signal while a false one inflates every score it touches.
 */
export function parseMatch(body: string): VerificationStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return 'unknown'
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown'
  const obj = parsed as Record<string, unknown>

  // `match` is required on a v2 success response, so its absence means this is not one.
  if (!('match' in obj) && !('runtimeMatch' in obj) && !('creationMatch' in obj)) return 'unknown'

  for (const key of ['match', 'runtimeMatch', 'creationMatch']) {
    const value = obj[key]
    if (typeof value === 'string' && VERIFIED_MATCHES.has(value.toLowerCase())) return 'verified'
  }
  return 'unverified'
}

export interface SourcifyOptions {
  baseUrl?: string
  fetcher?: Fetcher
  timeoutMs?: number
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

/** Thrown when the verifier asks us to back off, so the caller can stop the pass rather than hammer it. */
export class RateLimited extends Error {
  constructor() {
    super('verifier rate-limited the request')
    this.name = 'RateLimited'
  }
}

/**
 * Ask the verifier about one address.
 *
 * 404 is a real answer — Sourcify has no source for this contract — so it maps to `unverified`.
 * Everything else that is not a 200 leaves the status `unknown`.
 */
export async function lookupOne(
  address: string,
  chainId: number,
  opts: SourcifyOptions = {},
): Promise<VerificationStatus> {
  const base = (opts.baseUrl ?? DEFAULT_SOURCIFY_URL).replace(/\/+$/, '')
  const fetcher = opts.fetcher ?? defaultFetch
  const url = `${base}/v2/contract/${chainId}/${encodeURIComponent(address.toLowerCase())}`

  const res = await withTimeout(fetcher(url), opts.timeoutMs ?? 10_000, `verifier lookup ${address}`)
  if (res.status === 429) throw new RateLimited()
  if (res.status === 404) return 'unverified'
  if (res.status !== 200) return 'unknown'
  return parseMatch(res.body)
}

/**
 * Resolve a batch of addresses, one request each.
 *
 * A rate limit stops the pass immediately and the addresses already resolved are returned — the
 * rest stay unrecorded and are retried next time. Pushing through a 429 would only get the
 * remaining answers refused anyway.
 */
export async function lookupMany(
  addresses: readonly string[],
  chainId: number,
  opts: SourcifyOptions = {},
): Promise<{ statuses: Map<string, VerificationStatus>; rateLimited: boolean }> {
  const statuses = new Map<string, VerificationStatus>()
  for (const address of addresses) {
    try {
      statuses.set(address.toLowerCase(), await lookupOne(address, chainId, opts))
    } catch (err) {
      if (err instanceof RateLimited) return { statuses, rateLimited: true }
      // A transport failure for one address says nothing about the others; leave it unknown.
      statuses.set(address.toLowerCase(), 'unknown')
    }
  }
  return { statuses, rateLimited: false }
}
