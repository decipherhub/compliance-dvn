import type { Logger } from 'pino'

/** The slice of `process` we depend on, so tests can inject a fake. */
export interface ProcessLike {
  on(event: string, handler: (...args: unknown[]) => void): ProcessLike
  exit(code: number): void
}

export interface LifecycleDeps {
  logger: Logger
  process?: ProcessLike
  signals?: string[]
  shutdownTimeoutMs?: number
}

type Hook = () => Promise<void> | void

/**
 * Coordinates graceful shutdown. Hooks run in LIFO order (mirroring resource acquisition) on
 * SIGINT/SIGTERM. A hard timeout and a second-signal escape hatch guarantee the process
 * always exits even if a hook hangs.
 */
export class Lifecycle {
  private readonly hooks: Hook[] = []
  private readonly proc: ProcessLike
  private readonly signals: string[]
  private readonly timeoutMs: number
  private shuttingDown = false

  constructor(private readonly deps: LifecycleDeps) {
    this.proc = deps.process ?? (process as unknown as ProcessLike)
    this.signals = deps.signals ?? ['SIGINT', 'SIGTERM']
    this.timeoutMs = deps.shutdownTimeoutMs ?? 30_000
  }

  /** Register a cleanup hook. Hooks run in reverse registration order at shutdown. */
  onShutdown(hook: Hook): void {
    this.hooks.push(hook)
  }

  /** Wire up signal handlers and last-resort crash logging. */
  install(): void {
    for (const sig of this.signals) {
      this.proc.on(sig, () => {
        if (this.shuttingDown) {
          this.deps.logger.error({ sig }, 'second signal received — forcing exit')
          this.proc.exit(1)
          return
        }
        void this.shutdown(sig).then(() => this.proc.exit(0))
      })
    }
    this.proc.on('uncaughtException', (err) => {
      this.deps.logger.fatal({ err: (err as Error)?.message }, 'uncaughtException')
      void this.shutdown('uncaughtException').then(() => this.proc.exit(1))
    })
    this.proc.on('unhandledRejection', (reason) => {
      this.deps.logger.fatal({ reason: String(reason) }, 'unhandledRejection')
      void this.shutdown('unhandledRejection').then(() => this.proc.exit(1))
    })
  }

  /** Run all hooks (LIFO), bounded by the shutdown timeout. Never throws. */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.deps.logger.info({ reason }, 'graceful shutdown started')

    const runHooks = async () => {
      for (const hook of [...this.hooks].reverse()) {
        try {
          await hook()
        } catch (err) {
          this.deps.logger.error({ err: (err as Error).message }, 'shutdown hook failed')
        }
      }
    }

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.deps.logger.error({ timeoutMs: this.timeoutMs }, 'shutdown timed out — exiting anyway')
        resolve()
      }, this.timeoutMs)
      timer.unref?.()
    })

    await Promise.race([runHooks(), timeout])
    if (timer) clearTimeout(timer)
    this.deps.logger.info('graceful shutdown complete')
  }
}
