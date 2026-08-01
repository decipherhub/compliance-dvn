import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { Metrics } from './metrics'

export interface HttpServerDeps {
  port: number
  metrics: Metrics
  /** Readiness predicate — true only when the worker is verifying (READY). */
  isReady: () => boolean
  /**
   * Snapshot of the held-packet queue for the operator dashboard. Omit to disable GET /pending.
   * Read-only: releasing a hold stays an on-chain owner action (`approvePacket`), never an
   * HTTP call — an endpoint that could release holds would put owner authority on this port.
   */
  pending?: () => unknown
  /** Fail-closed state snapshot for the operator dashboard. Omit to disable GET /status. */
  status?: () => unknown
  logger: Logger
}

export interface HttpServerHandle {
  readonly port: number
  close(): Promise<void>
}

/**
 * Operational HTTP surface for Kubernetes + Prometheus, plus read-only JSON for the dashboard:
 *   GET /healthz  liveness — 200 while the process is up (restart if it stops answering)
 *   GET /readyz   readiness — 200 only when verifying; 503 while INITIALIZING/HALTED so
 *                 traffic/alerts see the fail-closed state
 *   GET /metrics  Prometheus exposition
 *   GET /status   fail-closed state snapshot (JSON)
 *   GET /pending  held packets awaiting delay/approval (JSON)
 *
 * Every response carries a permissive CORS header: everything served here is read-only and
 * non-secret, and the demo dashboard reads it straight from the browser.
 *
 * Deliberately framework-free: one tiny request router on node:http.
 */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'access-control-allow-origin': '*' })
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
      if (url === '/status' && deps.status) {
        return send(res, 200, 'application/json', JSON.stringify(deps.status()))
      }
      if (url === '/pending' && deps.pending) {
        return send(res, 200, 'application/json', JSON.stringify(deps.pending()))
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
      deps.logger.info({ port }, 'http server listening (/healthz /readyz /metrics /status /pending)')
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
