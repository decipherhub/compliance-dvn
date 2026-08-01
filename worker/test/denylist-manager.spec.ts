import { describe, it, expect, vi } from 'vitest'
import { DenylistManager } from '../runtime/denylist-manager'
import { createMetrics } from '../runtime/metrics'
import { RiskStore } from '../assess/store'
import type { RiskStoreBuild } from '../assess/assess'
import type { DegradedMode } from '../runtime/denylist-manager'
import pino from 'pino'

const silent = pino({ level: 'silent' })

function dlWith(...addrs: string[]): RiskStoreBuild {
  const store = new RiskStore()
  for (const a of addrs) store.upsert({ subject: a, labels: ['sanctions'], source: 'ofac' })
  return { store, degraded: [] }
}

/** A clean build plus the list of tolerated sources that failed. */
function degradedWith(degraded: string[], ...addrs: string[]): RiskStoreBuild {
  return { ...dlWith(...addrs), degraded }
}

/** A controllable clock: read via now(), advance via tick(). */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, tick: (ms: number) => (t += ms) }
}

function make(opts: {
  build: () => Promise<RiskStoreBuild>
  now: () => number
  refreshMs?: number
  maxStalenessMs?: number
  degradedMode?: DegradedMode
}) {
  const metrics = createMetrics()
  const mgr = new DenylistManager({
    build: opts.build,
    now: opts.now,
    sleep: async () => {},
    refreshMs: opts.refreshMs ?? 60_000,
    maxStalenessMs: opts.maxStalenessMs ?? 120_000,
    degradedMode: opts.degradedMode,
    logger: silent,
    metrics,
  })
  return { mgr, metrics }
}

/**
 * The feed refresh exists so a newly published graph label is usable in seconds. A full rebuild
 * re-downloads OFAC and OpenSanctions, so it cannot run on that cadence.
 */
describe('DenylistManager feed refresh', () => {
  it('ingests the feed into the store already in use', async () => {
    const store = new RiskStore()
    const refreshFeed = vi.fn(async (s: RiskStore) => {
      s.upsert({ subject: '0x' + 'a'.repeat(40), labels: ['sanctions_1hop'], source: 'trusted_indexer' })
      return 1
    })
    const m = new DenylistManager({
      build: async () => ({ store, degraded: [] }),
      refreshFeed,
      refreshMs: 60_000,
      maxStalenessMs: 120_000,
      logger: silent,
      metrics: createMetrics(),
    })
    await m.start()
    expect(await m.refreshFeed()).toBe(1)
    expect(refreshFeed).toHaveBeenCalledWith(store)
    expect(store.has('0x' + 'a'.repeat(40))).toBe(true)
    m.stop()
  })

  // Freshness is about the authoritative sources; a cheap feed fetch must not make a stale
  // sanctions list look current.
  it('does not reset the staleness clock', async () => {
    let t = 1_000_000
    const m = new DenylistManager({
      build: async () => ({ store: new RiskStore(), degraded: [] }),
      refreshFeed: async () => 1,
      refreshMs: 60_000,
      maxStalenessMs: 10_000,
      now: () => t,
      logger: silent,
      metrics: createMetrics(),
    })
    await m.start()
    expect(m.state).toBe('READY')
    t += 20_000
    await m.refreshFeed()
    expect(m.evaluate()).toBe('HALTED') // still stale despite the feed refresh
    m.stop()
  })

  it('survives a failing feed refresh without disturbing the store', async () => {
    const m = new DenylistManager({
      build: async () => ({ store: new RiskStore(), degraded: [] }),
      refreshFeed: async () => { throw new Error('indexer down') },
      refreshMs: 60_000,
      maxStalenessMs: 120_000,
      logger: silent,
      metrics: createMetrics(),
    })
    await m.start()
    expect(await m.refreshFeed()).toBe(0)
    expect(m.state).toBe('READY')
    m.stop()
  })
})

