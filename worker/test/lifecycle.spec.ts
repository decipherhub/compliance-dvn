import { describe, it, expect, vi } from 'vitest'
import { Lifecycle, ProcessLike } from '../runtime/lifecycle'
import pino from 'pino'

const silent = pino({ level: 'silent' })

function fakeProcess(): ProcessLike & { fire: (sig: string) => void; exited: number[] } {
  const handlers: Record<string, Array<() => void>> = {}
  return {
    exited: [] as number[],
    on(sig: string, h: () => void) {
      ;(handlers[sig] ??= []).push(h)
      return this as unknown as ProcessLike
    },
    exit(code: number) {
      this.exited.push(code)
    },
    fire(sig: string) {
      for (const h of handlers[sig] ?? []) h()
    },
  } as ProcessLike & { fire: (sig: string) => void; exited: number[] }
}

describe('Lifecycle', () => {
  it('runs shutdown hooks in reverse (LIFO) order', async () => {
    const order: string[] = []
    const lc = new Lifecycle({ logger: silent })
    lc.onShutdown(async () => void order.push('a'))
    lc.onShutdown(async () => void order.push('b'))
    await lc.shutdown('test')
    expect(order).toEqual(['b', 'a'])
  })

  it('continues running remaining hooks if one throws', async () => {
    const order: string[] = []
    const lc = new Lifecycle({ logger: silent })
    lc.onShutdown(async () => void order.push('first'))
    lc.onShutdown(async () => { throw new Error('hook boom') })
    await lc.shutdown('test')
    expect(order).toEqual(['first'])
  })

  it('exits 0 on a registered signal', async () => {
    const proc = fakeProcess()
    const lc = new Lifecycle({ logger: silent, process: proc, signals: ['SIGTERM'] })
    const ran = vi.fn(async () => {})
    lc.onShutdown(ran)
    lc.install()
    proc.fire('SIGTERM')
    await new Promise((r) => setTimeout(r, 5))
    expect(ran).toHaveBeenCalledOnce()
    expect(proc.exited).toContain(0)
  })

  it('force-exits non-zero on a second signal during shutdown', async () => {
    const proc = fakeProcess()
    const lc = new Lifecycle({ logger: silent, process: proc, signals: ['SIGTERM'] })
    lc.onShutdown(() => new Promise((r) => setTimeout(r, 1000))) // slow hook
    lc.install()
    proc.fire('SIGTERM') // begins shutdown
    proc.fire('SIGTERM') // second signal -> force exit
    await new Promise((r) => setTimeout(r, 5))
    expect(proc.exited).toContain(1)
  })
})
