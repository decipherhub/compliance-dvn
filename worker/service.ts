import 'dotenv/config'
import { ethers } from 'ethers'
import { loadConfig, Config, ResolvedChain } from './runtime/config'
import { createLogger } from './runtime/logger'
import { createMetrics } from './runtime/metrics'
import { startHttpServer } from './runtime/http'
import { DenylistManager } from './runtime/denylist-manager'
import { TxSender } from './runtime/tx-sender'
import { Lifecycle } from './runtime/lifecycle'
import { createActions } from './runtime/actions'
import { scanChainOnce, verifyPacket } from './runtime/scanner'
import { scanPacketSent, scanJobAssigned } from './chain/events'
import { Checkpoint } from './checkpoint'

const SCAN_WINDOW = Number(process.env.SCAN_BACKFILL_BLOCKS || 50)

/** Sleep that resolves early when the abort signal fires (for prompt shutdown). */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function main(): Promise<void> {
  const config: Config = loadConfig()
  const logger = createLogger(config)
  const metrics = createMetrics()
  metrics.up.set(1)

  logger.info(
    { chains: config.chains.map((c) => c.key), pollMs: config.pollMs, confirmations: config.confirmations },
    'compliance DVN worker starting',
  )

  // Providers + signers per chain.
  const providers: Record<string, ethers.providers.JsonRpcProvider> = {}
  const signers: Record<string, ethers.Wallet> = {}
  const senders: Record<string, TxSender> = {}
  for (const chain of config.chains) {
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const signer = new ethers.Wallet(config.privateKey, provider)
    providers[chain.key] = provider
    signers[chain.key] = signer
    senders[chain.key] = new TxSender({
      chain: chain.key,
      address: signer.address,
      getTransactionCount: (addr) => provider.getTransactionCount(addr, 'pending'),
      getGasPrice: async () => (await provider.getGasPrice()).toBigInt(),
      maxRetries: config.txMaxRetries,
      gasBumpPct: config.txGasBumpPct,
      logger,
      metrics,
    })
  }

  // Denylist lifecycle (fail-closed state machine).
  const denylist = new DenylistManager({
    refreshMs: config.denylistRefreshMs,
    maxStalenessMs: config.maxDenylistStalenessMs,
    logger,
    metrics,
  })
  await denylist.start()

  const checkpoint = new Checkpoint(config.checkpointPath)
  const actions = createActions(signers, senders, config.confirmations)
  const byEid = new Map<number, ResolvedChain>(config.chains.map((c) => [c.eid, c]))
  const resolveDst = (eid: number) => byEid.get(eid)

  // Lifecycle + control plane.
  const abort = new AbortController()
  let running = true
  const lifecycle = new Lifecycle({ logger })
  lifecycle.onShutdown(() => {
    running = false
    abort.abort()
  })
  lifecycle.onShutdown(() => denylist.stop())
  lifecycle.onShutdown(() => {
    checkpoint.save()
    logger.info('checkpoint persisted')
  })

  const isReady = () => running && denylist.state === 'READY'
  const http = await startHttpServer({ port: config.httpPort, metrics, isReady, logger })
  lifecycle.onShutdown(() => http.close())
  lifecycle.install()

  // Poll loop — a thin orchestrator over the runtime pieces.
  while (running) {
    denylist.evaluate() // refresh staleness -> may flip READY/HALTED
    for (const chain of config.chains) {
      if (!running) break
      try {
        await scanChainOnce({
          chain,
          provider: providers[chain.key],
          confirmations: config.confirmations,
          scanWindow: SCAN_WINDOW,
          state: () => denylist.state,
          checkpoint,
          scanAssigned: (from, to) => scanJobAssigned(providers[chain.key], chain.dvn, from, to),
          scanPackets: (from, to) => scanPacketSent(providers[chain.key], chain.endpoint, from, to),
          handlePacket: (p) =>
            verifyPacket(p, {
              assessor: denylist.assessor(),
              resolveDst,
              verify: actions.verify,
              commit: actions.commit,
              checkpoint,
              metrics,
              logger,
              srcChainKey: chain.key,
            }),
          metrics,
          logger,
        })
      } catch (err) {
        // Per-chain isolation: one chain's RPC failure must not stop the others.
        logger.error({ chain: chain.key, err: (err as Error).message }, 'scan failed; will retry next tick')
      }
    }
    if (running) await interruptibleSleep(config.pollMs, abort.signal)
  }

  metrics.up.set(0)
  logger.info('worker stopped')
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
