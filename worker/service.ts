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
import { scanChainOnce, verifyPacket, processDeferred } from './runtime/scanner'
import { scanPacketSent, scanJobAssigned, scanPacketApproved } from './chain/events'
import { ethersReader } from './chain/reader'
import { RpcContractInspector, type ChainReader } from './assess/providers/contract'
import { RpcTokenInspector } from './assess/providers/token'
import { buildRiskStore, refreshFeedInto } from './assess/assess'
import type { RiskAction } from './assess/policy'
import { FeedError } from './assess/ingest/feed'
import { Checkpoint } from './checkpoint'
import { briefError } from './runtime/errors'

const SCAN_WINDOW = Number(process.env.SCAN_BACKFILL_BLOCKS || 50)
const SCAN_CHUNK = Number(process.env.SCAN_CHUNK_BLOCKS || 2000)

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
  // forbidOwnerKeys: the service must never share an environment with an owner-capable key —
  // the owner key is what approves the packets this process withholds.
  const config: Config = loadConfig(process.env, { forbidOwnerKeys: true })
  const logger = createLogger(config)
  const metrics = createMetrics()
  metrics.up.set(1)

  logger.info(
    {
      chains: config.chains.map((c) => c.key),
      pollMs: config.pollMs,
      confirmations: config.confirmations,
      scanConfirmations: config.scanConfirmations,
    },
    'compliance DVN worker starting',
  )

  // Providers + signers per chain.
  const providers: Record<string, ethers.providers.JsonRpcProvider> = {}
  const signers: Record<string, ethers.Wallet> = {}
  const senders: Record<string, TxSender> = {}
  for (const chain of config.chains) {
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const signer = new ethers.Wallet(config.operatorPrivateKey, provider)
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

  // Live chain checks, one reader per chain (a packet's parties span both sides).
  const readers: Record<string, ChainReader> = {}
  for (const chain of config.chains) readers[chain.key] = ethersReader(providers[chain.key])
  const riskProviders = {
    contracts: new RpcContractInspector({ readers }),
    tokens: new RpcTokenInspector({ readers }),
  }

  // The checkpoint doubles as the feed's replay-protection store, so it must exist before the
  // first build rather than after it.
  const checkpoint = new Checkpoint(config.checkpointPath)

  const feed = config.indexerFeedUrl
    ? { url: config.indexerFeedUrl, signers: [...config.indexerSigners], maxSkewSec: config.feedMaxSkewSec }
    : undefined
  if (feed) {
    logger.info({ url: feed.url, signers: feed.signers.length, degradedMode: config.degradedMode }, 'indexer feed enabled')
  } else {
    logger.warn('no INDEXER_FEED_URL — running on authoritative sources only, no graph labels')
  }

  // Shared by the full rebuild and the feed-only refresh, so both apply the same replay protection
  // and report a rejection the same way.
  const feedOptions = {
    feed,
    feedDeps: {
      versions: {
        get: (source: string) => checkpoint.getFeedVersion(source),
        set: (source: string, version: number) => {
          checkpoint.setFeedVersion(source, version)
          checkpoint.save()
        },
      },
    },
    onDegraded: (source: string, err: Error) => {
      const reason = err instanceof FeedError ? err.reason : 'fetch_failed'
      metrics.feedRejectedTotal.inc({ reason })
      logger.error({ source, reason, err: err.message }, 'risk source unavailable — running degraded')
    },
  }

  // Denylist lifecycle (fail-closed state machine).
  const denylist = new DenylistManager({
    build: () => buildRiskStore(feedOptions),
    // A newly published graph label should be usable in seconds; re-downloading the sanctions
    // lists that often would not be.
    refreshFeed: (store) => refreshFeedInto(store, feedOptions),
    refreshMs: config.denylistRefreshMs,
    feedRefreshMs: config.feedRefreshMs,
    maxStalenessMs: config.maxDenylistStalenessMs,
    degradedMode: config.degradedMode,
    providers: riskProviders,
    logger,
    metrics,
  })
  await denylist.start()
  const actions = createActions(signers, senders, config.confirmations)
  const byEid = new Map<number, ResolvedChain>(config.chains.map((c) => [c.eid, c]))
  const resolveDst = (eid: number) => byEid.get(eid)
  const emitVerdictFor = new Set<RiskAction>(config.emitVerdictFor)
  logger.info({ emitVerdictFor: config.emitVerdictFor }, 'verdict events: allow always rides on submitVerification')

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
  const http = await startHttpServer({
    port: config.httpPort,
    metrics,
    isReady,
    status: () => ({
      state: denylist.state,
      degraded: [...denylist.degraded],
      denylistAgeMs: denylist.ageMs(),
      chains: config.chains.map((c) => ({ key: c.key, eid: c.eid, dvn: c.dvn })),
    }),
    pending: () => ({
      pending: checkpoint.deferredEntries().map(([key, r]) => ({
        key,
        ...r,
        approved: checkpoint.isApproved(r.payloadHash),
      })),
    }),
    logger,
  })
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
          confirmations: config.scanConfirmations,
          scanWindow: SCAN_WINDOW,
          scanChunk: SCAN_CHUNK,
          state: () => denylist.state,
          checkpoint,
          scanAssigned: (from, to) => scanJobAssigned(providers[chain.key], chain.dvn, from, to),
          scanPackets: (from, to) =>
            scanPacketSent(providers[chain.key], chain.endpoint, from, to, (payloadHash, reason) => {
              metrics.packetsUnparsed.inc({ chain: chain.key })
              logger.debug({ chain: chain.key, payloadHash, reason }, 'skipped undecodable packet (not an OFT transfer)')
            }),
          scanApproved: (from, to) => scanPacketApproved(providers[chain.key], chain.dvn, from, to),
          handlePacket: (p) =>
            verifyPacket(p, {
              assessor: denylist.assessor(),
              resolveDst,
              verify: actions.verify,
              commit: actions.commit,
              recordVerdict: actions.recordVerdict,
              execute: actions.execute,
              commitState: actions.commitState,
              emitVerdictFor,
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
        logger.error({ chain: chain.key, err: briefError(err) }, 'scan failed; will retry next tick')
      }
    }

    // Reconsider held packets after scanning, so an approval seen this tick is acted on in it.
    // Only when READY — re-screening needs a fresh risk store just as first screening does.
    if (running && denylist.state === 'READY') {
      try {
        await processDeferred({
          assessor: denylist.assessor(),
          resolveDst,
          verify: actions.verify,
          commit: actions.commit,
          recordVerdict: actions.recordVerdict,
          execute: actions.execute,
          commitState: actions.commitState,
          // Only the deferred pass needs this: a packet is screened live before anyone could have
          // rejected it, so the check would be a wasted read on the hot path.
          abandoned: actions.abandoned,
          emitVerdictFor,
          checkpoint,
          metrics,
          logger,
        })
      } catch (err) {
        logger.error({ err: briefError(err) }, 'deferred-queue pass failed; will retry next tick')
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
