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

async function start(isReady: () => boolean) {
  const metrics = createMetrics()
  metrics.up.set(1)
  handle = await startHttpServer({ port: 0, metrics, isReady, logger: silent })
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
})
