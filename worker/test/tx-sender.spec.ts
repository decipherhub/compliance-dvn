import { describe, it, expect, vi } from 'vitest'
import { TxSender, isRetriableTxError } from '../runtime/tx-sender'
import { createMetrics } from '../runtime/metrics'
import pino from 'pino'

const silent = pino({ level: 'silent' })

function make(opts: { nonceStart?: number; maxRetries?: number; gasBumpPct?: number } = {}) {
  const getTransactionCount = vi.fn(async () => opts.nonceStart ?? 7)
  const getGasPrice = vi.fn(async () => 1_000_000_000n) // 1 gwei
  const metrics = createMetrics()
  const sender = new TxSender({
    chain: 'baseSepolia',
    address: '0x' + 'a'.repeat(40),
    getTransactionCount,
    getGasPrice,
    maxRetries: opts.maxRetries ?? 3,
    gasBumpPct: opts.gasBumpPct ?? 15,
    logger: silent,
    metrics,
    sleep: async () => {},
    baseBackoffMs: 1,
  })
  return { sender, getTransactionCount, getGasPrice, metrics }
}

function okTx(hash: string) {
  return { hash, wait: async () => ({ transactionHash: hash }) }
}

describe('TxSender', () => {
  it('sends with the fetched nonce and returns the tx hash', async () => {
    const { sender } = make({ nonceStart: 7 })
    const seen: number[] = []
    const hash = await sender.send('verify', async ({ nonce }) => {
      seen.push(nonce)
      return okTx('0xabc')
    })
    expect(hash).toBe('0xabc')
    expect(seen).toEqual([7])
  })

  it('assigns sequential nonces across successful sends', async () => {
    const { sender, getTransactionCount } = make({ nonceStart: 7 })
    const seen: number[] = []
    await sender.send('verify', async ({ nonce }) => (seen.push(nonce), okTx('0x1')))
    await sender.send('commit', async ({ nonce }) => (seen.push(nonce), okTx('0x2')))
    expect(seen).toEqual([7, 8])
    // nonce is fetched once and then tracked locally
    expect(getTransactionCount).toHaveBeenCalledTimes(1)
  })

  it('retries on a retriable error and bumps gas each attempt', async () => {
    const { sender } = make({ gasBumpPct: 100 })
    const prices: bigint[] = []
    let calls = 0
    const hash = await sender.send('verify', async ({ gasPrice }) => {
      prices.push(gasPrice)
      if (++calls < 3) {
        const e = new Error('replacement transaction underpriced') as Error & { code: string }
        e.code = 'REPLACEMENT_UNDERPRICED'
        throw e
      }
      return okTx('0xdone')
    })
    expect(hash).toBe('0xdone')
    expect(calls).toBe(3)
    // 1 gwei base, +100% each attempt: 1, 2, 3 gwei
    expect(prices).toEqual([1_000_000_000n, 2_000_000_000n, 3_000_000_000n])
  })

  it('throws after exhausting retries', async () => {
    const { sender } = make({ maxRetries: 2 })
    let calls = 0
    await expect(
      sender.send('verify', async () => {
        calls++
        const e = new Error('timeout') as Error & { code: string }
        e.code = 'TIMEOUT'
        throw e
      }),
    ).rejects.toThrow(/timeout/)
    expect(calls).toBe(3) // initial + 2 retries
  })

  it('does not retry a non-retriable (revert) error', async () => {
    const { sender } = make()
    let calls = 0
    await expect(
      sender.send('verify', async () => {
        calls++
        const e = new Error('execution reverted: not assigned') as Error & { code: string }
        e.code = 'CALL_EXCEPTION'
        throw e
      }),
    ).rejects.toThrow(/reverted/)
    expect(calls).toBe(1)
  })

  it('refetches the nonce on a nonce-expired error', async () => {
    const getTransactionCount = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(9)
    const sender = new TxSender({
      chain: 'baseSepolia',
      address: '0x' + 'a'.repeat(40),
      getTransactionCount,
      getGasPrice: async () => 1n,
      maxRetries: 2,
      gasBumpPct: 10,
      logger: silent,
      metrics: createMetrics(),
      sleep: async () => {},
      baseBackoffMs: 1,
    })
    const seen: number[] = []
    let calls = 0
    await sender.send('verify', async ({ nonce }) => {
      seen.push(nonce)
      if (++calls === 1) {
        const e = new Error('nonce has already been used') as Error & { code: string }
        e.code = 'NONCE_EXPIRED'
        throw e
      }
      return okTx('0xok')
    })
    expect(seen).toEqual([7, 9])
    expect(getTransactionCount).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent sends so nonces never collide', async () => {
    const { sender, getTransactionCount } = make({ nonceStart: 7 })
    const seen: number[] = []
    // Fire three sends concurrently; each send's builder defers a tick to force interleaving.
    const results = await Promise.all([
      sender.send('verify', async ({ nonce }) => {
        await new Promise((r) => setTimeout(r, 0))
        seen.push(nonce)
        return okTx('0x1')
      }),
      sender.send('commit', async ({ nonce }) => {
        seen.push(nonce)
        return okTx('0x2')
      }),
      sender.send('verify', async ({ nonce }) => {
        seen.push(nonce)
        return okTx('0x3')
      }),
    ])
    expect(results).toEqual(['0x1', '0x2', '0x3'])
    expect(seen).toEqual([7, 8, 9]) // strictly sequential despite concurrency
    expect(getTransactionCount).toHaveBeenCalledTimes(1)
  })

  it('records send latency in the histogram', async () => {
    const { sender, metrics } = make()
    await sender.send('verify', async () => okTx('0xok'))
    const text = await metrics.registry.metrics()
    expect(text).toMatch(/dvn_tx_send_seconds_count\{[^}]*chain="baseSepolia"[^}]*op="verify"[^}]*\} 1/)
  })
})

describe('isRetriableTxError', () => {
  it('classifies transient network/gas/nonce errors as retriable', () => {
    for (const code of ['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'REPLACEMENT_UNDERPRICED', 'NONCE_EXPIRED']) {
      expect(isRetriableTxError({ code } as Error & { code: string })).toBe(true)
    }
  })
  it('classifies reverts and unknown errors as non-retriable', () => {
    expect(isRetriableTxError({ code: 'CALL_EXCEPTION' } as Error & { code: string })).toBe(false)
    expect(isRetriableTxError(new Error('boom'))).toBe(false)
  })

  // A failed gas estimate arrives under one code whether the node hiccuped or the call reverts.
  // Retrying a revert only spends the backoff and reports a settled outcome as a transient one.
  it('separates a reverting gas estimate from a flaky one', () => {
    const reverting = Object.assign(
      new Error('cannot estimate gas ... (error={"reason":"execution reverted","data":"0x4c3118d4"})'),
      { code: 'UNPREDICTABLE_GAS_LIMIT' },
    )
    expect(isRetriableTxError(reverting)).toBe(false)

    const flaky = Object.assign(new Error('cannot estimate gas; upstream timeout'), {
      code: 'UNPREDICTABLE_GAS_LIMIT',
    })
    expect(isRetriableTxError(flaky)).toBe(true)
  })
})
