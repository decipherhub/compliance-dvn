import type { Logger } from 'pino'
import type { Metrics } from './metrics'
import { briefError } from './errors'

/** Minimal shape of a submitted transaction we depend on (a subset of ethers' response). */
export interface SubmittedTx {
  hash: string
  wait(confirmations?: number): Promise<{ transactionHash: string }>
}

export interface TxOverrides {
  nonce: number
  gasPrice: bigint
}

export type BuildTx = (overrides: TxOverrides) => Promise<SubmittedTx>

export interface TxSenderDeps {
  chain: string
  address: string
  getTransactionCount: (address: string) => Promise<number>
  getGasPrice: () => Promise<bigint>
  maxRetries: number
  gasBumpPct: number
  logger: Logger
  metrics: Metrics
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  baseBackoffMs?: number
}

const RETRIABLE_CODES = new Set([
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'REPLACEMENT_UNDERPRICED',
  'NONCE_EXPIRED',
  'UNPREDICTABLE_GAS_LIMIT',
])
const NONCE_CODES = new Set(['NONCE_EXPIRED'])
const RETRIABLE_MESSAGE = /(timeout|timed out|underpriced|replacement|nonce|econnreset|etimedout|socket hang up|503|502|rate.?limit)/i
/**
 * A gas estimate can fail two ways that ethers reports under one code.
 *
 * `UNPREDICTABLE_GAS_LIMIT` covers both a flaky node and a call the chain simply rejects. Only the
 * first is worth retrying: a reverting call reverts at any gas price, so escalating gas through
 * every attempt just spends the backoff and reports a determined outcome as a transient one.
 */
const REVERTED = /execution reverted/i

/** True for transient infra/gas/nonce errors that a bump-and-retry can plausibly fix. */
export function isRetriableTxError(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  if (e?.code === 'UNPREDICTABLE_GAS_LIMIT' && REVERTED.test(e.message ?? '')) return false
  if (e?.code && RETRIABLE_CODES.has(e.code)) return true
  if (e?.code === 'CALL_EXCEPTION') return false // on-chain revert — retrying won't help
  return !!e?.message && RETRIABLE_MESSAGE.test(e.message)
}

function isNonceError(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return (!!e?.code && NONCE_CODES.has(e.code)) || (!!e?.message && /nonce/i.test(e.message))
}

/**
 * Sends transactions for a single signer with production safety: locally-tracked sequential
 * nonces (one writer per worker), escalating gas on each retry, bounded retry/backoff, and
 * latency metrics. Network/gas/nonce hiccups retry; on-chain reverts fail fast.
 */
export class TxSender {
  private trackedNonce: number | undefined
  /** Serializes sends so local nonce tracking is race-free even under concurrent callers. */
  private queue: Promise<void> = Promise.resolve()
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly baseBackoffMs: number

  constructor(private readonly deps: TxSenderDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = deps.now ?? Date.now
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000
  }

  /** Public entry: enqueue the send so nonce assignment never interleaves across callers. */
  send(op: string, build: BuildTx): Promise<string> {
    const result = this.queue.then(() => this.doSend(op, build))
    // Keep the queue chain alive regardless of this send's success/failure.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async doSend(op: string, build: BuildTx): Promise<string> {
    const log = this.deps.logger.child({ chain: this.deps.chain, op })
    let nonce = await this.nextNonce()
    const basePrice = await this.deps.getGasPrice()
    const started = this.now()

    for (let attempt = 0; ; attempt++) {
      const gasPrice = this.bumpedPrice(basePrice, attempt)
      try {
        const tx = await build({ nonce, gasPrice })
        const receipt = await tx.wait()
        this.trackedNonce = nonce + 1
        this.deps.metrics.txSendSeconds.observe({ chain: this.deps.chain, op }, (this.now() - started) / 1000)
        return receipt.transactionHash
      } catch (err) {
        const retriable = isRetriableTxError(err)
        if (!retriable || attempt >= this.deps.maxRetries) {
          // Drop the cached nonce so the next send re-syncs from the chain.
          this.trackedNonce = undefined
          log.error(
            { err: briefError(err), attempt, retriable, nonce },
            'transaction send failed',
          )
          throw err
        }
        if (isNonceError(err)) {
          this.trackedNonce = undefined
          nonce = await this.nextNonce()
        }
        const backoff = this.baseBackoffMs * 2 ** attempt
        log.warn(
          { err: briefError(err), attempt, nextNonce: nonce, gasPrice: gasPrice.toString(), backoffMs: backoff },
          'transaction send failed; retrying with higher gas',
        )
        await this.sleep(backoff)
      }
    }
  }

  private async nextNonce(): Promise<number> {
    if (this.trackedNonce === undefined) {
      this.trackedNonce = await this.deps.getTransactionCount(this.deps.address)
    }
    return this.trackedNonce
  }

  private bumpedPrice(base: bigint, attempt: number): bigint {
    if (attempt === 0) return base
    return (base * BigInt(100 + this.deps.gasBumpPct * attempt)) / 100n
  }
}
