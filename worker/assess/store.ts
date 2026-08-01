import { SOURCE_TRUST, type LabelSource } from './sources'

export type SubjectType = 'address' | 'contract' | 'token'

/**
 * One source's assertion about one subject.
 *
 * Entries are per-source rather than one merged record per subject, and deliberately so: a
 * feed entry that expires in an hour must not carry an OFAC label to the grave with it.
 * Keeping each source's claim separate means TTL, confidence, and trust stay attached to the
 * claim they describe.
 */
export interface RiskEntry {
  subject: string
  subjectType: SubjectType
  labels: string[]
  source: LabelSource
  confidence: number
  /** Source-asserted score, if the source states one (indexer feeds do; OFAC does not). */
  score?: number
  firstSeen: number
  lastSeen: number
  /** Epoch ms after which this entry is ignored. Absent means it never expires. */
  expiresAt?: number
  /** Hash of the off-chain evidence document backing this entry. */
  evidenceHash?: string
}

export interface RiskInput {
  subject: string
  subjectType?: SubjectType
  labels: string[]
  source: LabelSource
  confidence?: number
  score?: number
  expiresAt?: number
  evidenceHash?: string
}

export interface RiskStoreOptions {
  now?: () => number
}

/**
 * The worker's local risk cache — not contract storage, and not a long-term database. It
 * holds only what the current screening decision needs, keyed by lowercased subject.
 */
export class RiskStore {
  private bySubject = new Map<string, RiskEntry[]>()
  private readonly now: () => number

  constructor(opts: RiskStoreOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  /**
   * Record a source's assertion. Re-asserting the same subject from the same source merges
   * labels and refreshes `lastSeen`, TTL, and confidence — a refreshed feed should extend an
   * entry's life, not accumulate duplicates of it.
   */
  upsert(input: RiskInput): RiskEntry {
    const subject = input.subject.toLowerCase()
    const t = this.now()
    const entries = this.bySubject.get(subject) ?? []
    const existing = entries.find((e) => e.source === input.source)

    if (existing) {
      for (const label of input.labels) {
        if (!existing.labels.includes(label)) existing.labels.push(label)
      }
      existing.lastSeen = t
      existing.expiresAt = input.expiresAt
      if (input.subjectType) existing.subjectType = input.subjectType
      if (input.confidence !== undefined) existing.confidence = input.confidence
      if (input.score !== undefined) existing.score = input.score
      if (input.evidenceHash !== undefined) existing.evidenceHash = input.evidenceHash
      return existing
    }

    const entry: RiskEntry = {
      subject,
      subjectType: input.subjectType ?? 'address',
      labels: [...input.labels],
      source: input.source,
      confidence: input.confidence ?? SOURCE_TRUST[input.source].confidence,
      score: input.score,
      firstSeen: t,
      lastSeen: t,
      expiresAt: input.expiresAt,
      evidenceHash: input.evidenceHash,
    }
    entries.push(entry)
    this.bySubject.set(subject, entries)
    return entry
  }

  /** Live entries for a subject. Expired entries are filtered out, not returned as clean. */
  lookup(subject: string): RiskEntry[] {
    const entries = this.bySubject.get(subject.toLowerCase())
    if (!entries) return []
    const t = this.now()
    return entries.filter((e) => e.expiresAt === undefined || e.expiresAt > t)
  }

  /** Whether any live entry exists for this subject. */
  has(subject: string): boolean {
    return this.lookup(subject).length > 0
  }

  /** Distinct subjects holding at least one live entry. */
  get size(): number {
    let n = 0
    for (const subject of this.bySubject.keys()) if (this.has(subject)) n++
    return n
  }

  /** Live entry count per source, for the denylist-size gauge. */
  countsBySource(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const subject of this.bySubject.keys()) {
      for (const e of this.lookup(subject)) counts[e.source] = (counts[e.source] ?? 0) + 1
    }
    return counts
  }

  /** Drop expired entries. Returns how many were removed. */
  prune(): number {
    const t = this.now()
    let removed = 0
    for (const [subject, entries] of this.bySubject) {
      const live = entries.filter((e) => e.expiresAt === undefined || e.expiresAt > t)
      removed += entries.length - live.length
      if (live.length) this.bySubject.set(subject, live)
      else this.bySubject.delete(subject)
    }
    return removed
  }
}
