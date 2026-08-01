import type { Db } from '../db'

/**
 * Proximity to the seed set, up to `GRAPH_DEPTH` hops.
 *
 * Direction is what makes it dusting-resistant, and the asymmetry is deliberate:
 *
 *  - OUTBOUND (subject -> ... -> seed) starts with the subject's own act. The first edge needs
 *    no threshold; every edge after it is someone ELSE's act, so it must clear the per-token
 *    minimum — otherwise anyone the subject ever paid could smear them by dusting a sanctioned
 *    address.
 *  - INBOUND (seed -> ... -> subject) is something done TO the subject at every step, so every
 *    edge must clear the minimum. A token with no configured minimum never extends a path —
 *    the edge is still stored, it just is not treated as evidence.
 *
 * A path only counts if the funds could actually have flowed along it: hops stay on one chain
 * and block numbers never decrease. It must also be a simple path (no vertex twice), and no
 * seed may appear anywhere but the far endpoint — a route through a second sanctioned address
 * is that address's shorter proximity, not this one's.
 */

/**
 * Traversal depth. Matches `N_HOP.depth` in the worker's `assess/policy.ts`.
 *
 * Stated as a constant so the choice is declared rather than implied by the shape of the
 * queries below. Changing it is a policy decision, not a refactor: each hop carries its own
 * label and weight (evidence weakens fast with distance), so a new depth needs new entries in
 * the ladders below AND in the worker's `LABEL_WEIGHTS`/`REASON_BITS`, plus a `POLICY_VERSION`
 * bump on both sides.
 */
export const GRAPH_DEPTH = 3

/**
 * The zero address, excluded from every path.
 *
 * ERC-20 mints and burns are Transfer events to/from it. Left in, it becomes a hub joining every
 * holder to every other one, and paths route THROUGH it: "B burned, then the token minted to C,
 * then C paid a sanctioned address" would label B at 3 hops on the strength of two unrelated
 * supply events. It is not a counterparty, so it is not a vertex.
 *
 * A cross-chain send is such a burn/mint pair, which once made bridged transfers invisible here.
 * They are no longer inferred from the pair: the source chain's `OFTSent` and `PacketSent` name the
 * real sender and recipient, and the scanner stores that as a `bridge` edge between them.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface GraphLabel {
  subject: string
  label: string
}

/** Label per seed class and depth (index = depth - 1). Weights live in the worker's policy. */
export const OUTBOUND_LABELS: Record<string, readonly string[]> = {
  sanctions: ['sanctions_1hop', 'sanctions_2hop', 'sanctions_3hop'],
  sanctioned_mixer: ['mixer_exposure', 'mixer_exposure_2hop', 'mixer_exposure_3hop'],
}

export const INBOUND_LABELS: Record<string, readonly string[]> = {
  sanctions: ['sanctions_1hop_inbound', 'sanctions_2hop_inbound', 'sanctions_3hop_inbound'],
  sanctioned_mixer: ['mixer_exposure', 'mixer_exposure_2hop', 'mixer_exposure_3hop'],
}

type Direction = 'outbound' | 'inbound'

/**
 * One direction-and-depth path query, assembled rather than written out six times.
 *
 * Kept to plain joins and LEFT JOIN anti-joins on purpose: the in-memory Postgres the tests run
 * against does not execute recursive CTEs, and at depth <= 3 the explicit form is also the one
 * the planner handles predictably. Vertices are v0 = e1.from_addr and vi = ei.to_addr.
 */
