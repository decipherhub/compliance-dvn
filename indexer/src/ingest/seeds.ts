import type { IngestStore } from './store'

/**
 * Authoritative seed labels the graph is grown from.
 *
 * The indexer reads the same OFAC / OpenSanctions lists the worker does. It does NOT republish
 * them — the worker already has them first-hand, and re-feeding a sanctions label back as a
 * `trusted_indexer` claim would launder an authoritative source into a derived one. They exist
 * here only as the seed set for proximity.
 */

const OFAC_ETH_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json'
const OS_OFAC_SDN_URL = 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/entities.ftm.json'

/** Curated OFAC-sanctioned Tornado Cash contracts — same set the worker carries. */
export const MIXER_ADDRESSES: string[] = [
  '0x722122df12d4e14e13ac3b6895a86e84145b6967',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
].map((a) => a.toLowerCase())

export type Fetcher = (url: string) => Promise<string>

const isHex = (s: string) => /^0x[0-9a-fA-F]+$/.test(s)
const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

export function parseOfacList(body: string): string[] {
  const arr = JSON.parse(body) as unknown[]
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.toLowerCase())
    .filter(isHex)
}

export function parseOpenSanctionsNdjson(body: string): string[] {
  const out = new Set<string>()
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: { schema?: string; properties?: { publicKey?: unknown } }
    try {
      obj = JSON.parse(t)
    } catch {
      continue
    }
    if (obj?.schema !== 'CryptoWallet') continue
    const keys = obj?.properties?.publicKey
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
  if (!res.ok) throw new Error(`seed fetch failed (${res.status}): ${url}`)
  return res.text()
}

/**
 * Refresh the seed set. Seeds are replaced per source rather than merged, so an address removed
 * upstream stops seeding proximity instead of lingering forever.
 */
export async function refreshSeeds(store: IngestStore, fetcher: Fetcher = defaultFetch): Promise<number> {
  const [ofacBody, osBody] = await Promise.all([fetcher(OFAC_ETH_URL), fetcher(OS_OFAC_SDN_URL)])

  const ofac = parseOfacList(ofacBody).map((subject) => ({ subject, label: 'sanctions' }))
  const os = parseOpenSanctionsNdjson(osBody).map((subject) => ({ subject, label: 'sanctions' }))
  const mixers = MIXER_ADDRESSES.map((subject) => ({ subject, label: 'sanctioned_mixer' }))

  await store.replaceSeeds('ofac', [...ofac, ...mixers])
  await store.replaceSeeds('opensanctions', os)
  return ofac.length + os.length + mixers.length
}
