import 'dotenv/config'
import { ethers } from 'ethers'
import { loadConfig, type Config } from './config'
import { createLogger } from './logger'
import { createMetrics } from './metrics'
import { createPgDb } from './pg'
import { migrate } from './migrate'
import { IngestStore } from './ingest/store'
import { scanChainOnce } from './ingest/scanner'
import { refreshSeeds } from './ingest/seeds'
import { buildAndPublish, latestFeed } from './feed/builder'
import { refreshVerification } from './verify/refresh'
import { startHttpServer } from './http/server'
import type { LogSource } from './chain/events'

/** Sleep that resolves early when the abort signal fires, for prompt shutdown. */
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

/** Adapt an ethers provider to the narrow `LogSource` the scanner needs. */
function logSource(provider: ethers.providers.JsonRpcProvider): LogSource {
  return {
    getBlockNumber: () => provider.getBlockNumber(),
    getLogs: (filter) => provider.getLogs(filter as ethers.providers.Filter),
    getBlock: async (blockNumber) => {
      const block = await provider.getBlock(blockNumber)
      return block ? { hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp } : null
    },
  }
}

async function main(): Promise<void> {
  const config: Config = loadConfig()
  const logger = createLogger(config)
  const metrics = createMetrics()
  metrics.up.set(1)

  logger.info(
    {
      chains: config.chains.map((c) => c.key),
      trackedTokens: config.trackedTokens.length,
      policyVersion: config.policyVersion,
      feedSource: config.feedSource,
    },
    'compliance DVN indexer starting',
  )
  if (config.trackedTokens.length === 0) {
    logger.warn('TRACKED_TOKENS is empty — no transfer edges will be built, so the feed will be empty')
  }

  const db = createPgDb(config.databaseUrl)
  const ran = await migrate(db)
  if (ran.length) logger.info({ migrations: ran }, 'migrations applied')

  const store = new IngestStore(db)
  const sources: Record<string, LogSource> = {}
  const providers: Record<string, ethers.providers.JsonRpcProvider> = {}
  for (const chain of config.chains) {
    providers[chain.key] = new ethers.providers.JsonRpcProvider(chain.rpc)
    sources[chain.key] = logSource(providers[chain.key])
  }
  if (config.verifierUrl === '') {
    logger.warn('VERIFIER_URL is empty — source-verification lookups disabled, no unverified_contract labels')
  }

  // Inbound thresholds come from configuration and are replaced on every boot.
  await store.replaceTokenMinimums(config.tokenMinimums)
  logger.info(
    { minimums: config.tokenMinimums.map((m) => `${m.chain}:${m.token}=${m.minValue}`) },
    'inbound token thresholds applied',
  )

  // A tracked token with no threshold has its inbound edges recorded but never labelled, which is
  // easy to mistake for "no exposure found". Name the gap rather than leaving it silent.
  const withMinimum = new Set(config.tokenMinimums.map((m) => m.token))
  const missing = config.trackedTokens.filter((t) => !withMinimum.has(t))
  if (missing.length) {
    logger.warn(
      { tokens: missing },
      'tracked tokens have no TOKEN_MINIMUMS entry — their inbound edges will never produce sanctions_1hop_inbound',
    )
  }

  // Seeds first: proximity computed against an empty seed set would publish a feed that says
  // "nothing is near anything", which a consumer cannot distinguish from a clean graph.
  try {
    const seeds = await refreshSeeds(store)
    metrics.seedCount.set(seeds)
    metrics.seedRefreshTotal.inc({ result: 'success' })
    logger.info({ seeds }, 'seed labels loaded')
  } catch (err) {
    metrics.seedRefreshTotal.inc({ result: 'failure' })
    logger.error({ err: (err as Error).message }, 'initial seed load FAILED — refusing to publish a feed without seeds')
    await db.close()
    process.exit(1)
  }

  let running = true
  let scannedOnce = false
  const abort = new AbortController()
  const shutdown = (signal: string) => {
    if (!running) return
    logger.warn({ signal }, 'shutting down')
    running = false
    abort.abort()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const http = await startHttpServer({
    port: config.httpPort,
    metrics,
    logger,
    feed: () => latestFeed(db),
    isReady: () => running && scannedOnce,
  })

  let lastFeedAt = 0
  while (running) {
    for (const chain of config.chains) {
      if (!running) break
      try {
        const result = await scanChainOnce({
          chain,
          source: sources[chain.key],
          store,
          trackedTokens: config.trackedTokens,
          confirmations: config.confirmations,
          scanWindow: config.scanWindow,
          scanChunk: config.scanChunk,
          reorgDepth: config.reorgDepth,
          logger,
        })
        metrics.chainHeadBlock.set({ chain: chain.key }, result.head)
        metrics.cursorBlock.set({ chain: chain.key }, result.to)
        metrics.verdictsIngested.inc({ chain: chain.key }, result.verdicts)
        metrics.approvalsIngested.inc({ chain: chain.key }, result.approvals)
        metrics.edgesIngested.inc({ chain: chain.key }, result.transfers)
        if (result.reorgDepth > 0) {
          metrics.reorgs.inc({ chain: chain.key })
          metrics.reorgBlocksUnwound.inc({ chain: chain.key }, result.reorgDepth)
        }
      } catch (err) {
        // Per-chain isolation: one chain's RPC failure must not stop the others.
        metrics.scanErrors.inc({ chain: chain.key })
        logger.error({ chain: chain.key, err: (err as Error).message }, 'scan failed; will retry next tick')
      }

      // Verification is a bounded side quest, not part of ingest: a verifier outage must not stop
      // events being collected, so its failures never reach the scan error path.
      if (!running || config.verifierUrl === '') continue
      try {
        const verified = await refreshVerification({
          db,
          chain,
          reader: { getCode: (address) => providers[chain.key].getCode(address) },
          trackedTokens: config.trackedTokens,
          batchSize: config.verifyBatch,
          ttlSec: config.verifyTtlSec,
          sourcify: { baseUrl: config.verifierUrl },
          logger,
        })
        if (verified.inspected) {
          metrics.verificationChecked.inc({ chain: chain.key }, verified.inspected)
          metrics.verificationUnverified.set({ chain: chain.key }, verified.unverified)
          logger.info({ chain: chain.key, ...verified }, 'verification refreshed')
        }
      } catch (err) {
        logger.error({ chain: chain.key, err: (err as Error).message }, 'verification refresh failed')
      }
    }
    scannedOnce = true

    if (running && Date.now() - lastFeedAt >= config.feedRebuildMs) {
      try {
        const feed = await buildAndPublish(db, {
          source: config.feedSource,
          policyVersion: config.policyVersion,
          ttlSec: config.feedTtlSec,
          signingKey: config.feedSigningKey,
        })
        lastFeedAt = Date.now()
        metrics.feedVersion.set(feed.version)
        metrics.feedEntries.set(feed.entries.length)
        metrics.feedGeneratedAt.set(feed.generatedAt)
        metrics.feedBuildTotal.inc({ result: 'success' })
        logger.info({ version: feed.version, entries: feed.entries.length }, 'feed published')
      } catch (err) {
        metrics.feedBuildTotal.inc({ result: 'failure' })
        logger.error({ err: (err as Error).message }, 'feed build failed; serving the previous document')
      }
    }

    if (running) await interruptibleSleep(config.pollMs, abort.signal)
  }

  await http.close()
  await db.close()
  metrics.up.set(0)
  logger.info('indexer stopped')
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
