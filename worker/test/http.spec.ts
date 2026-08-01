import { describe, it, expect, afterEach } from 'vitest'
import { startHttpServer, HttpServerHandle } from '../runtime/http'
import { createMetrics } from '../runtime/metrics'
import pino from 'pino'

const silent = pino({ level: 'silent' })
let handle: HttpServerHandle | undefined

afterEach(async () => {
  await handle?.close()
  handle = undefined
})

async function start(isReady: () => boolean, extra: { pending?: () => unknown; status?: () => unknown } = {}) {
  const metrics = createMetrics()
  metrics.up.set(1)
  handle = await startHttpServer({ port: 0, metrics, isReady, logger: silent, ...extra })
  return `http://127.0.0.1:${handle.port}`
}

describe('startHttpServer', () => {
  it('serves /healthz as 200 regardless of readiness', async () => {
    const base = await start(() => false)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/ok/i)
  })

  it('serves /readyz as 200 when ready and 503 when not', async () => {
    let ready = false
    const base = await start(() => ready)
    expect((await fetch(`${base}/readyz`)).status).toBe(503)
    ready = true
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
  })

  it('serves /metrics in Prometheus exposition format', async () => {
    const base = await start(() => true)
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await res.text()).toMatch(/dvn_up/)
  })

  it('returns 404 for unknown routes', async () => {
    const base = await start(() => true)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('serves /pending and /status as JSON when providers are wired', async () => {
    const base = await start(() => true, {
      pending: () => ({ pending: [{ payloadHash: '0xabc', action: 'manual-review' }] }),
      status: () => ({ state: 'READY', degraded: [] }),
    })
    const pending = await fetch(`${base}/pending`)
    expect(pending.headers.get('content-type')).toMatch(/json/)
    expect(await pending.json()).toEqual({ pending: [{ payloadHash: '0xabc', action: 'manual-review' }] })
    expect(await (await fetch(`${base}/status`)).json()).toMatchObject({ state: 'READY' })
  })

  it('hides /pending and /status when no provider is wired', async () => {
    const base = await start(() => true)
    expect((await fetch(`${base}/pending`)).status).toBe(404)
    expect((await fetch(`${base}/status`)).status).toBe(404)
  })

  // The demo dashboard reads these endpoints straight from the browser.
  it('sends a permissive CORS header on every response', async () => {
    const base = await start(() => true)
    expect((await fetch(`${base}/healthz`)).headers.get('access-control-allow-origin')).toBe('*')
    expect((await fetch(`${base}/metrics`)).headers.get('access-control-allow-origin')).toBe('*')
  })
})
