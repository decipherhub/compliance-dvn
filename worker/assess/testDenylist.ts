import { RiskStore } from './store'

const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** Operator-controlled flagged addresses (keys we hold) so a live blocked transfer is demoable.
 *  Source: TEST_DENYLIST env var, comma-separated. */
export function loadTestDenylist(store: RiskStore, csv = process.env.TEST_DENYLIST || ''): number {
  let n = 0
  for (const raw of csv.split(',')) {
    const a = raw.trim().toLowerCase()
    if (isEvmAddress(a)) {
      store.upsert({ subject: a, subjectType: 'address', labels: ['operator_deny'], source: 'operator' })
      n++
    }
  }
  return n
}
