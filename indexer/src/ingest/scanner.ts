import type { Logger } from 'pino'
import type { LogSource, PacketApprovalRow, RiskVerdictRow, TransferRow } from '../chain/events'
import { scanDvnEvents, scanTransfers } from '../chain/events'
import type { IngestStore } from './store'

export interface ScanChainDeps {
  chain: { key: string; dvn: string }
  source: LogSource
  store: IngestStore
  trackedTokens: readonly string[]
  confirmations: number
  /** How far back to start on a cold cursor. */
  scanWindow: number
  /** Maximum blocks per getLogs range. */
  scanChunk: number
  /** How far to unwind when the chain no longer matches what we stored. */
  reorgDepth: number
  logger: Logger
}

export interface ScanResult {
  from: number
  to: number
  verdicts: number
  approvals: number
  transfers: number
  reorgDepth: number
  /** Chain head as observed this tick — the only place it is read, and scan lag needs it. */
  head: number
}

/**
 * Detect a reorg and decide where to resume from, or undefined if the chain is unchanged.
 *
 * Comparing the recorded hash for a height against the node's current hash for that same height
 * is the only reliable signal — block numbers alone cannot tell you the chain was rewritten.
 *
 * On a mismatch we unwind a fixed `reorgDepth` window rather than searching for the exact fork
 * point. Only blocks we actually touched are recorded, so a search has no dense history to walk
 * and would stop early, leaving rows from reorged-away blocks in place. Rescanning a bounded
 * window is cheap and provably clears anything the rewrite invalidated.
 *
 * Whether the rewrite is deeper than that window is answered with a real anchor: the deepest
 * block we still have a record for below the window. If even that disagrees, rescanning the
 * window would leave stale rows underneath it, so we stop and say so.
 */
async function findReorg(deps: ScanChainDeps, cursor: number): Promise<number | undefined> {
  const { chain, source, store, logger } = deps

  const stored = await store.getBlockHash(chain.key, cursor)
  if (!stored) return undefined // nothing recorded to compare (cold start)
  const live = await source.getBlock(cursor)
  if (!live) return undefined // cursor above the current head; nothing to conclude
  if (live.hash.toLowerCase() === stored.hash) return undefined

  logger.warn(
    { chain: chain.key, height: cursor, stored: stored.hash, live: live.hash.toLowerCase() },
    'reorg: cursor block hash no longer matches',
  )

  const resumeFrom = Math.max(0, cursor - deps.reorgDepth + 1)
  if (resumeFrom > 0) {
    const anchor = await store.latestBlockBelow(chain.key, resumeFrom)
    if (anchor) {
      const anchorLive = await source.getBlock(anchor.number)
      if (anchorLive && anchorLive.hash.toLowerCase() !== anchor.hash) {
        throw new Error(
          `reorg deeper than REORG_DEPTH (${deps.reorgDepth}) on ${chain.key}: block ${anchor.number} also changed`,
        )
      }
    }
  }
  return resumeFrom
}

/**
 * Scan one chain once: handle any reorg, then ingest up to the safe head in bounded chunks.
 *
 * Only blocks below `head - confirmations` are read, which makes reorgs rare; the detection above
 * exists because rare is not never. The cursor advances per committed chunk, so an interruption
 * costs one chunk of rework rather than the whole range.
 */
export async function scanChainOnce(deps: ScanChainDeps): Promise<ScanResult> {
  const { chain, source, store, logger } = deps
  const log = logger.child({ chain: chain.key })

  const head = await source.getBlockNumber()
  const safeHead = head - deps.confirmations
  const stored = await store.getCursor(chain.key)

  let reorgUnwound = 0
  let cursor = stored ?? Math.max(0, safeHead - deps.scanWindow)
  if (stored !== undefined && stored > 0) {
    const resumeFrom = await findReorg(deps, stored)
    if (resumeFrom !== undefined) {
      const deleted = await store.rollback(chain.key, resumeFrom)
      reorgUnwound = stored - resumeFrom + 1
      cursor = resumeFrom - 1
      log.warn({ resumeFrom, deleted, unwound: reorgUnwound }, 'reorg: rolled back and will rescan')
    }
  }

  const result: ScanResult = { from: cursor + 1, to: cursor, verdicts: 0, approvals: 0, transfers: 0, reorgDepth: reorgUnwound, head }
  if (safeHead <= cursor) return result

  while (cursor < safeHead) {
    const from = cursor + 1
    const to = Math.min(from + deps.scanChunk - 1, safeHead)

    const [{ verdicts, approvals }, transfers] = await Promise.all([
      scanDvnEvents(source, chain.dvn, from, to),
      scanTransfers(source, deps.trackedTokens, from, to),
    ])

    // Record identity only for blocks we actually touched — enough for the reorg check at the
    // cursor without storing every empty block on the chain.
    const heights = new Set<number>([to, ...verdicts.map((v) => v.blockNumber), ...approvals.map((a) => a.blockNumber), ...transfers.map((t) => t.blockNumber)])
    const blocks: Array<{ number: number; hash: string; parentHash: string; timestamp: number }> = []
    for (const number of heights) {
      const block = await source.getBlock(number)
      if (block) blocks.push({ number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp })
    }

    await store.commitRange(chain.key, to, { verdicts, approvals, transfers, blocks })
    result.verdicts += verdicts.length
    result.approvals += approvals.length
    result.transfers += transfers.length
    result.to = to
    cursor = to
  }

  if (result.verdicts || result.approvals || result.transfers) {
    log.info(
      { from: result.from, to: result.to, verdicts: result.verdicts, approvals: result.approvals, transfers: result.transfers },
      'scanned',
    )
  }
  return result
}

export type { RiskVerdictRow, PacketApprovalRow, TransferRow }
