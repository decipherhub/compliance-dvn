import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client'

/** Typed metric surface. Each instance owns a private Registry so tests stay isolated. */
export interface Metrics {
  readonly registry: Registry

  readonly up: Gauge
  readonly chainHeadBlock: Gauge<'chain'>
  readonly cursorBlock: Gauge<'chain'>
  readonly scanErrors: Counter<'chain'>
  /** Reorgs observed, by how deep they went — a spike here questions every derived label. */
  readonly reorgs: Counter<'chain'>
  readonly reorgBlocksUnwound: Counter<'chain'>

  readonly verdictsIngested: Counter<'chain'>
  readonly approvalsIngested: Counter<'chain'>
  readonly edgesIngested: Counter<'chain'>

  readonly seedCount: Gauge
  readonly seedRefreshTotal: Counter<'result'>

  readonly verificationChecked: Counter<'chain'>
  readonly verificationUnverified: Gauge<'chain'>

  readonly feedVersion: Gauge
  readonly feedEntries: Gauge
  readonly feedGeneratedAt: Gauge
  readonly feedBuildTotal: Counter<'result'>
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service: 'compliance-dvn-indexer' })
  collectDefaultMetrics({ register: registry, prefix: 'indexer_node_' })

  const g = <T extends string = never>(name: string, help: string, labelNames: T[] = [] as T[]) =>
    new Gauge<T>({ name, help, labelNames, registers: [registry] })
  const c = <T extends string = never>(name: string, help: string, labelNames: T[] = [] as T[]) =>
    new Counter<T>({ name, help, labelNames, registers: [registry] })

  return {
    registry,
    up: g('indexer_up', 'Process is alive (1).'),
    chainHeadBlock: g('indexer_chain_head_block', 'Latest block height observed per chain.', ['chain']),
    cursorBlock: g('indexer_cursor_block', 'Last committed block per chain.', ['chain']),
    scanErrors: c('indexer_scan_errors_total', 'Scan/RPC errors per chain.', ['chain']),
    reorgs: c('indexer_reorgs_total', 'Reorgs detected per chain.', ['chain']),
    reorgBlocksUnwound: c('indexer_reorg_blocks_unwound_total', 'Blocks rolled back due to reorgs.', ['chain']),

    verdictsIngested: c('indexer_verdicts_ingested_total', 'RiskVerdict events stored.', ['chain']),
    approvalsIngested: c('indexer_approvals_ingested_total', 'PacketApproved events stored.', ['chain']),
    edgesIngested: c('indexer_edges_ingested_total', 'Transfer edges stored.', ['chain']),

    seedCount: g('indexer_seed_labels', 'Authoritative seed labels currently held.'),
    seedRefreshTotal: c('indexer_seed_refresh_total', 'Seed refresh attempts by result.', ['result']),

    verificationChecked: c('indexer_verification_checked_total', 'Addresses resolved for source verification.', ['chain']),
    verificationUnverified: g(
      'indexer_verification_unverified',
      'Contracts the verifier positively reported as unverified in the last pass.',
      ['chain'],
    ),

    feedVersion: g('indexer_feed_version', 'Version of the most recently published feed.'),
    feedEntries: g('indexer_feed_entries', 'Entry count in the most recently published feed.'),
    feedGeneratedAt: g('indexer_feed_generated_at', 'Unix seconds the newest feed was generated.'),
    feedBuildTotal: c('indexer_feed_build_total', 'Feed builds by result.', ['result']),
  }
}
