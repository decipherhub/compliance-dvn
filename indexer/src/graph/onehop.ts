import type { Db } from '../db'

/**
 * One-hop proximity to the seed set.
 *
 * Depth is 1 by policy: the DVN screens a packet's own counterparties, and deeper reach is not
 * something a compliance decision should rest on. Depth 1 also keeps this a plain join rather
 * than a recursive traversal, which matters at scan volume.
 *
 * Direction is what makes it dusting-resistant, and the asymmetry is deliberate:
 *
 *  - OUTBOUND (subject -> seed) is the subject's own act. No threshold; sending anything at all
 *    to a sanctioned address is the signal.
 *  - INBOUND (seed -> subject) is something done TO the subject. Anyone can push a tainted
 *    transfer at a victim to poison their address, so an inbound edge counts only above a
 *    per-token minimum. A token with no configured minimum never produces an inbound label —
 *    the edge is still stored, it just is not treated as evidence.
 */

/**
 * Traversal depth, fixed at 1 by agreed policy — it matches `N_HOP.depth` in the worker's
 * `assess/policy.ts`.
 *
 * Stated as a constant so the choice is declared rather than implied by the shape of the queries
 * below. Raising it is a policy decision, not a refactor: it changes what the DVN is willing to
 * refuse a transfer over, and every added hop multiplies both the false-positive rate and the
 * query cost. A second hop would also need its own weight and threshold, since "two hops from a
 * sanctioned address" is much weaker evidence than one.
 */
export const GRAPH_DEPTH = 1

export interface OneHopLabel {
  subject: string
  label: string
}

export const SEED_LABEL_TO_OUTBOUND: Record<string, string> = {
  sanctions: 'sanctions_1hop',
  sanctioned_mixer: 'mixer_exposure',
}

export const SEED_LABEL_TO_INBOUND: Record<string, string> = {
  sanctions: 'sanctions_1hop_inbound',
  sanctioned_mixer: 'mixer_exposure',
}

/**
 * Subjects that sent to a seed. No value threshold, and the seed itself is excluded so a
 * sanctioned address moving funds does not label itself as merely "near" one.
 */
export async function outboundLabels(db: Db): Promise<OneHopLabel[]> {
  // The seed exclusion is a LEFT JOIN anti-join rather than a correlated NOT EXISTS: same
  // result, one less dependent subquery per row, and it stays inside the SQL subset the
  // in-memory Postgres used by the tests can execute.
  const res = await db.query<{ subject: string; seed_label: string }>(
    `SELECT DISTINCT e.from_addr AS subject, s.label AS seed_label
       FROM edges e
       JOIN seed_labels s      ON s.subject = e.to_addr
       LEFT JOIN seed_labels z ON z.subject = e.from_addr
      WHERE e.from_addr <> e.to_addr
        AND z.subject IS NULL`,
  )
  return mapLabels(res.rows, SEED_LABEL_TO_OUTBOUND)
}

/**
 * Subjects that received from a seed, above the token's configured minimum.
 *
 * The join to `token_minimums` is an inner join on purpose: no minimum configured means no label.
 * A left join with a permissive default would turn every dust transfer into evidence, which is
 * precisely the attack this guards against.
 */
export async function inboundLabels(db: Db): Promise<OneHopLabel[]> {
  const res = await db.query<{ subject: string; seed_label: string }>(
    `SELECT DISTINCT e.to_addr AS subject, s.label AS seed_label
       FROM edges e
       JOIN seed_labels s      ON s.subject = e.from_addr
       JOIN token_minimums m   ON m.chain = e.chain AND m.token = e.token
       LEFT JOIN seed_labels z ON z.subject = e.to_addr
      WHERE e.from_addr <> e.to_addr
        AND e.value >= m.min_value
        AND z.subject IS NULL`,
  )
  return mapLabels(res.rows, SEED_LABEL_TO_INBOUND)
}

function mapLabels(
  rows: Array<{ subject: string; seed_label: string }>,
  mapping: Record<string, string>,
): OneHopLabel[] {
  const out: OneHopLabel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const label = mapping[row.seed_label]
    if (!label) continue
    const key = `${row.subject}|${label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ subject: row.subject, label })
  }
  return out
}

/** All one-hop labels, merged so each subject appears once with its full label set. */
export async function computeOneHop(db: Db): Promise<Array<{ subject: string; labels: string[] }>> {
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

/** How many distinct seeds a subject touched, for dashboards. */
export async function exposureCounts(db: Db): Promise<Array<{ subject: string; seeds: number }>> {
  const res = await db.query<{ subject: string; seeds: string }>(
    `SELECT subject, count(DISTINCT seed) AS seeds FROM (
        SELECT e.from_addr AS subject, e.to_addr AS seed
          FROM edges e JOIN seed_labels s ON s.subject = e.to_addr
        UNION
        SELECT e.to_addr AS subject, e.from_addr AS seed
          FROM edges e
          JOIN seed_labels s    ON s.subject = e.from_addr
          JOIN token_minimums m ON m.chain = e.chain AND m.token = e.token
         WHERE e.value >= m.min_value
     ) t
     GROUP BY subject`,
  )
  return res.rows.map((r) => ({ subject: r.subject, seeds: Number(r.seeds) }))
}
