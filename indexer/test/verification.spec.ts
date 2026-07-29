import { describe, it, expect, beforeEach, vi } from 'vitest'
import pino from 'pino'
import {
  parseMatch,
  lookupOne,
  lookupMany,
  RateLimited,
  DEFAULT_SOURCIFY_URL,
  type Fetcher,
} from '../src/verify/sourcify'
import { refreshVerification, unverifiedContracts } from '../src/verify/refresh'
import { collectEntries } from '../src/feed/builder'
import { applySchema, memDb, seedFixture } from './helpers/memdb'

const silent = pino({ level: 'silent' })
const CHAIN = { key: 'baseSepolia', chainId: 84532 }
const CODE = '0x60006000'

const VERIFIED = '0x' + '1'.repeat(40)
const UNVERIFIED = '0x' + '2'.repeat(40)
const EOA = '0x' + '3'.repeat(40)
const SANCTIONED = '0x' + 'a'.repeat(40)
const TOKEN = '0x' + 'd'.repeat(40)

/** A v2 success body for a verified contract. */
const okVerified = (address: string) =>
  JSON.stringify({ match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match', chainId: '84532', address })

/** A v2 success body for a contract Sourcify knows but has no source for. */
const okUnverified = (address: string) =>
  JSON.stringify({ match: null, creationMatch: null, runtimeMatch: null, chainId: '84532', address })

/** Respond per address; anything unlisted gets a 404 (Sourcify has no record). */
function fetcherFor(map: Record<string, { status: number; body: string }>): Fetcher {
  return async (url: string) => {
    const address = (url.split('/').pop() ?? '').toLowerCase()
    return map[address] ?? { status: 404, body: JSON.stringify({ error: 'not found' }) }
  }
}

let db: ReturnType<typeof memDb>

beforeEach(() => {
  db = memDb()
  applySchema(db)
})

function deps(overrides: Partial<Parameters<typeof refreshVerification>[0]> = {}) {
  return {
    db,
    chain: CHAIN,
    reader: { getCode: async () => CODE },
    trackedTokens: [] as readonly string[],
    batchSize: 50,
    ttlSec: 604_800,
    logger: silent,
    now: () => 1_800_000_000_000,
    ...overrides,
  }
}

describe('parseMatch', () => {
  it('reads a v2 match as verified', () => {
    expect(parseMatch(okVerified(VERIFIED))).toBe('verified')
    expect(parseMatch(JSON.stringify({ match: 'match', creationMatch: null, runtimeMatch: 'match' }))).toBe('verified')
  })

  // An explicit null match is a real answer: Sourcify knows the contract and has no source.
  it('reads a null match as unverified', () => {
    expect(parseMatch(okUnverified(UNVERIFIED))).toBe('unverified')
  })

  it('accepts a legacy self-hosted status', () => {
    expect(parseMatch(JSON.stringify({ match: 'perfect' }))).toBe('verified')
  })

  // Biasing toward not labelling is the safe direction — a missed label costs a weak signal,
  // a false one inflates every score it touches.
  it('returns unknown for a body it cannot interpret', () => {
    expect(parseMatch('not json')).toBe('unknown')
    expect(parseMatch(JSON.stringify({ error: 'Service Unavailable' }))).toBe('unknown')
    expect(parseMatch(JSON.stringify([1, 2, 3]))).toBe('unknown')
    expect(parseMatch('null')).toBe('unknown')
  })
})

describe('lookupOne', () => {
  it('targets the v2 contract endpoint with the chain id', async () => {
    const fetcher = vi.fn(async (_url: string) => ({ status: 200, body: okVerified(VERIFIED) }))
    await lookupOne(VERIFIED, 84532, { fetcher })
    expect(fetcher.mock.calls[0][0]).toBe(`${DEFAULT_SOURCIFY_URL}/v2/contract/84532/${VERIFIED}`)
  })

  it('honours a custom verifier url', async () => {
    const fetcher = vi.fn(async (_url: string) => ({ status: 200, body: okVerified(VERIFIED) }))
    await lookupOne(VERIFIED, 84532, { fetcher, baseUrl: 'https://my-sourcify.internal/server/' })
    expect(fetcher.mock.calls[0][0]).toContain('https://my-sourcify.internal/server/v2/contract/84532/')
  })

  // 404 means Sourcify has no source for this contract — a definitive answer, not a failure.
  it('treats 404 as unverified', async () => {
    const fetcher: Fetcher = async () => ({ status: 404, body: '{}' })
    expect(await lookupOne(UNVERIFIED, 84532, { fetcher })).toBe('unverified')
  })

  // The v1 brownout returns exactly this. It must never be read as "unverified".
  it('treats a 503 brownout as unknown', async () => {
    const fetcher: Fetcher = async () => ({
      status: 503,
      body: JSON.stringify({ error: 'Service Unavailable - API v1 Brownout' }),
    })
    expect(await lookupOne(UNVERIFIED, 84532, { fetcher })).toBe('unknown')
  })

  it('treats a 500 as unknown', async () => {
    const fetcher: Fetcher = async () => ({ status: 500, body: 'oops' })
    expect(await lookupOne(UNVERIFIED, 84532, { fetcher })).toBe('unknown')
  })

  it('throws RateLimited on 429 so the caller can back off', async () => {
    const fetcher: Fetcher = async () => ({ status: 429, body: 'slow down' })
    await expect(lookupOne(UNVERIFIED, 84532, { fetcher })).rejects.toBeInstanceOf(RateLimited)
  })

  it('rejects on timeout', async () => {
    await expect(
      lookupOne(VERIFIED, 84532, { fetcher: () => new Promise(() => {}), timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('lookupMany', () => {
  it('resolves each address independently', async () => {
    const fetcher = fetcherFor({
      [VERIFIED]: { status: 200, body: okVerified(VERIFIED) },
      [UNVERIFIED]: { status: 200, body: okUnverified(UNVERIFIED) },
    })
    const { statuses, rateLimited } = await lookupMany([VERIFIED, UNVERIFIED], 84532, { fetcher })
    expect(rateLimited).toBe(false)
    expect(statuses.get(VERIFIED)).toBe('verified')
    expect(statuses.get(UNVERIFIED)).toBe('unverified')
  })

  it('marks a single transport failure unknown without affecting the others', async () => {
    let first = true
    const fetcher: Fetcher = async (url) => {
      if (first) {
        first = false
        throw new Error('ECONNRESET')
      }
      return { status: 200, body: okVerified(url.split('/').pop()!) }
    }
    const { statuses } = await lookupMany([UNVERIFIED, VERIFIED], 84532, { fetcher })
    expect(statuses.get(UNVERIFIED)).toBe('unknown')
    expect(statuses.get(VERIFIED)).toBe('verified')
  })

  // Pushing through a 429 would only get the remaining answers refused too.
  it('stops the pass on a rate limit and reports what it got', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith(VERIFIED)) return { status: 200, body: okVerified(VERIFIED) }
      return { status: 429, body: 'slow down' }
    })
    const { statuses, rateLimited } = await lookupMany([VERIFIED, UNVERIFIED, EOA], 84532, { fetcher })
    expect(rateLimited).toBe(true)
    expect(statuses.get(VERIFIED)).toBe('verified')
    expect(statuses.has(EOA)).toBe(false) // never attempted
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('refreshVerification', () => {
  it('resolves tracked tokens even before any edges exist', async () => {
    const fetcher = fetcherFor({ [TOKEN]: { status: 200, body: okVerified(TOKEN) } })
    const result = await refreshVerification(deps({ trackedTokens: [TOKEN], sourcify: { fetcher } }))
    expect(result.contracts).toBe(1)
    expect(result.verified).toBe(1)
    expect(await unverifiedContracts(db)).toEqual([])
  })

  it('records an unverified contract', async () => {
    const fetcher = fetcherFor({ [UNVERIFIED]: { status: 200, body: okUnverified(UNVERIFIED) } })
    const result = await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(result.unverified).toBe(1)
    expect(await unverifiedContracts(db)).toEqual([UNVERIFIED])
  })

  it('records a 404 contract as unverified', async () => {
    const result = await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher: fetcherFor({}) } }))
    expect(result.unverified).toBe(1)
    expect(await unverifiedContracts(db)).toEqual([UNVERIFIED])
  })

  // Asking a verifier about an EOA is wasted budget, and an EOA is not a contract to label.
  it('records an EOA and never asks the verifier about it', async () => {
    const fetcher = vi.fn(async (_url: string) => ({ status: 404, body: '{}' }))
    const result = await refreshVerification(
      deps({ trackedTokens: [EOA], reader: { getCode: async () => '0x' }, sourcify: { fetcher } }),
    )
    expect(result.contracts).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await unverifiedContracts(db)).toEqual([])
  })

  it('picks up contract participants from the edge graph', async () => {
    await seedFixture(db, { edges: [{ token: TOKEN, from: UNVERIFIED, to: VERIFIED, value: '1' }] })
    const fetcher = fetcherFor({
      [VERIFIED]: { status: 200, body: okVerified(VERIFIED) },
      [UNVERIFIED]: { status: 200, body: okUnverified(UNVERIFIED) },
    })
    const result = await refreshVerification(deps({ sourcify: { fetcher } }))
    expect(result.contracts).toBe(2)
    expect(await unverifiedContracts(db)).toEqual([UNVERIFIED])
  })

  /**
   * The behaviour this whole design exists for: a verifier outage must leave status unknown, not
   * label every contract in the graph as unverified. This is exactly the v1 brownout response.
   */
  it('leaves status UNKNOWN when the verifier is unavailable', async () => {
    const fetcher: Fetcher = async () => ({ status: 503, body: JSON.stringify({ error: 'brownout' }) })
    const result = await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(result.unverified).toBe(0)
    expect(result.unknown).toBe(1)
    expect(await unverifiedContracts(db)).toEqual([])

    const rows = await db.query<{ verified: boolean | null }>('SELECT verified FROM contract_status')
    // Either nothing was written, or written with an unknown verdict — never `false`.
    expect(rows.rows.every((r) => r.verified === null || r.verified === undefined)).toBe(true)
  })

  it('leaves status unknown on a rate limit and flags it', async () => {
    const fetcher: Fetcher = async () => ({ status: 429, body: 'slow down' })
    const result = await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(result.rateLimited).toBe(true)
    expect(result.unknown).toBe(1)
    expect(await unverifiedContracts(db)).toEqual([])
  })

  it('retries an unknown address on the next pass', async () => {
    let unavailable = true
    const fetcher: Fetcher = async (url) =>
      unavailable
        ? { status: 503, body: '{}' }
        : { status: 200, body: okUnverified(url.split('/').pop()!) }

    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(await unverifiedContracts(db)).toEqual([])
    unavailable = false
    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(await unverifiedContracts(db)).toEqual([UNVERIFIED])
  })

  it('does not re-ask about an address already settled inside the TTL', async () => {
    const fetcher = vi.fn(async (url: string) => ({ status: 200, body: okUnverified(url.split('/').pop()!) }))
    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(fetcher).toHaveBeenCalledOnce()
    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher } }))
    expect(fetcher).toHaveBeenCalledOnce() // served from the cached answer
  })

  it('re-asks once the TTL has passed', async () => {
    const fetcher = vi.fn(async (url: string) => ({ status: 200, body: okUnverified(url.split('/').pop()!) }))
    const t0 = 1_800_000_000_000
    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher }, now: () => t0 }))
    await refreshVerification(
      deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher }, ttlSec: 100, now: () => t0 + 200_000 }),
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('bounds how many addresses it resolves per pass', async () => {
    await seedFixture(db, {
      edges: [
        { token: TOKEN, from: '0x' + '4'.repeat(40), to: '0x' + '5'.repeat(40), value: '1', logIndex: 0 },
        { token: TOKEN, from: '0x' + '6'.repeat(40), to: '0x' + '7'.repeat(40), value: '1', logIndex: 1 },
      ],
    })
    const result = await refreshVerification(deps({ batchSize: 2, sourcify: { fetcher: fetcherFor({}) } }))
    expect(result.inspected).toBe(2)
  })

  it('survives a getCode failure without aborting the pass', async () => {
    let first = true
    const reader = {
      getCode: async () => {
        if (first) {
          first = false
          throw new Error('rpc down')
        }
        return CODE
      },
    }
    const result = await refreshVerification(
      deps({ trackedTokens: [UNVERIFIED, VERIFIED], reader, sourcify: { fetcher: fetcherFor({}) } }),
    )
    expect(result.inspected).toBe(2)
    expect(result.contracts).toBe(1) // the second one still resolved
  })
})

