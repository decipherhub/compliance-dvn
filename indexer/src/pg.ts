import { Pool, type PoolClient } from 'pg'
import type { Db, QueryResult } from './db'

/** Wrap a pg Pool (or a checked-out client) in the `Db` interface. */
function wrap(run: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>): Omit<Db, 'transaction' | 'close'> {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const res = await run(sql, params)
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
    },
  }
}

export function createPgDb(connectionString: string): Db {
  const pool = new Pool({ connectionString })

  const clientDb = (client: PoolClient): Db => ({
    ...wrap((sql, params) => client.query(sql, params)),
    // Nested transactions are not needed and silently doing nothing would be worse than saying so.
    transaction: () => Promise.reject(new Error('nested transactions are not supported')),
    close: () => Promise.resolve(),
  })

  return {
    ...wrap((sql, params) => pool.query(sql, params)),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn(clientDb(client))
        await client.query('COMMIT')
        return out
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}
