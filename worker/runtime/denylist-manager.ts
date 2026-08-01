import type { Logger } from 'pino'
import { RiskStore } from '../assess/store'
import { makeAssessor, Assessor, buildRiskStore, type AssessorProviders, type RiskStoreBuild } from '../assess/assess'
import type { Metrics } from './metrics'

export type DvnState = 'INITIALIZING' | 'READY' | 'REFRESHING' | 'HALTED'

/** What to do when a tolerated source (the indexer feed) is unavailable. */
export type DegradedMode = 'degrade' | 'halt'

export interface DenylistManagerDeps {
  /** Builds a fresh risk store from all sources. Injectable for tests. */
  build?: () => Promise<RiskStoreBuild>
  /** Live chain checks layered over the store. Omit for store-only screening. */
  providers?: AssessorProviders
  /** Monotonic-enough clock in ms. Injectable for tests. */
  now?: () => number
  /** Sleep used between initial-build retries. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Re-ingest the indexer feed into the current store. Optional; without it feed labels only
   * arrive with a full rebuild. Returns the number of entries applied.
   */
  refreshFeed?: (store: RiskStore) => Promise<number>
  refreshMs: number
  /** How often to run `refreshFeed`. Omit (or match `refreshMs`) to leave feed timing unchanged. */
  feedRefreshMs?: number
  maxStalenessMs: number
  /**
   * `degrade` keeps verifying on authoritative sources alone when the feed is missing;
   * `halt` withholds everything until the feed returns. Defaults to `degrade`.
   */
  degradedMode?: DegradedMode
  logger: Logger
  metrics: Metrics
  initialBackoffMs?: number
  maxBackoffMs?: number
}

/**
 * Owns the current risk store and the fail-closed lifecycle around it.
 *
 * The store is built once at start (retried with backoff until the first success — we never
 * enter READY without a valid store) and refreshed on an interval. Two gates decide readiness:
 *
 *  - **Staleness.** Any time the store ages past `maxStalenessMs`, the manager reports HALTED so
 *    the service withholds all verification until a refresh succeeds.
 *  - **Degradation.** A build that lost a tolerated source still produces a usable store. Under
 *    `degradedMode: 'halt'` that is enough to withhold verification; under `degrade` (the
 *    default) screening continues on authoritative sources alone, loudly.
 */
export class DenylistManager {
  private current: RiskStore | undefined
  private builtAt = 0
  private _state: DvnState = 'INITIALIZING'
  private _degraded: string[] = []
  private timer: NodeJS.Timeout | undefined
  private feedTimer: NodeJS.Timeout | undefined
  private stopped = false

  private readonly build: () => Promise<RiskStoreBuild>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly degradedMode: DegradedMode
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(private readonly deps: DenylistManagerDeps) {
    this.build = deps.build ?? (() => buildRiskStore())
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.degradedMode = deps.degradedMode ?? 'degrade'
    this.initialBackoffMs = deps.initialBackoffMs ?? 1000
    this.maxBackoffMs = deps.maxBackoffMs ?? 60_000
  }

  /** Sources that failed on the last build but were tolerated. */
  get degraded(): readonly string[] {
    return this._degraded
  }

  get state(): DvnState {
    return this._state
  }

  ageMs(): number {
    return this.now() - this.builtAt
  }

  isFresh(): boolean {
    return this.current !== undefined && this.ageMs() <= this.deps.maxStalenessMs
  }

  /**
   * Current assessor over the live risk store. Throws unless READY — defence-in-depth so a
   * caller can never screen against a store the state machine considers unsafe (stale/HALTED).
   */
  assessor(): Assessor {
    if (!this.current) throw new Error('DenylistManager not ready: no denylist built yet')
    if (this._state !== 'READY') throw new Error(`DenylistManager not ready: state is ${this._state}`)
    return makeAssessor(this.current, this.deps.providers)
  }

