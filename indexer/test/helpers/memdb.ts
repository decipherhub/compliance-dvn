import { newDb } from 'pg-mem'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Db, QueryResult } from '../../src/db'

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations')

/**
 * An in-memory Postgres for tests, so the SQL is genuinely executed rather than mocked.
 *
 * pg-mem is not a complete Postgres, but it covers the joins, `ON CONFLICT`, and numeric
 * comparisons this schema relies on — which is the part worth testing. Anything it cannot run
 * would fail loudly here rather than in production.
 */
export function memDb(): Db & { raw: ReturnType<typeof newDb> } {
  const mem = newDb()
  const backend = mem.public

  const db: Db & { raw: ReturnType<typeof newDb> } = {
    raw: mem,
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const rows = params.length ? backend.many(substitute(sql, params)) : runMaybe(backend, sql)
      const list = Array.isArray(rows) ? rows : []
      return { rows: list as T[], rowCount: list.length }
    },
    // pg-mem has no real transaction isolation for our purposes; running inline is enough to
    // exercise the statements, and the atomicity itself is a Postgres guarantee, not our logic.
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
    close: async () => {},
  }
  return db
}

/** Statements that legitimately return nothing (DDL, DELETE, INSERT) must not throw on `many`. */
function runMaybe(backend: ReturnType<typeof newDb>['public'], sql: string): unknown[] {
  const result = backend.query(sql)
  return result.rows ?? []
}

/**
 * Inline `$n` parameters, because pg-mem's public API takes plain SQL.
 *
 * Test-only: values are quoted defensively, but nothing here ever sees untrusted input.
 */
function substitute(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, idx: string) => literal(params[Number(idx) - 1]))
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

/** Apply every shipped migration in order, so tests run against the real schema. */
export function applySchema(db: Db & { raw: ReturnType<typeof newDb> }): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.raw.public.none(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

export async function seedFixture(
  db: Db,
  rows: {
    seeds?: Array<{ subject: string; label: string; source?: string }>
    edges?: Array<{
      chain?: string
      block?: number
      tx?: string
      logIndex?: number
      token: string
      from: string
      to: string
      value: string
    }>
    minimums?: Array<{ chain?: string; token: string; min: string }>
  },
): Promise<void> {
  for (const s of rows.seeds ?? []) {
    await db.query('INSERT INTO seed_labels (subject, label, source) VALUES ($1, $2, $3)', [
      s.subject.toLowerCase(),
      s.label,
      s.source ?? 'ofac',
    ])
  }
  let i = 0
  for (const e of rows.edges ?? []) {
    i++
    await db.query(
      `INSERT INTO edges (chain, block_number, tx_hash, log_index, token, from_addr, to_addr, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.chain ?? 'baseSepolia',
        e.block ?? 100,
        e.tx ?? `0x${String(i).padStart(64, '0')}`,
        e.logIndex ?? 0,
        e.token.toLowerCase(),
        e.from.toLowerCase(),
        e.to.toLowerCase(),
        e.value,
      ],
    )
  }
  for (const m of rows.minimums ?? []) {
    await db.query('INSERT INTO token_minimums (chain, token, min_value) VALUES ($1, $2, $3)', [
      m.chain ?? 'baseSepolia',
      m.token.toLowerCase(),
      m.min,
    ])
  }
}
