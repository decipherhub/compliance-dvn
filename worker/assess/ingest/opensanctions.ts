import { RiskStore } from '../store'
import type { Fetcher } from './ofac'

const OS_OFAC_SDN_URL = 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/entities.ftm.json'
const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** Parse FtM NDJSON; keep EVM publicKeys from CryptoWallet entities, lowercased + de-duped. */
export function parseOpenSanctionsNdjson(body: string): string[] {
  const out = new Set<string>()
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: any
    try { obj = JSON.parse(t) } catch { continue }
    if (obj?.schema !== 'CryptoWallet') continue
    const keys: unknown = obj?.properties?.publicKey
    if (!Array.isArray(keys)) continue
    for (const k of keys) {
      if (typeof k === 'string' && isEvmAddress(k)) out.add(k.toLowerCase())
    }
  }
  return [...out]
}

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OpenSanctions fetch failed: ${res.status}`)
  return res.text()
}

export async function ingestOpenSanctions(store: RiskStore, fetcher: Fetcher = defaultFetch): Promise<number> {
  const body = await fetcher(OS_OFAC_SDN_URL)
  const addrs = parseOpenSanctionsNdjson(body)
  for (const a of addrs) {
    store.upsert({ subject: a, subjectType: 'address', labels: ['sanctions'], source: 'opensanctions' })
  }
  return addrs.length
}