  /** Build the initial list (retrying until success), then schedule periodic refreshes. */
  async start(): Promise<void> {
    let backoff = this.initialBackoffMs
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.adopt(await this.build())
        // Counted as a refresh because the failure path below already is: leaving the success out
        // would make the initial build look like pure failures until the first periodic refresh.
        this.deps.metrics.denylistRefreshTotal.inc({ result: 'success' })
        this.deps.logger.info({ size: this.current!.size, attempt }, 'denylist built; worker READY')
        break
      } catch (err) {
        this.deps.metrics.denylistRefreshTotal.inc({ result: 'failure' })
        this.deps.logger.error(
          { err: (err as Error).message, attempt, backoffMs: backoff },
          'initial denylist build failed; retrying',
        )
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, this.maxBackoffMs)
      }
    }
    if (this.stopped) return // stopped during initial-build backoff; never schedule a refresh
    this.scheduleRefresh()
  }

  private scheduleRefresh(): void {
    if (this.stopped) return
    this.timer = setInterval(() => void this.refresh(), this.deps.refreshMs)
    // Don't keep the event loop alive solely for the refresh timer.
    this.timer.unref?.()

    // A separate, usually much shorter cadence for the feed alone — see refreshFeed below.
    const feedMs = this.deps.feedRefreshMs
    if (this.deps.refreshFeed && feedMs && feedMs < this.deps.refreshMs) {
      this.feedTimer = setInterval(() => void this.refreshFeed(), feedMs)
      this.feedTimer.unref?.()
    }
  }

  /**
   * Pull the indexer feed into the store already in use. Never throws.
   *
   * Deliberately does NOT touch `builtAt`: the freshness gate is about the authoritative sources,
   * and letting a cheap feed fetch reset it would keep a stale sanctions list looking current.
   */
  async refreshFeed(): Promise<number> {
    if (this.stopped || !this.current || !this.deps.refreshFeed) return 0
    try {
      const applied = await this.deps.refreshFeed(this.current)
      if (applied > 0) {
        this.publishMetrics()
        // Debug, not info: this runs every few seconds and usually re-applies an unchanged feed.
        // The indexer logs each publish, and `dvn_denylist_size` tracks the result.
        this.deps.logger.debug({ entries: applied, size: this.current.size }, 'indexer feed refreshed')
      }
      return applied
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'feed refresh failed; keeping current labels')
      return 0
    }
  }

  /** Attempt a refresh. Returns whether it succeeded. Never throws. */
  async refresh(): Promise<boolean> {
    if (this.stopped) return false
    const prev = this._state
    this._state = 'REFRESHING'
    try {
      const next = await this.build()
      this.adopt(next)
      this.deps.metrics.denylistRefreshTotal.inc({ result: 'success' })
      this.deps.logger.info({ size: next.store.size, degraded: next.degraded }, 'denylist refreshed')
      return true
    } catch (err) {
      this.deps.metrics.denylistRefreshTotal.inc({ result: 'failure' })
      this.deps.logger.warn(
        { err: (err as Error).message, ageMs: this.ageMs() },
        'denylist refresh failed; keeping last good list',
      )
      // Restore the pre-refresh state, then let staleness decide READY vs HALTED.
      this._state = prev === 'REFRESHING' ? 'READY' : prev
      this.evaluate()
      return false
    }
  }

  /** Adopt a freshly built store, stamp the build time, publish metrics, recompute state. */
  private adopt(build: RiskStoreBuild): void {
    this.current = build.store
    this.builtAt = this.now()
    this._degraded = build.degraded
    this.publishMetrics()
    this.evaluate()
  }

  /**
   * Re-evaluate readiness. Called every loop tick and after every build. This is the single
   * source of truth for the READY <-> HALTED transition.
   */
  evaluate(): DvnState {
    if (!this.current) {
      this.setState('INITIALIZING')
      return this._state
    }
    this.deps.metrics.denylistAgeSeconds.set(Math.floor(this.ageMs() / 1000))
    for (const source of ['trusted_indexer']) {
      this.deps.metrics.sourceDegraded.set({ source }, this._degraded.includes(source) ? 1 : 0)
    }

    // Staleness first: an aged store is unsafe regardless of which sources built it. REFRESHING
    // is only a transient marker that refresh() sets and then resolves via this method.
    if (this.ageMs() > this.deps.maxStalenessMs) {
      this.setState('HALTED', 'stale_denylist')
      return this._state
    }
    if (this._degraded.length > 0 && this.degradedMode === 'halt') {
      this.setState('HALTED', 'degraded_source')
      return this._state
    }
    this.setState('READY')
    return this._state
  }

  /** Every reason `halted` can carry, so exactly one is ever asserted at a time. */
  private static readonly HALT_REASONS = ['stale_denylist', 'degraded_source'] as const

  /** Assert one halt reason and clear the others; pass none to clear them all. */
  private publishHalted(active?: string): void {
    for (const reason of DenylistManager.HALT_REASONS) {
      this.deps.metrics.halted.set({ reason }, reason === active ? 1 : 0)
    }
  }

  private setState(next: DvnState, haltReason = 'stale_denylist'): void {
    if (next === this._state) {
      // Keep the gauge asserted while we remain halted — the reason can change without the
      // state changing (a degraded store going on to age out, say).
      if (next === 'HALTED') this.publishHalted(haltReason)
      return
    }
    const prev = this._state
    this._state = next
    if (next === 'HALTED') {
      this.publishHalted(haltReason)
      this.deps.metrics.ready.set(0)
      this.deps.logger.error({ prev, reason: haltReason, ageMs: this.ageMs() }, 'fail-closed: HALTED — withholding all verification')
    } else if (next === 'READY') {
      this.publishHalted()
      this.deps.metrics.ready.set(1)
      if (prev === 'HALTED') this.deps.logger.warn({ prev }, 'recovered: READY — resuming verification')
      if (this._degraded.length) {
        this.deps.logger.warn(
          { degraded: this._degraded },
          'READY but DEGRADED — verifying on authoritative sources only; feed-derived labels are absent',
        )
      }
    } else {
      this.deps.metrics.ready.set(0)
    }
  }

  private publishMetrics(): void {
    if (!this.current) return
    for (const [source, count] of Object.entries(this.current.countsBySource())) {
      this.deps.metrics.denylistSize.set({ source }, count)
    }
    this.deps.metrics.denylistAgeSeconds.set(Math.floor(this.ageMs() / 1000))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.feedTimer) clearInterval(this.feedTimer)
    this.timer = undefined
    this.feedTimer = undefined
  }
}
