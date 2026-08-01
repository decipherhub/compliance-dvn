import { ethers } from 'ethers'
import { RiskStore, type SubjectType } from '../store'
import { POLICY_VERSION } from '../policy'
import { canonicalize } from '../canonical'
import type { Fetcher } from './ofac'

export { canonicalize }

/**
 * Signed indexer feed ingest.
 *
 * The external indexer computes what the DVN deliberately does not — graph exposure, N-hop
 * proximity, label propagation — and publishes it as a signed document. This module is the only
 * way those labels enter the worker, and every one of the checks below is load-bearing: a feed
 * that fails any of them is rejected whole rather than partially applied.
 *
 * Entries land as the `trusted_indexer` source, so `SOURCE_TRUST` still bounds how far they can
 * escalate. A valid signature proves who produced the feed, not that its contents are true.
 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const SUBJECT_TYPES: SubjectType[] = ['address', 'contract', 'token']

export interface FeedEntry {
  address: string
  labels: string[]
  score?: number
  subjectType?: SubjectType
  evidenceHash?: string
}

export interface Feed {
  version: number
  /** Unix seconds. */
  generatedAt: number
  /** Unix seconds. Doubles as the TTL stamped onto every entry. */
  expiresAt: number
  source: string
  policyVersion: number
  entries: FeedEntry[]
  signature: string
}

export type FeedRejection =
  | 'fetch_failed'
  | 'malformed'
  | 'bad_signature'
  | 'untrusted_signer'
  | 'policy_mismatch'
  | 'replayed'
  | 'expired'
  | 'future_dated'

export class FeedError extends Error {
  constructor(readonly reason: FeedRejection, message: string) {
    super(`feed rejected (${reason}): ${message}`)
    this.name = 'FeedError'
  }
}

export interface FeedConfig {
  url: string
  /** Allowlisted signer addresses. A correct signature from anyone else is still rejected. */
  signers: string[]
  /** How far ahead of our clock `generatedAt` may sit before we call it future-dated. */
  maxSkewSec?: number
}

/** Monotonic version-per-source, persisted so a restart cannot be replayed an old feed. */
export interface FeedVersionStore {
  get(source: string): number
  set(source: string, version: number): void
}

export interface IngestFeedDeps {
  fetcher?: Fetcher
  now?: () => number
  versions: FeedVersionStore
}

/**
 * The exact bytes a signer covers: the whole document except `signature`.
 *
 * Every numeric field in the feed format is an integer by design, which is what makes
 * `canonicalize` usable here — confidence is deliberately not one of them; it comes from
 * `SOURCE_TRUST`, since how far to trust a source is our judgement, not the source's own claim.
 */
export function signingPayload(raw: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = raw
  return canonicalize(rest)
}

function requireInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new FeedError('malformed', `${field} must be a non-negative integer`)
  }
  return v
}

/**
 * Validate the document's shape by hand rather than stripping it through a schema.
 *
 * The signature covers the delivered bytes, so unknown fields must be preserved for
 * verification — a parser that silently dropped them would break every feed whose producer
 * included a field we do not know about.
 */
export function parseFeed(body: string): { feed: Feed; raw: Record<string, unknown> } {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    throw new FeedError('malformed', (err as Error).message)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FeedError('malformed', 'feed must be a JSON object')
  }
  const o = raw as Record<string, unknown>

  if (typeof o.source !== 'string' || o.source.length === 0) {
    throw new FeedError('malformed', 'source must be a non-empty string')
  }
  if (typeof o.signature !== 'string' || !SIGNATURE.test(o.signature)) {
    throw new FeedError('malformed', 'signature must be a 65-byte hex string')
  }
  if (!Array.isArray(o.entries)) throw new FeedError('malformed', 'entries must be an array')

  const entries: FeedEntry[] = o.entries.map((e, i) => {
    if (e === null || typeof e !== 'object') throw new FeedError('malformed', `entries[${i}] must be an object`)
    const entry = e as Record<string, unknown>
    if (typeof entry.address !== 'string' || !EVM_ADDRESS.test(entry.address)) {
      throw new FeedError('malformed', `entries[${i}].address must be a 20-byte EVM address`)
    }
    if (!Array.isArray(entry.labels) || entry.labels.length === 0) {
      throw new FeedError('malformed', `entries[${i}].labels must be a non-empty array`)
    }
    const labels = entry.labels.map((l) => {
      if (typeof l !== 'string' || l.length === 0) {
        throw new FeedError('malformed', `entries[${i}].labels must contain non-empty strings`)
      }
      return l
    })
    if (entry.score !== undefined) {
      const score = requireInt(entry.score, `entries[${i}].score`)
      if (score > 100) throw new FeedError('malformed', `entries[${i}].score must be <= 100`)
    }
    if (entry.subjectType !== undefined && !SUBJECT_TYPES.includes(entry.subjectType as SubjectType)) {
      throw new FeedError('malformed', `entries[${i}].subjectType is not a known subject type`)
    }
    if (entry.evidenceHash !== undefined && (typeof entry.evidenceHash !== 'string' || !HEX32.test(entry.evidenceHash))) {
      throw new FeedError('malformed', `entries[${i}].evidenceHash must be a 32-byte hex string`)
    }
    // NOTE: a feed may carry a per-entry `action`. It is intentionally ignored — the action is
    // ours to decide from policy, and honouring the feed's would hand enforcement authority to
    // the indexer, which is exactly what SOURCE_TRUST exists to prevent.
    return {
      address: entry.address.toLowerCase(),
      labels,
      score: entry.score as number | undefined,
      subjectType: entry.subjectType as SubjectType | undefined,
      evidenceHash: entry.evidenceHash as string | undefined,
    }
  })

  return {
    feed: {
      version: requireInt(o.version, 'version'),
      generatedAt: requireInt(o.generatedAt, 'generatedAt'),
      expiresAt: requireInt(o.expiresAt, 'expiresAt'),
      source: o.source,
      policyVersion: requireInt(o.policyVersion, 'policyVersion'),
      entries,
      signature: o.signature,
    },
    raw: o,
  }
}

