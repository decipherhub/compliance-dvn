import { RiskStore } from '../store'

const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/**
 * Operator-curated scam token list.
 *
 * Ships empty on purpose: a scam-token list is only as good as its provenance, and inventing
 * entries here would put unverified addresses on a blocking path. Populate it from the
 * `SCAM_TOKENS` env var until the signed indexer feed supplies it.
 *
 * `scam_token` scores 100, so an entry here BLOCKS every transfer of that token. Confirmed
 * scams only — suspicion belongs in a lower-weight label.
 */
export function loadScamTokens(store: RiskStore, csv = process.env.SCAM_TOKENS || ''): number {
  let n = 0
  for (const raw of csv.split(',')) {
    const a = raw.trim().toLowerCase()
    if (isEvmAddress(a)) {
      store.upsert({ subject: a, subjectType: 'token', labels: ['scam_token'], source: 'operator' })
      n++
    }
  }
  return n
}
