import { createServer, type Server } from 'http'
import type { Logger } from 'pino'
import type { Metrics } from '../metrics'
import type { SignedFeed } from '../feed/builder'

export interface HttpDeps {
  port: number
  metrics: Metrics
  logger: Logger
  /** The newest published feed, or undefined before the first build. */
  feed: () => Promise<SignedFeed | undefined>
  /** Whether the ingest loop is healthy enough to serve. */
  isReady: () => boolean
}

export interface HttpServer {
  server: Server
  port: number
  close: () => Promise<void>
}

/**
 * Serves the feed and the usual operational endpoints.
 *
 * The feed is public by design — it is signed, so its integrity does not depend on who can read
 * it, and the worker verifies the signature against its own allowlist regardless. That also means
 * the signing key must never be reachable from here.
 */
export async function startHttpServer(deps: HttpDeps): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]

    const send = (status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(body)
    }

    if (url === '/healthz') return send(200, 'ok')
    if (url === '/readyz') return deps.isReady() ? send(200, 'ready') : send(503, 'not ready')

    if (url === '/metrics') {
      deps.metrics.registry
        .metrics()
        .then((text) => send(200, text, deps.metrics.registry.contentType))
        .catch((err) => {
          deps.logger.error({ err: (err as Error).message }, 'metrics render failed')
          send(500, 'metrics unavailable')
        })
      return
    }

    if (url === '/feed/latest.json') {
      deps
        .feed()
        .then((feed) =>
          feed
            ? send(200, JSON.stringify(feed), 'application/json; charset=utf-8')
            : // 503 rather than an empty feed: "no labels yet" and "no data available" must not
              // look the same to a consumer that fails closed on staleness.
              send(503, JSON.stringify({ error: 'no feed published yet' }), 'application/json; charset=utf-8'),
        )
        .catch((err) => {
          deps.logger.error({ err: (err as Error).message }, 'feed read failed')
          send(500, JSON.stringify({ error: 'feed unavailable' }), 'application/json; charset=utf-8')
        })
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
  deps.logger.info({ port }, 'http server listening (/feed/latest.json /healthz /readyz /metrics)')

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
