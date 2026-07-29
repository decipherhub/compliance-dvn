import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'

/**
 * Typed metric surface for the Compliance DVN. Each instance owns a private Registry so
 * tests stay isolated and there is no reliance on prom-client's global default registry.
 */
export interface Metrics {
  readonly registry: Registry

  // Liveness / readiness / fail-closed
  readonly up: Gauge
  readonly ready: Gauge
  readonly halted: Gauge<'reason'>

  // Denylist / risk store
  readonly denylistSize: Gauge<'source'>
  readonly denylistAgeSeconds: Gauge
  readonly denylistRefreshTotal: Counter<'result'>
  readonly sourceDegraded: Gauge<'source'>
  readonly feedRejectedTotal: Counter<'reason'>

  // Scan progress
  readonly chainHeadBlock: Gauge<'chain'>
  readonly checkpointBlock: Gauge<'chain'>
  readonly packetsScanned: Counter<'chain'>
  readonly packetsAssigned: Counter<'chain'>
  readonly scanErrors: Counter<'chain'>

  // Verification outcomes
  readonly verifications: Counter<'chain' | 'result'>
  readonly commits: Counter<'chain' | 'result'>
  readonly decisions: Counter<'chain' | 'action'>
  readonly pendingPackets: Gauge<'action'>
  readonly approvals: Counter<'chain'>
  readonly verdictRecords: Counter<'chain' | 'result'>
  readonly txSendSeconds: Histogram<'chain' | 'op'>
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service: 'compliance-dvn' })
  // Node/process metrics (event loop lag, heap, GC) — invaluable for prod debugging.
  collectDefaultMetrics({ register: registry, prefix: 'dvn_node_' })

  const g = <T extends string = never>(name: string, help: string, labelNames: T[] = [] as T[]) =>
    new Gauge<T>({ name, help, labelNames, registers: [registry] })
  const c = <T extends string = never>(name: string, help: string, labelNames: T[] = [] as T[]) =>
    new Counter<T>({ name, help, labelNames, registers: [registry] })

  return {
    registry,
    up: g('dvn_up', 'Process is alive (1).'),
    ready: g('dvn_ready', 'Worker is READY and verifying (1) vs HALTED/INITIALIZING (0).'),
    halted: g('dvn_halted', 'Fail-closed trip — verification withheld (1).', ['reason']),

    denylistSize: g('dvn_denylist_size', 'Denylist entries by source.', ['source']),
    denylistAgeSeconds: g('dvn_denylist_age_seconds', 'Seconds since the denylist was last built.'),
    denylistRefreshTotal: c('dvn_denylist_refresh_total', 'Denylist refresh attempts by result.', ['result']),
    sourceDegraded: g('dvn_source_degraded', 'A tolerated source is unavailable (1) — its labels are absent.', ['source']),
    feedRejectedTotal: c('dvn_feed_rejected_total', 'Indexer feeds rejected, by reason.', ['reason']),

    chainHeadBlock: g('dvn_chain_head_block', 'Latest block height observed per chain.', ['chain']),
    checkpointBlock: g('dvn_checkpoint_block', 'Last scanned block persisted per chain.', ['chain']),
    packetsScanned: c('dvn_packets_scanned_total', 'PacketSent events scanned per chain.', ['chain']),
    packetsAssigned: c('dvn_packets_assigned_total', 'Packets assigned to our DVN per chain.', ['chain']),
    scanErrors: c('dvn_scan_errors_total', 'Scan/RPC errors per chain.', ['chain']),

    verifications: c('dvn_verifications_total', 'submitVerification calls by result.', ['chain', 'result']),
    commits: c('dvn_commits_total', 'commitVerification calls by result.', ['chain', 'result']),
    decisions: c('dvn_decisions_total', 'Risk verdicts by action (allow/delay/manual-review/block).', ['chain', 'action']),
    pendingPackets: g('dvn_pending_packets', 'Packets currently held, by action.', ['action']),
    approvals: c('dvn_approvals_total', 'Owner approvals of held packets observed on-chain.', ['chain']),
    verdictRecords: c(
      'dvn_verdict_records_total',
      'Separate recordVerdict transactions by result. A failure means the outcome was enforced but not recorded.',
      ['chain', 'result'],
    ),
    txSendSeconds: new Histogram({
      name: 'dvn_tx_send_seconds',
      help: 'On-chain transaction send+mine latency (seconds).',
      labelNames: ['chain', 'op'],
      buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [registry],
    }),
  }
}
