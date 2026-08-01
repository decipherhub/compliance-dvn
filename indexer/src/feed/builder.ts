import { ethers } from 'ethers'
import type { Db } from '../db'
import { canonicalize } from './canonical'
import { computeProximity } from '../graph/proximity'
import { unverifiedContracts } from '../verify/refresh'

/**
 * Builds and signs the document the DVN worker consumes.
 *
 * The format is fixed by `worker/assess/ingest/feed.ts` and documented in the indexer README.
 * Three things about it are load-bearing:
 *
 *  - **Only derived labels are published.** Sanctions and mixer lists are NOT republished: the
 *    worker reads those first-hand from OFAC/OpenSanctions, and re-feeding them as a
 *    `trusted_indexer` claim would launder an authoritative source into a derived one.
 *  - **No `action`, no `confidence`.** Both are the worker's to decide (`SOURCE_TRUST`,
 *    `ACTION_THRESHOLDS`). Asserting them here would move enforcement authority to the indexer.
 *  - **No score either.** The worker's `LABEL_WEIGHTS` are authoritative and a derived label
 *    cannot cause a refusal regardless, so a score would add a number without adding meaning.
 */

export interface FeedEntry {
  address: string
  labels: string[]
}

export interface FeedDocument {
  version: number
  generatedAt: number
  expiresAt: number
  source: string
  policyVersion: number
  entries: FeedEntry[]
}

export interface SignedFeed extends FeedDocument {
  signature: string
}

export interface BuildFeedOptions {
  source: string
  policyVersion: number
  ttlSec: number
  signingKey: string
  now?: () => number
}

/** Next version for a source: strictly increasing, and it must survive a restart. */
export async function nextVersion(db: Db): Promise<number> {
  const res = await db.query<{ max: string | null }>('SELECT max(version) AS max FROM feeds')
  return Number(res.rows[0]?.max ?? 0) + 1
}

/**
 * Every label to publish, merged per address.
 *
 * `unverified_contract` is only worth publishing where it can change an outcome. On its own it
 * scores 20, below the worker's delay threshold, so an address carrying nothing else would be
 * feed weight for no effect. It becomes meaningful in combination — with a proximity label here,
 * or with the `upgradeable_proxy` the worker observes for itself — so it is published for
 * addresses the graph already has something to say about.
 */
export async function collectEntries(db: Db): Promise<FeedEntry[]> {
  const labelled = await computeProximity(db)
  const unverified = new Set(await unverifiedContracts(db))

  const entries = labelled.map((l) => ({
    address: l.subject,
    labels: unverified.has(l.subject) ? [...l.labels, 'unverified_contract'].sort() : l.labels,
  }))
  return entries
}

/** Sign the canonical form of everything except `signature` (EIP-191 personal_sign). */
export async function signFeed(doc: FeedDocument, signingKey: string): Promise<SignedFeed> {
  const wallet = new ethers.Wallet(signingKey)
  const signature = await wallet.signMessage(canonicalize(doc))
  return { ...doc, signature }
}

/**
 * Build, sign, and persist the next feed.
 *
 * Persisting the document is what makes the version counter durable: the worker rejects a
 * version it has already accepted, so handing out a repeat after a restart would get the feed
 * refused rather than applied.
 */
export async function buildAndPublish(db: Db, opts: BuildFeedOptions): Promise<SignedFeed> {
  const now = opts.now ?? Date.now
  const nowSec = Math.floor(now() / 1000)

  const entries = await collectEntries(db)
  const version = await nextVersion(db)

  const doc: FeedDocument = {
    version,
    generatedAt: nowSec,
    expiresAt: nowSec + opts.ttlSec,
    source: opts.source,
    policyVersion: opts.policyVersion,
    entries,
  }
  const signed = await signFeed(doc, opts.signingKey)

  await db.query(
    `INSERT INTO feeds (version, generated_at, expires_at, policy_version, entry_count, document)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [doc.version, doc.generatedAt, doc.expiresAt, doc.policyVersion, doc.entries.length, JSON.stringify(signed)],
  )
  return signed
}

/** The newest published feed, or undefined before the first build. */
export async function latestFeed(db: Db): Promise<SignedFeed | undefined> {
  const res = await db.query<{ document: string }>(
    'SELECT document FROM feeds ORDER BY version DESC LIMIT 1',
  )
  if (!res.rows.length) return undefined
  return JSON.parse(res.rows[0].document) as SignedFeed
}
