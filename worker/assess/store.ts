export interface DenyEntry { address: string; tags: string[]; reasons: string[] }

export class Denylist {
  private map = new Map<string, DenyEntry>()

  add(address: string, tag: string, reason: string): void {
    const key = address.toLowerCase()
    const existing = this.map.get(key)
    if (existing) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag)
      existing.reasons.push(reason)
    } else {
      this.map.set(key, { address: key, tags: [tag], reasons: [reason] })
    }
  }

  has(address: string): boolean { return this.map.has(address.toLowerCase()) }
  lookup(address: string): DenyEntry | undefined { return this.map.get(address.toLowerCase()) }
  get size(): number { return this.map.size }
}
