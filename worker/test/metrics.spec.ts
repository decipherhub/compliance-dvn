import { describe, it, expect } from 'vitest'
import { createMetrics } from '../runtime/metrics'

// Every series carries the default `service="compliance-dvn"` label, so we match on the
// metric name + a substring of the labels rather than the exact full line.
describe('createMetrics', () => {
  it('exposes a registry that renders Prometheus exposition text', async () => {
    const m = createMetrics()
    m.up.set(1)
    m.ready.set(0)
    m.vetoes.inc({ chain: 'baseSepolia', tag: 'ofac' })
    const text = await m.registry.metrics()
    expect(text).toMatch(/dvn_up\{service="compliance-dvn"\} 1/)
    expect(text).toMatch(/dvn_ready\{service="compliance-dvn"\} 0/)
    expect(text).toMatch(/dvn_vetoes_total\{[^}]*chain="baseSepolia"[^}]*tag="ofac"[^}]*\} 1/)
  })

  it('tracks denylist gauges and refresh outcomes', async () => {
    const m = createMetrics()
    m.denylistSize.set({ source: 'ofac' }, 42)
    m.denylistAgeSeconds.set(10)
    m.denylistRefreshTotal.inc({ result: 'success' })
    const text = await m.registry.metrics()
    expect(text).toMatch(/dvn_denylist_size\{[^}]*source="ofac"[^}]*\} 42/)
    expect(text).toMatch(/dvn_denylist_age_seconds\{service="compliance-dvn"\} 10/)
    expect(text).toMatch(/dvn_denylist_refresh_total\{[^}]*result="success"[^}]*\} 1/)
  })

  it('records tx send durations in a histogram', async () => {
    const m = createMetrics()
    m.txSendSeconds.observe({ chain: 'baseSepolia', op: 'verify' }, 0.5)
    const text = await m.registry.metrics()
    expect(text).toMatch(/dvn_tx_send_seconds_count\{[^}]*chain="baseSepolia"[^}]*op="verify"[^}]*\} 1/)
  })

  it('isolates registries between instances (no global leakage)', async () => {
    const a = createMetrics()
    a.packetsScanned.inc({ chain: 'baseSepolia' }, 3)
    const b = createMetrics()
    const textB = await b.registry.metrics()
    // A fresh registry has not observed any scans, so the counter is absent or zero.
    expect(textB).not.toMatch(/dvn_packets_scanned_total\{[^}]*chain="baseSepolia"[^}]*\} 3/)
  })
})
