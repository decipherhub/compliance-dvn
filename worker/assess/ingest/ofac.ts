import { RiskStore } from '../store'

const OFAC_ETH_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json'

const isHex = (s: string) => /^0x[0-9a-fA-F]+$/.test(s)

/** Parse the 0xB10C ETH list (JSON array of address strings). Keeps hex strings, lowercased. */
export function parseOfacList(body: string): string[] {
  const arr = JSON.parse(body) as unknown[]
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.toLowerCase())
    .filter(isHex)
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OFAC fetch failed: ${res.status}`)
  return res.text()
}

export async function ingestOfac(store: RiskStore, fetcher: Fetcher = defaultFetch): Promise<number> {
  const body = await fetcher(OFAC_ETH_URL)
  const addrs = parseOfacList(body)
  for (const a of addrs) {
    store.upsert({ subject: a, subjectType: 'address', labels: ['sanctions'], source: 'ofac' })
  }
  return addrs.length
}