describe('feed entries with verification', () => {
  it('attaches unverified_contract to an address the graph already labels', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: UNVERIFIED, to: SANCTIONED, value: '1' }],
    })
    await refreshVerification(deps({ sourcify: { fetcher: fetcherFor({}) } }))
    expect(await collectEntries(db)).toEqual([
      { address: UNVERIFIED, labels: ['sanctions_1hop', 'unverified_contract'] },
    ])
  })

  it('does not attach the label to a verified contract', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: VERIFIED, to: SANCTIONED, value: '1' }],
    })
    await refreshVerification(
      deps({ sourcify: { fetcher: fetcherFor({ [VERIFIED]: { status: 200, body: okVerified(VERIFIED) } }) } }),
    )
    expect(await collectEntries(db)).toEqual([{ address: VERIFIED, labels: ['sanctions_1hop'] }])
  })

  // A verifier outage must not silently add labels to every address in the graph.
  it('does not attach the label when status is unknown', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: UNVERIFIED, to: SANCTIONED, value: '1' }],
    })
    await refreshVerification(deps({ sourcify: { fetcher: async () => ({ status: 503, body: '{}' }) } }))
    expect(await collectEntries(db)).toEqual([{ address: UNVERIFIED, labels: ['sanctions_1hop'] }])
  })

  // On its own the label scores 20, below the delay threshold, so publishing every unverified
  // contract on a testnet would be feed weight for no effect.
  it('does not publish an unverified contract the graph says nothing else about', async () => {
    await refreshVerification(deps({ trackedTokens: [UNVERIFIED], sourcify: { fetcher: fetcherFor({}) } }))
    expect(await collectEntries(db)).toEqual([])
  })
})
