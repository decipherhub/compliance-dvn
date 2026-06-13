import { Denylist } from '../store'

/** Curated OFAC-sanctioned Tornado Cash contracts (mainnet). */
export const MIXER_ADDRESSES: string[] = [
  '0x722122df12d4e14e13ac3b6895a86e84145b6967', // Tornado Cash: Router
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', // Tornado.Cash 10 ETH
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', // Tornado.Cash 100 ETH
].map((a) => a.toLowerCase())

export function ingestMixers(dl: Denylist): number {
  for (const a of MIXER_ADDRESSES) dl.add(a, 'mixer', 'Curated sanctioned mixer contract (Tornado Cash)')
  return MIXER_ADDRESSES.length
}