describe('DenylistManager', () => {
  it('starts INITIALIZING and becomes READY after a successful build', async () => {
    const clock = fakeClock()
    const { mgr } = make({ build: async () => dlWith('0x' + 'a'.repeat(40)), now: clock.now })
    expect(mgr.state).toBe('INITIALIZING')
    await mgr.start()
    expect(mgr.state).toBe('READY')
    expect((await mgr.assessor()('0x' + 'a'.repeat(40))).action).toBe('block')
    mgr.stop()
  })

  it('retries the initial build with backoff until it succeeds', async () => {
    const clock = fakeClock()
    let calls = 0
    const build = vi.fn(async () => {
      if (++calls < 3) throw new Error('network down')
      return dlWith('0x' + 'b'.repeat(40))
    })
    const { mgr } = make({ build, now: clock.now })
    await mgr.start()
    expect(calls).toBe(3)
    expect(mgr.state).toBe('READY')
    mgr.stop()
  })

  it('HALTS when the list ages past max staleness', async () => {
    const clock = fakeClock()
    const { mgr, metrics } = make({
      build: async () => dlWith('0x' + 'c'.repeat(40)),
      now: clock.now,
      maxStalenessMs: 120_000,
    })
    await mgr.start()
    expect(mgr.evaluate()).toBe('READY')
    clock.tick(120_001)
    expect(mgr.evaluate()).toBe('HALTED')
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_halted\{[^}]*reason="stale_denylist"[^}]*\} 1/)
    mgr.stop()
  })

  it('recovers from HALTED to READY on a successful refresh', async () => {
    const clock = fakeClock()
    const { mgr } = make({
      build: async () => dlWith('0x' + 'd'.repeat(40)),
      now: clock.now,
      maxStalenessMs: 120_000,
    })
    await mgr.start()
    clock.tick(120_001)
    expect(mgr.evaluate()).toBe('HALTED')
    const ok = await mgr.refresh()
    expect(ok).toBe(true)
    expect(mgr.state).toBe('READY')
    mgr.stop()
  })

  it('keeps serving the last good list when a refresh fails but is not yet stale', async () => {
    const clock = fakeClock()
    let calls = 0
    const build = async () => {
      calls++
      if (calls === 1) return dlWith('0x' + 'e'.repeat(40))
      throw new Error('refresh failed')
    }
    const { mgr, metrics } = make({ build, now: clock.now, maxStalenessMs: 120_000 })
    await mgr.start()
    clock.tick(30_000) // still fresh
    const ok = await mgr.refresh()
    expect(ok).toBe(false)
    expect(mgr.state).toBe('READY') // last good list still valid
    expect((await mgr.assessor()('0x' + 'e'.repeat(40))).action).toBe('block')
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_denylist_refresh_total\{[^}]*result="failure"[^}]*\} 1/)
    // Both outcomes are counted, including the initial build — a dashboard plotting the two
    // together must not show failures only.
    expect(text).toMatch(/dvn_denylist_refresh_total\{[^}]*result="success"[^}]*\} 1/)
    mgr.stop()
  })

  it('HALTS when a refresh fails and the list is already stale', async () => {
    const clock = fakeClock()
    let calls = 0
    const build = async () => {
      calls++
      if (calls === 1) return dlWith('0x' + 'f'.repeat(40))
      throw new Error('refresh failed')
    }
    const { mgr } = make({ build, now: clock.now, maxStalenessMs: 120_000 })
    await mgr.start()
    clock.tick(120_001) // now stale
    const ok = await mgr.refresh()
    expect(ok).toBe(false)
    expect(mgr.state).toBe('HALTED')
    mgr.stop()
  })

  it('reports denylist size and age metrics after build', async () => {
    const clock = fakeClock()
    const { mgr, metrics } = make({
      build: async () => dlWith('0x' + '1'.repeat(40), '0x' + '2'.repeat(40)),
      now: clock.now,
    })
    await mgr.start()
    clock.tick(5000)
    mgr.evaluate()
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_denylist_size\{[^}]*source="ofac"[^}]*\} 2/)
    expect(text).toMatch(/dvn_denylist_age_seconds\{service="compliance-dvn"\} 5/)
    mgr.stop()
  })

  it('stays READY when a tolerated source is missing (degrade, the default)', async () => {
    const clock = fakeClock()
    const { mgr, metrics } = make({
      build: async () => degradedWith(['trusted_indexer'], '0x' + 'a'.repeat(40)),
      now: clock.now,
    })
    await mgr.start()
    expect(mgr.state).toBe('READY')
    expect(mgr.degraded).toEqual(['trusted_indexer'])
    // Sanctions screening keeps working — losing graph labels must not cost us the OFAC list.
    expect((await mgr.assessor()('0x' + 'a'.repeat(40))).action).toBe('block')
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_source_degraded\{[^}]*source="trusted_indexer"[^}]*\} 1/)
    mgr.stop()
  })

  it('HALTS on a degraded source when configured to halt', async () => {
    const clock = fakeClock()
    const { mgr, metrics } = make({
      build: async () => degradedWith(['trusted_indexer'], '0x' + 'a'.repeat(40)),
      now: clock.now,
      degradedMode: 'halt',
    })
    await mgr.start()
    expect(mgr.state).toBe('HALTED')
    expect(() => mgr.assessor()).toThrowError(/not ready/i)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_halted\{[^}]*reason="degraded_source"[^}]*\} 1/)
    mgr.stop()
  })

  it('recovers from a degraded halt once the source returns', async () => {
    const clock = fakeClock()
    let degraded = ['trusted_indexer']
    const { mgr, metrics } = make({
      build: async () => degradedWith(degraded, '0x' + 'a'.repeat(40)),
      now: clock.now,
      degradedMode: 'halt',
    })
    await mgr.start()
    expect(mgr.state).toBe('HALTED')
    degraded = []
    expect(await mgr.refresh()).toBe(true)
    expect(mgr.state).toBe('READY')
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_halted\{[^}]*reason="degraded_source"[^}]*\} 0/)
    expect(text).toMatch(/dvn_source_degraded\{[^}]*source="trusted_indexer"[^}]*\} 0/)
    mgr.stop()
  })

  // Staleness outranks degradation: an aged store is unsafe no matter which sources built it.
  it('reports stale_denylist rather than degraded_source when both apply', async () => {
    const clock = fakeClock()
    const { mgr, metrics } = make({
      build: async () => degradedWith(['trusted_indexer'], '0x' + 'a'.repeat(40)),
      now: clock.now,
      maxStalenessMs: 120_000,
      degradedMode: 'halt',
    })
    await mgr.start()
    clock.tick(120_001)
    expect(mgr.evaluate()).toBe('HALTED')
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_halted\{[^}]*reason="stale_denylist"[^}]*\} 1/)
    // Exactly one reason is ever asserted, so an alert cannot fire on a cleared cause.
    expect(text).toMatch(/dvn_halted\{[^}]*reason="degraded_source"[^}]*\} 0/)
    mgr.stop()
  })

  it('throws from assessor() before the first successful build', () => {
    const clock = fakeClock()
    const { mgr } = make({ build: async () => dlWith(), now: clock.now })
    expect(() => mgr.assessor()).toThrowError(/not ready/i)
  })

  it('throws from assessor() when HALTED (defence-in-depth against stale screening)', async () => {
    const clock = fakeClock()
    const { mgr } = make({
      build: async () => dlWith('0x' + 'a'.repeat(40)),
      now: clock.now,
      maxStalenessMs: 120_000,
    })
    await mgr.start()
    expect(() => mgr.assessor()).not.toThrow() // READY
    clock.tick(120_001)
    expect(mgr.evaluate()).toBe('HALTED')
    expect(() => mgr.assessor()).toThrowError(/not ready: state is HALTED/i)
    mgr.stop()
  })
})
