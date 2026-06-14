import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

interface PersistedState { lastBlock: Record<string, number>; processed: string[] }

/**
 * Crash-safe persistence of scan progress (last block per chain) and processed packet keys.
 *
 * Writes are atomic: we write to a sibling `.tmp` file and `rename` it into place. POSIX
 * rename is atomic, so a crash mid-write leaves the previous good file intact rather than a
 * truncated, unparseable one.
 */
export class Checkpoint {
  private lastBlock: Record<string, number> = {}
  private processedSet = new Set<string>()

  constructor(private path: string) {
    if (existsSync(path)) {
      const s = JSON.parse(readFileSync(path, 'utf8')) as PersistedState
      this.lastBlock = s.lastBlock || {}
      this.processedSet = new Set(s.processed || [])
    }
  }

  getLastBlock(chain: string): number { return this.lastBlock[chain] ?? 0 }
  setLastBlock(chain: string, block: number): void { this.lastBlock[chain] = block }
  isProcessed(key: string): boolean { return this.processedSet.has(key) }
  markProcessed(key: string): void { this.processedSet.add(key) }

  save(): void {
    const out: PersistedState = { lastBlock: this.lastBlock, processed: [...this.processedSet] }
    const dir = dirname(this.path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(out, null, 2))
    renameSync(tmp, this.path)
  }
}
