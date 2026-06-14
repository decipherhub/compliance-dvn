import { describe, it, expect, vi } from 'vitest'
import { DenylistManager } from '../runtime/denylist-manager'
import { createMetrics } from '../runtime/metrics'
import { Denylist } from '../assess/store'
import pino from 'pino'

const silent = pino({ level: 'silent' })

function dlWith(...addrs: string[]): Denylist {
  const dl = new Denylist()
  for (const a of addrs) dl.add(a, 'ofac', 'test')
  return dl
}

/** A controllable clock: read via now(), advance via tick(). */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, tick: (ms: number) => (t += ms) }
}

function make(opts: {
  build: () => Promise<Denylist>
  now: () => number
  refreshMs?: number
  maxStalenessMs?: number
}) {
  const metrics = createMetrics()
  const mgr = new DenylistManager({
    build: opts.build,
    now: opts.now,
    sleep: async () => {},
    refreshMs: opts.refreshMs ?? 60_000,
    maxStalenessMs: opts.maxStalenessMs ?? 120_000,
    logger: silent,
    metrics,
  })
  return { mgr, metrics }
}

describe('DenylistManager', () => {
  it('starts INITIALIZING and becomes READY after a successful build', async () => {
    const clock = fakeClock()
    const { mgr } = make({ build: async () => dlWith('0x' + 'a'.repeat(40)), now: clock.now })
    expect(mgr.state).toBe('INITIALIZING')
    await mgr.start()
    expect(mgr.state).toBe('READY')
    expect(mgr.assessor()('0x' + 'a'.repeat(40)).blocked).toBe(true)
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
    expect(mgr.assessor()('0x' + 'e'.repeat(40)).blocked).toBe(true)
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_denylist_refresh_total\{[^}]*result="failure"[^}]*\} 1/)
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
