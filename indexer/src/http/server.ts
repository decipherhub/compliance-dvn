import { createServer, type Server } from 'http'
import type { Logger } from 'pino'
import type { Db } from '../db'
import type { Metrics } from '../metrics'
import type { SignedFeed } from '../feed/builder'
import { computeProximity } from '../graph/proximity'

export interface HttpDeps {
  port: number
  metrics: Metrics
  logger: Logger
  /** The newest published feed, or undefined before the first build. */
  feed: () => Promise<SignedFeed | undefined>
  /** Whether the ingest loop is healthy enough to serve. */
  isReady: () => boolean
  /** Read-only queries for the dashboard API. */
  db: Db
  /** Static configuration echoed by /api/status, so the dashboard shows what this instance watches. */
  statusInfo: () => Record<string, unknown>
}

export interface HttpServer {
  server: Server
  port: number
  close: () => Promise<void>
}

/** Clamp a ?limit= parameter to something a browser table can actually render. */
function limitParam(params: URLSearchParams, def: number, max: number): number {
  const n = Number(params.get('limit') ?? def)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/

/**
 * Serves the feed, the usual operational endpoints, and a read-only JSON API for the demo
 * dashboard (/api/*).
 *
 * Everything here is public by design — the feed is signed, so its integrity does not depend on
 * who can read it, and the API rows are already on-chain or derived from public lists. That also
 * means the signing key must never be reachable from here, and every response carries a
 * permissive CORS header so a browser dashboard can read it directly.
 */
export async function startHttpServer(deps: HttpDeps): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const [path, query] = (req.url ?? '/').split('?')
    const params = new URLSearchParams(query ?? '')

    const send = (status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(body)
    }
    const sendJson = (status: number, body: unknown) =>
      send(status, JSON.stringify(body), 'application/json; charset=utf-8')
    const fail = (what: string) => (err: Error) => {
      deps.logger.error({ err: err.message, path }, `${what} failed`)
      sendJson(500, { error: `${what} unavailable` })
    }

    if (path === '/healthz') return send(200, 'ok')
    if (path === '/readyz') return deps.isReady() ? send(200, 'ready') : send(503, 'not ready')

    if (path === '/metrics') {
      deps.metrics.registry
        .metrics()
        .then((text) => send(200, text, deps.metrics.registry.contentType))
        .catch(fail('metrics render'))
      return
    }

    if (path === '/feed/latest.json') {
      deps
        .feed()
        .then((feed) =>
          feed
            ? sendJson(200, feed)
            : // 503 rather than an empty feed: "no labels yet" and "no data available" must not
              // look the same to a consumer that fails closed on staleness.
              sendJson(503, { error: 'no feed published yet' }),
        )
        .catch(fail('feed read'))
      return
    }

    // ── Read-only dashboard API ─────────────────────────────────────────────
    if (path === '/api/status') {
      Promise.all([deps.feed(), deps.db.query<{ n: string }>('SELECT count(*) AS n FROM seed_labels')])
        .then(([feed, seeds]) =>
          sendJson(200, {
            ...deps.statusInfo(),
            seeds: Number(seeds.rows[0]?.n ?? 0),
            feed: feed
              ? {
                  version: feed.version,
                  entries: feed.entries.length,
                  policyVersion: feed.policyVersion,
                  generatedAt: feed.generatedAt,
                  expiresAt: feed.expiresAt,
                }
              : null,
          }),
        )
        .catch(fail('status'))
      return
    }

    if (path === '/api/seeds') {
      const q = (params.get('q') ?? '').toLowerCase()
      deps.db
        .query<{ subject: string; label: string; source: string }>(
          q
            ? `SELECT subject, label, source FROM seed_labels WHERE subject LIKE $1 ORDER BY label, subject LIMIT $2`
            : `SELECT subject, label, source FROM seed_labels ORDER BY label, subject LIMIT $1`,
          q ? [`%${q}%`, limitParam(params, 1000, 5000)] : [limitParam(params, 1000, 5000)],
        )
        .then((r) => sendJson(200, { seeds: r.rows }))
        .catch(fail('seeds query'))
      return
    }

    if (path === '/api/verdicts') {
      const payloadHash = (params.get('payloadHash') ?? '').toLowerCase()
      if (payloadHash && !HEX32.test(payloadHash)) return sendJson(400, { error: 'payloadHash must be 0x + 64 hex' })
      // LEFT JOIN: a verdict whose block row is missing still shows, just without a timestamp.
      const base = `SELECT v.chain, v.block_number, v.tx_hash, v.payload_hash, v.action, v.score,
                v.reason_mask, v.evidence_hash, b.block_time
           FROM risk_verdicts v
           LEFT JOIN blocks b ON b.chain = v.chain AND b.number = v.block_number`
      deps.db
        .query(
          payloadHash
            ? `${base} WHERE v.payload_hash = $1 ORDER BY v.block_number DESC LIMIT $2`
            : `${base} ORDER BY v.block_number DESC LIMIT $1`,
          payloadHash ? [payloadHash, limitParam(params, 200, 1000)] : [limitParam(params, 200, 1000)],
        )
        .then((r) => sendJson(200, { verdicts: r.rows }))
        .catch(fail('verdicts query'))
      return
    }

    if (path === '/api/approvals') {
      deps.db
        .query(
          `SELECT a.chain, a.block_number, a.tx_hash, a.payload_hash, a.approver, b.block_time
             FROM packet_approvals a
             LEFT JOIN blocks b ON b.chain = a.chain AND b.number = a.block_number
            ORDER BY a.block_number DESC LIMIT $1`,
          [limitParam(params, 200, 1000)],
        )
        .then((r) => sendJson(200, { approvals: r.rows }))
        .catch(fail('approvals query'))
      return
    }

    if (path === '/api/edges') {
      const address = (params.get('address') ?? '').toLowerCase()
      if (address && !HEX_ADDRESS.test(address)) return sendJson(400, { error: 'address must be 0x + 40 hex' })
      const base = `SELECT e.chain, e.block_number, e.tx_hash, e.token, e.from_addr, e.to_addr, e.value,
                  e.kind, e.dst_chain, b.block_time
           FROM edges e
           LEFT JOIN blocks b ON b.chain = e.chain AND b.number = e.block_number`
      deps.db
        .query(
          address
            ? `${base} WHERE e.from_addr = $1 OR e.to_addr = $1 ORDER BY e.block_number DESC LIMIT $2`
            : `${base} ORDER BY e.block_number DESC LIMIT $1`,
          address ? [address, limitParam(params, 500, 2000)] : [limitParam(params, 500, 2000)],
        )
        .then((r) => sendJson(200, { edges: r.rows }))
        .catch(fail('edges query'))
      return
    }

    if (path === '/api/proximity') {
      // Live recomputation, not the published feed: the dashboard's graph should show what the
      // NEXT feed will say, without waiting out the rebuild interval.
      computeProximity(deps.db)
        .then((labelled) => sendJson(200, { labelled }))
        .catch(fail('proximity query'))
      return
    }

    send(404, 'not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.port, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : deps.port
  deps.logger.info({ port }, 'http server listening (/feed/latest.json /healthz /readyz /metrics /api/*)')

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
