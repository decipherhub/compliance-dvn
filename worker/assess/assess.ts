import { Denylist } from './store'
import { ingestOfac } from './ingest/ofac'
import { ingestOpenSanctions } from './ingest/opensanctions'
import { ingestMixers } from './ingest/mixers'
import { loadTestDenylist } from './testDenylist'

export interface Assessment {
  address: string
  tags: string[]
  score: number      // 0 clean, 100 direct hit
  reasons: string[]
  blocked: boolean
}

export type Assessor = (address: string) => Assessment

/** Direct-hit assessor over a prebuilt denylist. Chain-independent. */
export function makeAssessor(dl: Denylist): Assessor {
  return (address: string): Assessment => {
    const e = dl.lookup(address)
    if (!e) return { address: address.toLowerCase(), tags: [], score: 0, reasons: [], blocked: false }
    return { address: e.address, tags: e.tags, score: 100, reasons: e.reasons, blocked: true }
  }
}

/** Block if ANY party is flagged. Aggregates tags/reasons. */
export function combine(parts: Assessment[]): Assessment {
  const blocked = parts.some((p) => p.blocked)
  return {
    address: parts.map((p) => p.address).join(','),
    tags: [...new Set(parts.flatMap((p) => p.tags))],
    score: Math.max(0, ...parts.map((p) => p.score)),
    reasons: parts.flatMap((p) => p.reasons),
    blocked,
  }
}

/** Build a denylist from all real sources + operator test entries. */
export async function buildDenylist(): Promise<Denylist> {
  const dl = new Denylist()
  await ingestOfac(dl)
  await ingestOpenSanctions(dl)
  ingestMixers(dl)
  loadTestDenylist(dl)
  return dl
}
