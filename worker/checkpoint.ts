import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** Actions that leave a packet unresolved, so it must be reconsidered later. */
export type DeferredAction = 'delay' | 'manual-review'

/**
 * One screened party and the chain its state lives on. A packet's parties are split across
 * chains — the sender is on the source, the receiver and OFT recipient on the destination — so
 * the chain cannot be inferred when the packet is re-screened later.
 */
export interface Party {
  subject: string
  chainKey: string
}

/**
 * A packet held back rather than decided. It carries everything needed to re-screen and then
 * verify it later, because by the time it is reconsidered the source block has long fallen
 * behind the scan cursor and cannot be re-read.
 */
export interface DeferredRecord {
  payloadHash: string
  dstEid: number
  header: string
  /** Source chain the packet came from — the deferred queue is scanned across all chains. */
  srcChainKey: string
  /** Parties re-screened on every re-evaluation: sender, receiver, OFT recipient. */
  parties: Party[]
  action: DeferredAction
  score: number
  reasonCodes: string[]
  attempts: number
  /** Epoch ms before which a `delay` record is not reconsidered. Unused for manual-review. */
  retryAfter: number
  firstDeferredAt: number
}

interface PersistedState {
  lastBlock: Record<string, number>
  processed: string[]
  deferred?: Record<string, DeferredRecord>
  approvals?: string[]
  feedVersions?: Record<string, number>
}

/**
 * Crash-safe persistence of scan progress (last block per chain), processed packet keys, the
 * deferred queue, and observed on-chain approvals.
 *
 * Writes are atomic: we write to a sibling `.tmp` file and `rename` it into place. POSIX
 * rename is atomic, so a crash mid-write leaves the previous good file intact rather than a
 * truncated, unparseable one.
 */
export class Checkpoint {
  private lastBlock: Record<string, number> = {}
  private processedSet = new Set<string>()
  private deferredMap = new Map<string, DeferredRecord>()
  private approvalSet = new Set<string>()
  private feedVersions: Record<string, number> = {}

  constructor(private path: string) {
    if (existsSync(path)) {
      const s = JSON.parse(readFileSync(path, 'utf8')) as PersistedState
      this.lastBlock = s.lastBlock || {}
      this.processedSet = new Set(s.processed || [])
      this.deferredMap = new Map(Object.entries(s.deferred || {}))
      this.approvalSet = new Set(s.approvals || [])
      this.feedVersions = s.feedVersions || {}
    }
  }

  /**
   * Highest accepted feed version per source. Persisted so a restart cannot be handed an older
   * feed that is still correctly signed and unexpired — replay protection has to outlive the
   * process to be worth anything.
   */
  getFeedVersion(source: string): number {
    return this.feedVersions[source] ?? 0
  }

  setFeedVersion(source: string, version: number): void {
    this.feedVersions[source] = version
  }

  getLastBlock(chain: string): number { return this.lastBlock[chain] ?? 0 }
  setLastBlock(chain: string, block: number): void { this.lastBlock[chain] = block }
  isProcessed(key: string): boolean { return this.processedSet.has(key) }

  /** Settle a packet for good. Also drops any deferral, so the two never disagree. */
  markProcessed(key: string): void {
    this.processedSet.add(key)
    this.deferredMap.delete(key)
  }

  defer(key: string, record: DeferredRecord): void { this.deferredMap.set(key, record) }
  getDeferred(key: string): DeferredRecord | undefined { return this.deferredMap.get(key) }
  clearDeferred(key: string): void { this.deferredMap.delete(key) }
  deferredEntries(): Array<[string, DeferredRecord]> { return [...this.deferredMap] }

  /** Held-packet counts per action, for the pending gauge. */
  deferredCounts(): Record<DeferredAction, number> {
    const counts: Record<DeferredAction, number> = { delay: 0, 'manual-review': 0 }
    for (const r of this.deferredMap.values()) counts[r.action]++
    return counts
  }

  /** Record an owner approval seen on-chain. Persisted so it survives a restart. */
  addApproval(payloadHash: string): void { this.approvalSet.add(payloadHash.toLowerCase()) }
  isApproved(payloadHash: string): boolean { return this.approvalSet.has(payloadHash.toLowerCase()) }

  save(): void {
    const out: PersistedState = {
      lastBlock: this.lastBlock,
      processed: [...this.processedSet],
      deferred: Object.fromEntries(this.deferredMap),
      approvals: [...this.approvalSet],
      feedVersions: this.feedVersions,
    }
    const dir = dirname(this.path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(out, null, 2))
    renameSync(tmp, this.path)
  }
}
