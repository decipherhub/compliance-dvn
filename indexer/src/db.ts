/**
 * The narrow database surface the indexer uses.
 *
 * Everything goes through this interface rather than a `pg.Pool` directly, so the whole data
 * layer can be exercised against an in-memory Postgres in tests without a live server.
 */
export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Lowercase hex for storage, so no query has to case-fold. */
export const norm = (s: string): string => s.toLowerCase()
