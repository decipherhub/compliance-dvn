import type { Db } from '../db'
import type { PacketApprovalRow, RiskVerdictRow, TransferRow } from '../chain/events'

/**
 * All writes for one chain's scanned range, plus the reorg bookkeeping around them.
 *
 * Every insert is `ON CONFLICT DO NOTHING` keyed on (chain, tx_hash, log_index): re-scanning a
 * range is idempotent, which is what makes a rollback-and-rescan safe rather than duplicating
 * rows.
 */
export class IngestStore {
  constructor(private readonly db: Db) {}

  async getCursor(chain: string): Promise<number | undefined> {
    const res = await this.db.query<{ last_block: string }>(
      'SELECT last_block FROM scan_cursor WHERE chain = $1',
      [chain],
    )
    return res.rows.length ? Number(res.rows[0].last_block) : undefined
  }

  async setCursor(chain: string, block: number, db: Db = this.db): Promise<void> {
    await db.query(
      `INSERT INTO scan_cursor (chain, last_block) VALUES ($1, $2)
       ON CONFLICT (chain) DO UPDATE SET last_block = EXCLUDED.last_block`,
      [chain, block],
    )
  }

  async getBlockHash(chain: string, number: number): Promise<{ hash: string; parentHash: string } | undefined> {
    const res = await this.db.query<{ hash: string; parent_hash: string }>(
      'SELECT hash, parent_hash FROM blocks WHERE chain = $1 AND number = $2',
      [chain, number],
    )
    if (!res.rows.length) return undefined
    return { hash: res.rows[0].hash, parentHash: res.rows[0].parent_hash }
  }

  /**
   * The deepest block we recorded strictly below `height`.
   *
   * Only blocks we actually touched are recorded, so the reorg check cannot assume a record
   * exists at any given height. This gives it a real anchor to compare against instead.
   */
  async latestBlockBelow(
    chain: string,
    height: number,
  ): Promise<{ number: number; hash: string } | undefined> {
    const res = await this.db.query<{ number: string; hash: string }>(
      'SELECT number, hash FROM blocks WHERE chain = $1 AND number < $2 ORDER BY number DESC LIMIT 1',
      [chain, height],
    )
    if (!res.rows.length) return undefined
    return { number: Number(res.rows[0].number), hash: res.rows[0].hash }
  }

  async recordBlock(
    chain: string,
    number: number,
    hash: string,
    parentHash: string,
    blockTime: number,
    db: Db = this.db,
  ): Promise<void> {
    await db.query(
      `INSERT INTO blocks (chain, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chain, number) DO UPDATE
         SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash, block_time = EXCLUDED.block_time`,
      [chain, number, hash.toLowerCase(), parentHash.toLowerCase(), blockTime],
    )
  }

  /**
   * Discard everything at or above `fromBlock` for a chain.
   *
   * A reorg does not "update" rows, it invalidates them: the transactions that produced them may
   * simply not exist on the new canonical chain. Deleting and rescanning is the only correct
   * treatment, and it is cheap because the range is bounded by `REORG_DEPTH`.
   */
  async rollback(chain: string, fromBlock: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      let deleted = 0
      for (const table of ['edges', 'risk_verdicts', 'packet_approvals', 'blocks']) {
        const column = table === 'blocks' ? 'number' : 'block_number'
        const res = await tx.query(`DELETE FROM ${table} WHERE chain = $1 AND ${column} >= $2`, [chain, fromBlock])
        deleted += res.rowCount
      }
      await this.setCursor(chain, Math.max(0, fromBlock - 1), tx)
      return deleted
    })
  }

  /** Commit one scanned range atomically: rows and the cursor move together or not at all. */
  async commitRange(
    chain: string,
    toBlock: number,
    data: {
      verdicts: RiskVerdictRow[]
      approvals: PacketApprovalRow[]
      transfers: TransferRow[]
      blocks: Array<{ number: number; hash: string; parentHash: string; timestamp: number }>
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const b of data.blocks) await this.recordBlock(chain, b.number, b.hash, b.parentHash, b.timestamp, tx)

      for (const v of data.verdicts) {
        await tx.query(
          `INSERT INTO risk_verdicts
             (chain, block_number, tx_hash, log_index, payload_hash, action, score, reason_mask, evidence_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
          [chain, v.blockNumber, v.txHash, v.logIndex, v.payloadHash, v.action, v.score, v.reasonMask, v.evidenceHash],
        )
      }

      for (const a of data.approvals) {
        await tx.query(
          `INSERT INTO packet_approvals (chain, block_number, tx_hash, log_index, payload_hash, approver)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
          [chain, a.blockNumber, a.txHash, a.logIndex, a.payloadHash, a.approver],
        )
      }

      for (const t of data.transfers) {
        await tx.query(
          `INSERT INTO edges (chain, block_number, tx_hash, log_index, token, from_addr, to_addr, value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
          [chain, t.blockNumber, t.txHash, t.logIndex, t.token, t.from, t.to, t.value],
        )
      }

      await this.setCursor(chain, toBlock, tx)
    })
  }

  /** Replace the authoritative seed labels wholesale — a removed sanction must disappear. */
  async replaceSeeds(source: string, seeds: Array<{ subject: string; label: string }>): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM seed_labels WHERE source = $1', [source])
      for (const s of seeds) {
        await tx.query(
          `INSERT INTO seed_labels (subject, label, source) VALUES ($1, $2, $3)
           ON CONFLICT (subject, label, source) DO NOTHING`,
          [s.subject.toLowerCase(), s.label, source],
        )
      }
      return seeds.length
    })
  }

  /**
   * Replace the inbound thresholds wholesale from configuration.
   *
   * A replace, not an upsert: config is the only source of these values, so removing an entry
   * from the environment must actually remove the threshold. An upsert would leave a stale
   * minimum applying to a token the operator thought they had stopped labelling.
   */
  async replaceTokenMinimums(minimums: ReadonlyArray<{ chain: string; token: string; minValue: string }>): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM token_minimums')
      for (const m of minimums) {
        await tx.query('INSERT INTO token_minimums (chain, token, min_value) VALUES ($1, $2, $3)', [
          m.chain,
          m.token.toLowerCase(),
          m.minValue,
        ])
      }
      return minimums.length
    })
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const table of ['edges', 'risk_verdicts', 'packet_approvals', 'seed_labels']) {
      const res = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)
      out[table] = Number(res.rows[0]?.n ?? 0)
    }
    return out
  }
}
