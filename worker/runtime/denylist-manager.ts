import type { Logger } from 'pino'
import { Denylist } from '../assess/store'
import { makeAssessor, Assessor, buildDenylist } from '../assess/assess'
import type { Metrics } from './metrics'

export type DvnState = 'INITIALIZING' | 'READY' | 'REFRESHING' | 'HALTED'

export interface DenylistManagerDeps {
  /** Builds a fresh denylist from all sources. Injectable for tests. */
  build?: () => Promise<Denylist>
  /** Monotonic-enough clock in ms. Injectable for tests. */
  now?: () => number
  /** Sleep used between initial-build retries. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  refreshMs: number
  maxStalenessMs: number
  logger: Logger
  metrics: Metrics
  initialBackoffMs?: number
  maxBackoffMs?: number
}

/**
 * Owns the current denylist and the fail-closed lifecycle around it.
 *
 * The list is built once at start (retried with backoff until the first success — we never
 * enter READY without a valid list) and refreshed on an interval. Staleness is the single
 * gate: any time the list ages past `maxStalenessMs`, the manager reports HALTED so the
 * service withholds all verification until a refresh succeeds.
 */
export class DenylistManager {
  private current: Denylist | undefined
  private builtAt = 0
  private _state: DvnState = 'INITIALIZING'
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  private readonly build: () => Promise<Denylist>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(private readonly deps: DenylistManagerDeps) {
    this.build = deps.build ?? buildDenylist
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.initialBackoffMs = deps.initialBackoffMs ?? 1000
    this.maxBackoffMs = deps.maxBackoffMs ?? 60_000
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
   * Current assessor over the live denylist. Throws unless READY — defence-in-depth so a
   * caller can never screen against a list the state machine considers unsafe (stale/HALTED).
   */
  assessor(): Assessor {
    if (!this.current) throw new Error('DenylistManager not ready: no denylist built yet')
    if (this._state !== 'READY') throw new Error(`DenylistManager not ready: state is ${this._state}`)
    return makeAssessor(this.current)
  }

  /** Build the initial list (retrying until success), then schedule periodic refreshes. */
  async start(): Promise<void> {
    let backoff = this.initialBackoffMs
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.adopt(await this.build())
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
      this.deps.logger.info({ size: next.size }, 'denylist refreshed')
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

  /** Adopt a freshly built list, stamp the build time, publish metrics, recompute state. */
  private adopt(dl: Denylist): void {
    this.current = dl
    this.builtAt = this.now()
    this.publishMetrics()
    this.evaluate()
  }

  /**
   * Re-evaluate readiness against staleness. Called every loop tick and after every build.
   * This is the single source of truth for the READY <-> HALTED transition.
   */
  evaluate(): DvnState {
    if (!this.current) {
      this.setState('INITIALIZING')
      return this._state
    }
    this.deps.metrics.denylistAgeSeconds.set(Math.floor(this.ageMs() / 1000))
    // Readiness is a pure function of freshness; REFRESHING is only a transient marker
    // that refresh() sets and then resolves via this method.
    this.setState(this.ageMs() > this.deps.maxStalenessMs ? 'HALTED' : 'READY')
    return this._state
  }

  private setState(next: DvnState, haltReason = 'stale_denylist'): void {
    if (next === this._state) {
      // Keep the halted gauge asserted while we remain halted.
      if (next === 'HALTED') this.deps.metrics.halted.set({ reason: haltReason }, 1)
      return
    }
    const prev = this._state
    this._state = next
    if (next === 'HALTED') {
      this.deps.metrics.halted.set({ reason: haltReason }, 1)
      this.deps.metrics.ready.set(0)
      this.deps.logger.error({ prev, reason: haltReason, ageMs: this.ageMs() }, 'fail-closed: HALTED — withholding all verification')
    } else if (next === 'READY') {
      this.deps.metrics.halted.set({ reason: 'stale_denylist' }, 0)
      this.deps.metrics.ready.set(1)
      if (prev === 'HALTED') this.deps.logger.warn({ prev }, 'recovered: READY — resuming verification')
    } else {
      this.deps.metrics.ready.set(0)
    }
  }

  private publishMetrics(): void {
    if (!this.current) return
    for (const [source, count] of Object.entries(this.current.tagCounts())) {
      this.deps.metrics.denylistSize.set({ source }, count)
    }
    this.deps.metrics.denylistAgeSeconds.set(Math.floor(this.ageMs() / 1000))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