function pathSql(direction: Direction, depth: number): string {
  const vertex = (i: number) => (i === 0 ? 'e1.from_addr' : `e${i}.to_addr`)
  const seedVertex = direction === 'outbound' ? depth : 0
  const subject = direction === 'outbound' ? vertex(0) : vertex(depth)

  const joins: string[] = []
  const where: string[] = []

  for (let i = 2; i <= depth; i++) {
    // Same chain, forward in time: the path must be one funds could actually have taken.
    //
    // A bridge edge is never continued. Its `to_addr` received on ANOTHER chain, so that address's
    // activity here is somebody else's money — following it would invent a path. A bridge edge can
    // therefore only be a path's last hop (or its only one), which is where the evidence is anyway:
    // the subject's own act of sending toward a seed. Continuing across the bridge properly needs
    // per-edge timestamps, since block numbers do not compare between chains.
    joins.push(
      `JOIN edges e${i} ON e${i}.chain = e${i - 1}.chain AND e${i}.from_addr = e${i - 1}.to_addr` +
        ` AND e${i}.block_number >= e${i - 1}.block_number AND e${i - 1}.kind <> 'bridge'`,
    )
  }
  for (let i = 1; i <= depth; i++) {
    // The minimum applies to every edge that is not the subject's own act.
    if (direction === 'inbound' || i > 1) {
      joins.push(
        `JOIN token_minimums m${i} ON m${i}.chain = e${i}.chain AND m${i}.token = e${i}.token` +
          ` AND e${i}.value >= m${i}.min_value`,
      )
    }
  }

  joins.push(`JOIN seed_labels s ON s.subject = ${vertex(seedVertex)}`)

  // Simple path: every vertex distinct from every other, and never mint/burn.
  for (let a = 0; a <= depth; a++) {
    where.push(`${vertex(a)} <> '${ZERO_ADDRESS}'`)
    for (let b = a + 1; b <= depth; b++) where.push(`${vertex(a)} <> ${vertex(b)}`)
  }

  // No seed anywhere but the far endpoint.
  let z = 0
  for (let i = 0; i <= depth; i++) {
    if (i === seedVertex) continue
    z++
    joins.push(`LEFT JOIN seed_labels z${z} ON z${z}.subject = ${vertex(i)}`)
    where.push(`z${z}.subject IS NULL`)
  }

  return `SELECT DISTINCT ${subject} AS subject, s.label AS seed_label
     FROM edges e1
     ${joins.join('\n     ')}
    WHERE ${where.join('\n      AND ')}`
}

/**
 * Labels for one direction, shortest distance first.
 *
 * A subject with both a direct edge and a longer route to the same seed class is labelled at
 * its closest approach only — the label states how near the subject came, and scoring the same
 * fact once per route would inflate it.
 */
async function pathLabels(db: Db, direction: Direction): Promise<GraphLabel[]> {
  const ladder = direction === 'outbound' ? OUTBOUND_LABELS : INBOUND_LABELS
  const best = new Map<string, number>()
  for (let depth = 1; depth <= GRAPH_DEPTH; depth++) {
    const res = await db.query<{ subject: string; seed_label: string }>(pathSql(direction, depth))
    for (const row of res.rows) {
      const key = `${row.subject}|${row.seed_label}`
      if (!best.has(key)) best.set(key, depth) // ascending depth loop -> first hit is shortest
    }
  }

  const out: GraphLabel[] = []
  for (const [key, depth] of best) {
    const [subject, seedLabel] = key.split('|')
    const label = ladder[seedLabel]?.[depth - 1]
    if (label) out.push({ subject, label })
  }
  return out
}

/** Subjects that sent toward a seed within GRAPH_DEPTH hops. */
export function outboundLabels(db: Db): Promise<GraphLabel[]> {
  return pathLabels(db, 'outbound')
}

/** Subjects that received from a seed within GRAPH_DEPTH hops, every edge above its minimum. */
export function inboundLabels(db: Db): Promise<GraphLabel[]> {
  return pathLabels(db, 'inbound')
}

/** All proximity labels, merged so each subject appears once with its full label set. */
export async function computeProximity(db: Db): Promise<Array<{ subject: string; labels: string[] }>> {
  const [outbound, inbound] = await Promise.all([outboundLabels(db), inboundLabels(db)])
  const bySubject = new Map<string, Set<string>>()
  for (const { subject, label } of [...outbound, ...inbound]) {
    const set = bySubject.get(subject) ?? new Set<string>()
    set.add(label)
    bySubject.set(subject, set)
  }
  return [...bySubject.entries()]
    .map(([subject, labels]) => ({ subject, labels: [...labels].sort() }))
    .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
}

/** How many distinct seeds a subject touched directly (depth 1), for dashboards. */
export async function exposureCounts(db: Db): Promise<Array<{ subject: string; seeds: number }>> {
  const res = await db.query<{ subject: string; seeds: string }>(
    `SELECT subject, count(DISTINCT seed) AS seeds FROM (
        SELECT e.from_addr AS subject, e.to_addr AS seed
          FROM edges e JOIN seed_labels s ON s.subject = e.to_addr
         WHERE e.from_addr <> '${ZERO_ADDRESS}'
        UNION
        SELECT e.to_addr AS subject, e.from_addr AS seed
          FROM edges e
          JOIN seed_labels s    ON s.subject = e.from_addr
          JOIN token_minimums m ON m.chain = e.chain AND m.token = e.token
         WHERE e.value >= m.min_value
           AND e.to_addr <> '${ZERO_ADDRESS}'
     ) t
     GROUP BY subject`,
  )
  return res.rows.map((r) => ({ subject: r.subject, seeds: Number(r.seeds) }))
}
