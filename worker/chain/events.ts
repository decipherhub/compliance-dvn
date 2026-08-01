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

/**
 * Scan a block range on the source endpoint for PacketSent and return parsed packets.
 *
 * The endpoint is shared by every OApp on the chain, so most of what this sees belongs to
 * strangers — arbitrary message shapes, not OFT transfers. A packet we cannot decode is
 * therefore expected traffic, not an error, and is skipped rather than thrown: letting one
 * foreign log escape would abort the whole chain scan, and because the checkpoint is frozen on
 * failure the same log would abort it again forever.
 *
 * Skipping is safe in the fail-closed sense — withholding verification IS the veto, so a packet
 * we never parsed is also a packet we never let through. `onSkip` exists so it is still counted
 * and visible rather than silently dropped.
 */
export async function scanPacketSent(
  provider: ethers.providers.Provider,
  endpoint: string,
  fromBlock: number,
  toBlock: number,
  onSkip?: (payloadHash: string, reason: string) => void,
): Promise<ParsedPacket[]> {
  const iface = new ethers.utils.Interface(ENDPOINT_ABI)
  const topic = iface.getEventTopic('PacketSent')
  const logs = await provider.getLogs({ address: endpoint, topics: [topic], fromBlock, toBlock })
  const packets: ParsedPacket[] = []
  for (const l of logs) {
    const encoded = stripHex(iface.decodeEventLog('PacketSent', l.data, l.topics).encodedPayload as string)
    try {
      packets.push(parseEncodedPacket('0x' + encoded))
    } catch (err) {
      // The payload hash needs only the split, so an undecodable packet is still identifiable.
      const payloadHash = ethers.utils.keccak256('0x' + encoded.slice(81 * 2))
      onSkip?.(payloadHash, (err as Error).message)
    }
  }
  return packets
}

export const DVN_EVENT_ABI = [
  'event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender)',
  'event PacketApproved(bytes32 indexed payloadHash, address approver)',
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

/**
 * Scan our ComplianceDVN for owner approvals of held packets.
 *
 * `payloadHash` is indexed, so it is read from topics rather than data. Approvals are recorded
 * on the DVN that will submit the verification — the destination chain's — but the worker
 * scans every configured chain and matches purely on payloadHash, so it does not need to know
 * which side an approval arrived on.
 */
export async function scanPacketApproved(
  provider: ethers.providers.Provider,
  dvnAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const iface = new ethers.utils.Interface(DVN_EVENT_ABI)
  const topic = iface.getEventTopic('PacketApproved')
  const logs = await provider.getLogs({ address: dvnAddress, topics: [topic], fromBlock, toBlock })
  return new Set(
    logs.map((l) => (iface.decodeEventLog('PacketApproved', l.data, l.topics).payloadHash as string).toLowerCase()),
  )
}
