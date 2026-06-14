import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { Metrics } from './metrics'

export interface HttpServerDeps {
  port: number
  metrics: Metrics
  /** Readiness predicate — true only when the worker is verifying (READY). */
  isReady: () => boolean
  logger: Logger
}

export interface HttpServerHandle {
  readonly port: number
  close(): Promise<void>
}

/**
 * Operational HTTP surface for Kubernetes + Prometheus:
 *   GET /healthz  liveness — 200 while the process is up (restart if it stops answering)
 *   GET /readyz   readiness — 200 only when verifying; 503 while INITIALIZING/HALTED so
 *                 traffic/alerts see the fail-closed state
 *   GET /metrics  Prometheus exposition
 *
 * Deliberately framework-free: one tiny request router on node:http.
 */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}

export function startHttpServer(deps: HttpServerDeps): Promise<HttpServerHandle> {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '/').split('?')[0]
    try {
      if (url === '/healthz') return send(res, 200, 'text/plain', 'ok\n')
      if (url === '/readyz') {
        const ready = deps.isReady()
        return send(res, ready ? 200 : 503, 'text/plain', ready ? 'ready\n' : 'not ready\n')
      }
      if (url === '/metrics') {
        const body = await deps.metrics.registry.metrics()
        return send(res, 200, deps.metrics.registry.contentType, body)
      }
      send(res, 404, 'text/plain', 'not found\n')
    } catch (err) {
      deps.logger.error({ err: (err as Error).message, url }, 'http handler error')
      send(res, 500, 'text/plain', 'internal error\n')
    }
  }

  const server: Server = createServer((req, res) => void handler(req, res))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.port, () => {
      server.removeListener('error', reject)
      const port = (server.address() as AddressInfo).port
      deps.logger.info({ port }, 'http server listening (/healthz /readyz /metrics)')
      resolve({
        port,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()))
            // Force-drop idle keep-alive sockets so shutdown doesn't stall.
            server.closeAllConnections?.()
          }),
      })
    })
  })
}
