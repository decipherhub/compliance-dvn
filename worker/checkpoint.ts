import { readFileSync, writeFileSync, existsSync } from 'fs'

interface PersistedState { lastBlock: Record<string, number>; processed: string[] }

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
    writeFileSync(this.path, JSON.stringify(out, null, 2))
  }
}
