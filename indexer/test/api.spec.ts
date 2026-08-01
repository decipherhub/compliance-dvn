import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import { startHttpServer, type HttpServer } from '../src/http/server'
import { createMetrics } from '../src/metrics'
import { applySchema, memDb, seedFixture } from './helpers/memdb'

const silent = pino({ level: 'silent' })

const SANCTIONED = '0x' + 'a'.repeat(40)
const SUBJECT = '0x' + '1'.repeat(40)
const OTHER = '0x' + '2'.repeat(40)
const TOKEN = '0x' + 'd'.repeat(40)
const PAYLOAD = '0x' + 'f'.repeat(64)

let db: ReturnType<typeof memDb>
let http: HttpServer | undefined

beforeEach(() => {
  db = memDb()
  applySchema(db)
})

afterEach(async () => {
  await http?.close()
  http = undefined
})

async function start(): Promise<string> {
  http = await startHttpServer({
    port: 0,
    metrics: createMetrics(),
    logger: silent,
    feed: async () => undefined,
    isReady: () => true,
    db,
    statusInfo: () => ({ trackedTokens: [TOKEN], policyVersion: 2 }),
  })
  return `http://127.0.0.1:${http.port}`
}

describe('dashboard API', () => {
  it('serves the seed list, filterable by substring', async () => {
    await seedFixture(db, {
      seeds: [
        { subject: SANCTIONED, label: 'sanctions' },
        { subject: OTHER, label: 'sanctioned_mixer' },
      ],
    })
    const base = await start()

    const all = (await (await fetch(`${base}/api/seeds`)).json()) as { seeds: unknown[] }
    expect(all.seeds).toHaveLength(2)

    const filtered = (await (await fetch(`${base}/api/seeds?q=${'a'.repeat(6)}`)).json()) as {
      seeds: Array<{ subject: string }>
    }
    expect(filtered.seeds).toEqual([{ subject: SANCTIONED, label: 'sanctions', source: 'ofac' }])
  })

  it('serves verdicts even when the block row is missing (LEFT JOIN)', async () => {
    await db.query(
      `INSERT INTO risk_verdicts (chain, block_number, tx_hash, log_index, payload_hash, action, score, reason_mask, evidence_hash)
       VALUES ('baseSepolia', 100, '0x01', 0, $1, 3, 100, '9', '0x02')`,
      [PAYLOAD],
    )
    const base = await start()

    const all = (await (await fetch(`${base}/api/verdicts`)).json()) as { verdicts: Array<Record<string, unknown>> }
    expect(all.verdicts).toHaveLength(1)
    expect(all.verdicts[0]).toMatchObject({ payload_hash: PAYLOAD, action: 3 })
    // numeric arrives as a string from pg and as a number from pg-mem; consumers must String() it.
    expect(String(all.verdicts[0].reason_mask)).toBe('9')

    const byHash = (await (await fetch(`${base}/api/verdicts?payloadHash=${PAYLOAD}`)).json()) as {
      verdicts: unknown[]
    }
    expect(byHash.verdicts).toHaveLength(1)
    const miss = (await (await fetch(`${base}/api/verdicts?payloadHash=0x${'0'.repeat(64)}`)).json()) as {
      verdicts: unknown[]
    }
    expect(miss.verdicts).toHaveLength(0)
  })

  it('rejects a malformed payloadHash instead of querying with it', async () => {
    const base = await start()
    expect((await fetch(`${base}/api/verdicts?payloadHash=nope`)).status).toBe(400)
    expect((await fetch(`${base}/api/edges?address=nope`)).status).toBe(400)
  })

  it('serves edges filtered by either endpoint', async () => {
    await seedFixture(db, {
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '5', logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '7', logIndex: 1 },
      ],
    })
    const base = await start()
    const bySubject = (await (await fetch(`${base}/api/edges?address=${SUBJECT}`)).json()) as { edges: unknown[] }
    expect(bySubject.edges).toHaveLength(1)
    const byOther = (await (await fetch(`${base}/api/edges?address=${OTHER}`)).json()) as { edges: unknown[] }
    expect(byOther.edges).toHaveLength(2)
  })

  it('serves live proximity labels, not just the published feed', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    const base = await start()
    const res = (await (await fetch(`${base}/api/proximity`)).json()) as {
      labelled: Array<{ subject: string; labels: string[] }>
    }
    expect(res.labelled).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })

  it('echoes configuration and counts in /api/status', async () => {
    await seedFixture(db, { seeds: [{ subject: SANCTIONED, label: 'sanctions' }] })
    const base = await start()
    const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>
    expect(status).toMatchObject({ trackedTokens: [TOKEN], policyVersion: 2, seeds: 1, feed: null })
  })

  // The demo dashboard reads this API straight from the browser.
  it('sends a permissive CORS header on every response', async () => {
    const base = await start()
    expect((await fetch(`${base}/healthz`)).headers.get('access-control-allow-origin')).toBe('*')
    expect((await fetch(`${base}/api/seeds`)).headers.get('access-control-allow-origin')).toBe('*')
  })
})
