import { buildRiskStore, makeAssessor, Assessor, Assessment } from '../assess/assess'

const SCAN_TESTNET = 'https://scan-testnet.layerzero-api.com/v1/messages/tx/'

export interface TraceResult {
  guid: string
  srcEid: number
  dstEid: number
  status: string
  sender: Assessment
  receiver: Assessment
}

/** Pure: turn a Scan API response into a risk-colored trace. */
export async function buildTrace(api: any, assess: Assessor): Promise<TraceResult> {
  const m = api?.data?.[0]
  if (!m) throw new Error('no message found for tx')
  const [sender, receiver] = await Promise.all([
    assess(m.pathway.sender.address),
    assess(m.pathway.receiver.address),
  ])
  return {
    guid: m.guid,
    srcEid: m.pathway.srcEid,
    dstEid: m.pathway.dstEid,
    status: m.status?.name ?? 'UNKNOWN',
    sender,
    receiver,
  }
}

/** Fetch from LayerZero Scan + color with a freshly built risk store. */
export async function trace(txHash: string): Promise<TraceResult> {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(SCAN_TESTNET + txHash)
  if (!res.ok) throw new Error(`Scan API ${res.status}`)
  const api = await res.json()
  return buildTrace(api, makeAssessor((await buildRiskStore()).store))
}
