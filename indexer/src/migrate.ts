import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Db } from './db'

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations')

/**
 * Apply every migration not yet recorded, in filename order.
 *
 * Each file runs inside its own transaction together with the row that records it, so a failure
 * leaves neither a half-applied schema nor a schema that claims to be further along than it is.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  )
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    await db.transaction(async (tx) => {
      await tx.query(sql)
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
    ran.push(file)
  }
  return ran
}

/** CLI entry: `pnpm migrate`. */
async function main(): Promise<void> {
  const { loadConfig } = await import('./config')
  const { createPgDb } = await import('./pg')
  const config = loadConfig()
  const db = createPgDb(config.databaseUrl)
  try {
    const ran = await migrate(db)
    process.stdout.write(ran.length ? `applied: ${ran.join(', ')}\n` : 'already up to date\n')
  } finally {
    await db.close()
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
