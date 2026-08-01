import { type SourcifyOptions, lookupMany } from './sourcify'

import type { Db } from '../db'
import type { Logger } from 'pino'

/** Just enough of a provider to tell a contract from an EOA. */
export interface CodeReader {
  getCode(address: string): Promise<string>
}

export interface RefreshVerificationDeps {
  db: Db
  chain: { key: string; chainId: number }
  reader: CodeReader
  /** Addresses that are contracts by definition (the configured tokens). */
  trackedTokens: readonly string[]
  /** Maximum addresses to resolve per pass, so a cold start does not hammer the verifier. */
  batchSize: number
  /** How long a recorded answer is trusted before being re-checked. */
  ttlSec: number
  sourcify?: SourcifyOptions
  logger: Logger
  now?: () => number
}

export interface RefreshResult {
  inspected: number
  contracts: number
  verified: number
  unverified: number
  /** Answers we could not obtain; these addresses stay NULL and are retried. */
  unknown: number
  rateLimited: boolean
}

/**
 * Resolve verification status for contract addresses the graph has seen.
 *
 * Two stages, because asking a verifier about an EOA is wasted budget: first establish which
 * candidates hold code (one `getCode` each, cached forever after — an address cannot stop being a
 * contract), then ask the verifier only about those.
 *
 * Nothing is written as `verified: false` unless the verifier actually answered. A failed lookup
 * leaves the row NULL so it is retried, rather than recording an absence of evidence as evidence.
 */
export async function refreshVerification(deps: RefreshVerificationDeps): Promise<RefreshResult> {
  const now = deps.now ?? Date.now
  const nowSec = Math.floor(now() / 1000)
  const staleBefore = nowSec - deps.ttlSec
  const result: RefreshResult = {
    inspected: 0,
    contracts: 0,
    verified: 0,
    unverified: 0,
    unknown: 0,
    rateLimited: false,
  }

  const candidates = await selectCandidates(deps, staleBefore)
  if (candidates.length === 0) return result

  // Stage 1: contract or EOA. Recorded either way so an EOA is never re-probed.
  const contracts: string[] = []
  for (const address of candidates) {
    result.inspected++
    let isContract: boolean
    try {
      const code = await deps.reader.getCode(address)
      isContract = !!code && code !== '0x'
    } catch (err) {
      deps.logger.debug({ address, err: (err as Error).message }, 'getCode failed; will retry next pass')
      continue
    }
    if (isContract) contracts.push(address)
    else await upsertStatus(deps.db, deps.chain.key, address, false, null, nowSec)
  }
  result.contracts = contracts.length
  if (contracts.length === 0) return result

  // Stage 2: ask the verifier. v2 answers per address, so this is one request each — bounded by
  // `batchSize` and short-circuited if the verifier starts refusing.
  const { statuses, rateLimited } = await lookupMany(contracts, deps.chain.chainId, deps.sourcify)
  result.rateLimited = rateLimited

  for (const address of contracts) {
    const status = statuses.get(address)
    // An unresolved or unknown answer is left unwritten so the row stays NULL and is retried. A
    // verifier outage must not turn into a wave of `unverified_contract` labels.
    if (status === undefined || status === 'unknown') {
      result.unknown++
      continue
    }
    await upsertStatus(deps.db, deps.chain.key, address, true, status === 'verified', nowSec)
    if (status === 'verified') result.verified++
    else result.unverified++
  }

  if (rateLimited) {
    deps.logger.warn(
      { chain: deps.chain.key, resolved: result.verified + result.unverified, pending: result.unknown },
      'verifier rate-limited; stopping this pass early and retrying the rest later',
    )
  } else if (result.unknown) {
    deps.logger.warn(
      { chain: deps.chain.key, unknown: result.unknown },
      'some verification answers unavailable; status left unknown rather than assumed unverified',
    )
  }
  return result
}

/**
 * Addresses worth resolving: the configured tokens, plus contract-capable participants in the
 * graph, oldest-unknown first.
 *
 * Edge participants are mostly EOAs, so this over-selects — stage 1 filters them out once and
 * records the answer, which keeps each address a one-time cost rather than a recurring one.
 */
async function selectCandidates(deps: RefreshVerificationDeps, staleBefore: number): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()

  const fresh = await deps.db.query<{ address: string }>(
    'SELECT address FROM contract_status WHERE chain = $1 AND (verified IS NOT NULL OR is_contract = false) AND checked_at >= $2',
    [deps.chain.key, staleBefore],
  )
  const settled = new Set(fresh.rows.map((r) => r.address))

  const push = (address: string) => {
    const a = address.toLowerCase()
    if (seen.has(a) || settled.has(a) || out.length >= deps.batchSize) return
    seen.add(a)
    out.push(a)
  }

  for (const token of deps.trackedTokens) push(token)

  const participants = await deps.db.query<{ address: string }>(
    `SELECT address FROM (
        SELECT from_addr AS address FROM edges WHERE chain = $1
        UNION
        SELECT to_addr   AS address FROM edges WHERE chain = $1
     ) t
     LIMIT $2`,
    [deps.chain.key, deps.batchSize * 4],
  )
  for (const row of participants.rows) push(row.address)

  return out
}

async function upsertStatus(
  db: Db,
  chain: string,
  address: string,
  isContract: boolean,
  verified: boolean | null,
  checkedAt: number,
): Promise<void> {
  await db.query(
    `INSERT INTO contract_status (chain, address, is_contract, verified, checked_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chain, address) DO UPDATE
       SET is_contract = EXCLUDED.is_contract,
           verified    = EXCLUDED.verified,
           checked_at  = EXCLUDED.checked_at`,
    [chain, address.toLowerCase(), isContract, verified, checkedAt],
  )
}

/**
 * Addresses to publish `unverified_contract` for.
 *
 * `verified = false` only — a NULL row means we never got an answer, and publishing on that would
 * assert something the verifier never said.
 */
export async function unverifiedContracts(db: Db): Promise<string[]> {
  const res = await db.query<{ address: string }>(
    'SELECT DISTINCT address FROM contract_status WHERE is_contract = true AND verified = false',
  )
  return res.rows.map((r) => r.address).sort()
}