/** Recover the signer and check it against the allowlist. */
export function verifyFeedSigner(raw: Record<string, unknown>, signature: string, signers: string[]): string {
  let recovered: string
  try {
    recovered = ethers.utils.verifyMessage(signingPayload(raw), signature).toLowerCase()
  } catch (err) {
    throw new FeedError('bad_signature', (err as Error).message)
  }
  const allowed = signers.map((s) => s.toLowerCase())
  if (!allowed.includes(recovered)) {
    throw new FeedError('untrusted_signer', `${recovered} is not in the signer allowlist`)
  }
  return recovered
}

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`indexer feed fetch failed: ${res.status}`)
  return res.text()
}

/**
 * Fetch, verify, and apply one feed. Returns the number of entries applied.
 *
 * Nothing is written to the store until every check passes, so a rejected feed leaves the
 * previous state untouched rather than half-applied. Entries expire with the feed itself: each
 * carries `expiresAt`, so once the document goes stale its labels stop being scored without any
 * purge step. Removals need no handling either — every refresh builds a fresh store, so an
 * address the indexer drops is simply absent next time.
 */
export async function ingestFeed(store: RiskStore, cfg: FeedConfig, deps: IngestFeedDeps): Promise<number> {
  const fetcher = deps.fetcher ?? defaultFetch
  const now = deps.now ?? Date.now
  const nowSec = Math.floor(now() / 1000)
  const maxSkewSec = cfg.maxSkewSec ?? 300

  let body: string
  try {
    body = await fetcher(cfg.url)
  } catch (err) {
    throw new FeedError('fetch_failed', (err as Error).message)
  }

  const { feed, raw } = parseFeed(body)
  verifyFeedSigner(raw, feed.signature, cfg.signers)

  if (feed.policyVersion !== POLICY_VERSION) {
    throw new FeedError(
      'policy_mismatch',
      `feed policyVersion ${feed.policyVersion} != worker POLICY_VERSION ${POLICY_VERSION}`,
    )
  }
  // Only a rollback is a replay. Re-applying the version we already hold is how a fresh store (a
  // full rebuild, or a restart) recovers the current labels, and how a polling refresh reads a feed
  // that simply has not changed yet — rejecting it there would drop every feed-derived label until
  // the indexer next published, and report a healthy source as unavailable meanwhile.
  const lastVersion = deps.versions.get(feed.source)
  if (feed.version < lastVersion) {
    throw new FeedError('replayed', `version ${feed.version} is older than accepted ${lastVersion}`)
  }
  if (feed.expiresAt <= nowSec) {
    throw new FeedError('expired', `expiresAt ${feed.expiresAt} is not in the future (now ${nowSec})`)
  }
  if (feed.generatedAt > nowSec + maxSkewSec) {
    throw new FeedError('future_dated', `generatedAt ${feed.generatedAt} is more than ${maxSkewSec}s ahead`)
  }

  for (const entry of feed.entries) {
    store.upsert({
      subject: entry.address,
      subjectType: entry.subjectType ?? 'address',
      labels: entry.labels,
      source: 'trusted_indexer',
      score: entry.score,
      evidenceHash: entry.evidenceHash,
      expiresAt: feed.expiresAt * 1000,
    })
  }
  deps.versions.set(feed.source, feed.version)
  return feed.entries.length
}
