import { ethers } from 'ethers'
import { decodeHeader, PacketHeader } from './header'
import { decodeOftMessage, OftMessage } from './message'

export interface ParsedPacket {
  encoded: string
  header: string
  guid: string
  message: string
  payloadHash: string
  srcEid: number
  dstEid: number
  senderAddress: string
  receiverAddress: string
  oft: OftMessage
  headerFields: PacketHeader
}

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Split encodedPacket = header(81) ‖ guid(32) ‖ message, decode, and hash the payload. */
export function parseEncodedPacket(encodedPacket: string): ParsedPacket {
  const e = stripHex(encodedPacket)
  const header = '0x' + e.slice(0, 81 * 2)
  const guid = '0x' + e.slice(81 * 2, (81 + 32) * 2)
  const message = '0x' + e.slice((81 + 32) * 2)
  const payload = '0x' + e.slice(81 * 2)
  const payloadHash = ethers.utils.keccak256(payload)
  const hf = decodeHeader(header)
  return {
    encoded: '0x' + e, header, guid, message, payloadHash,
    srcEid: hf.srcEid, dstEid: hf.dstEid,
    senderAddress: hf.senderAddress, receiverAddress: hf.receiverAddress,
    oft: decodeOftMessage(message), headerFields: hf,
  }
}

export const ENDPOINT_ABI = [
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
]

/** Scan a block range on the source endpoint for PacketSent and return parsed packets. */
export async function scanPacketSent(
  provider: ethers.providers.Provider,
  endpoint: string,
  fromBlock: number,
  toBlock: number,
): Promise<ParsedPacket[]> {
  const iface = new ethers.utils.Interface(ENDPOINT_ABI)
  const topic = iface.getEventTopic('PacketSent')
  const logs = await provider.getLogs({ address: endpoint, topics: [topic], fromBlock, toBlock })
  return logs.map((l) => {
    const decoded = iface.decodeEventLog('PacketSent', l.data, l.topics)
    return parseEncodedPacket(decoded.encodedPayload as string)
  })
}

export const DVN_EVENT_ABI = [
  'event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender)',
]

/** Pure decode: extract the (lowercased) payloadHash from a JobAssigned log. */
export function decodeJobAssignedPayloadHash(
  iface: ethers.utils.Interface,
  data: string,
  topics: string[],
): string {
  const decoded = iface.decodeEventLog('JobAssigned', data, topics)
  return (decoded.payloadHash as string).toLowerCase()
}

/** Scan our ComplianceDVN on the source chain for JobAssigned; return the set of payloadHashes assigned to us. */
export async function scanJobAssigned(
  provider: ethers.providers.Provider,
  dvnAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const iface = new ethers.utils.Interface(DVN_EVENT_ABI)
  const topic = iface.getEventTopic('JobAssigned')
  const logs = await provider.getLogs({ address: dvnAddress, topics: [topic], fromBlock, toBlock })
  return new Set(logs.map((l) => decodeJobAssignedPayloadHash(iface, l.data, l.topics)))
}
