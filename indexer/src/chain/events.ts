import { ethers } from 'ethers'

/** Events the indexer decodes. Must match ComplianceDVN.sol and ERC-20. */
export const DVN_ABI = [
  'event RiskVerdict(bytes32 indexed payloadHash, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash)',
  'event PacketApproved(bytes32 indexed payloadHash, address approver)',
]
export const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']

/** The OFT's own account of a cross-chain send: who sent it, how much, and to which chain. */
export const OFT_ABI = [
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
]
/** The endpoint carries the packet, and the packet is the only place the recipient is named. */
export const ENDPOINT_ABI = ['event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)']

export const dvnInterface = new ethers.utils.Interface(DVN_ABI)
export const erc20Interface = new ethers.utils.Interface(ERC20_ABI)
export const oftInterface = new ethers.utils.Interface(OFT_ABI)
export const endpointInterface = new ethers.utils.Interface(ENDPOINT_ABI)

export interface LogRef {
  blockNumber: number
  txHash: string
  logIndex: number
}

export interface RiskVerdictRow extends LogRef {
  payloadHash: string
  action: number
  score: number
  /** Decimal string — a uint256 mask does not fit a JS number. */
  reasonMask: string
  evidenceHash: string
}

export interface PacketApprovalRow extends LogRef {
  payloadHash: string
  approver: string
}

export interface TransferRow extends LogRef {
  token: string
  from: string
  to: string
  /** Decimal string — uint256. */
  value: string
}

/**
 * One cross-chain send, reassembled from the two halves the chain records separately.
 *
 * `to` is an address on another chain — the only edge in the graph where the two ends do not share
 * one. `dstEid` says which, so a path is never continued on the wrong side of the bridge.
 */
export interface BridgeSendRow extends LogRef {
  token: string
  from: string
  to: string
  dstEid: number
  /** Decimal string — amountSentLD, the amount debited on this side. */
  value: string
  guid: string
}

/** Block identity plus its wall-clock time — the schema's only timestamp source. */
export interface BlockRef {
  hash: string
  parentHash: string
  timestamp: number
}

/** The slice of an ethers provider the scanner needs, kept tiny for offline tests. */
export interface LogSource {
  getBlockNumber(): Promise<number>
  getLogs(filter: {
    address?: string
    topics?: (string | null)[]
    fromBlock: number
    toBlock: number
  }): Promise<ethers.providers.Log[]>
  getBlock(blockNumber: number): Promise<BlockRef | null>
}

const topic = (iface: ethers.utils.Interface, name: string) => iface.getEventTopic(name)

export function decodeRiskVerdict(log: ethers.providers.Log): RiskVerdictRow {
  const d = dvnInterface.decodeEventLog('RiskVerdict', log.data, log.topics)
  return {
    blockNumber: log.blockNumber,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    payloadHash: (d.payloadHash as string).toLowerCase(),
    action: Number(d.action),
    score: Number(d.score),
    reasonMask: (d.reasonMask as ethers.BigNumber).toString(),
    evidenceHash: (d.evidenceHash as string).toLowerCase(),
  }
}

export function decodePacketApproved(log: ethers.providers.Log): PacketApprovalRow {
  const d = dvnInterface.decodeEventLog('PacketApproved', log.data, log.topics)
  return {
    blockNumber: log.blockNumber,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    payloadHash: (d.payloadHash as string).toLowerCase(),
    approver: (d.approver as string).toLowerCase(),
  }
}

export function decodeTransfer(log: ethers.providers.Log): TransferRow {
  const d = erc20Interface.decodeEventLog('Transfer', log.data, log.topics)
  return {
    blockNumber: log.blockNumber,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    token: log.address.toLowerCase(),
    from: (d.from as string).toLowerCase(),
    to: (d.to as string).toLowerCase(),
    value: (d.value as ethers.BigNumber).toString(),
  }
}

/** Scan our DVN for both of its risk events in one pass. */
export async function scanDvnEvents(
  source: LogSource,
  dvnAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<{ verdicts: RiskVerdictRow[]; approvals: PacketApprovalRow[] }> {
  const verdictTopic = topic(dvnInterface, 'RiskVerdict')
  const approvedTopic = topic(dvnInterface, 'PacketApproved')
  // One request with a topic0 OR-set rather than two round trips.
  const logs = await source.getLogs({
    address: dvnAddress,
    topics: [[verdictTopic, approvedTopic] as unknown as string],
    fromBlock,
    toBlock,
  })

  const verdicts: RiskVerdictRow[] = []
  const approvals: PacketApprovalRow[] = []
  for (const log of logs) {
    if (log.topics[0] === verdictTopic) verdicts.push(decodeRiskVerdict(log))
    else if (log.topics[0] === approvedTopic) approvals.push(decodePacketApproved(log))
  }
  return { verdicts, approvals }
}

/**
 * LayerZero V2 packet layout: `header(81) ‖ guid(32) ‖ message`.
 *
 * The guid sits in the payload, so pairing a packet with its `OFTSent` needs no derivation — and
 * the OFT message opens with the recipient as a 32-byte word, which is the fact the source chain
 * records nowhere else.
 */
export function decodePacketRecipient(encodedPayload: string): { guid: string; to: string } | undefined {
  const hex = encodedPayload.startsWith('0x') ? encodedPayload.slice(2) : encodedPayload
  // 113 bytes of framing, then at least the 32-byte recipient word.
  if (hex.length < (113 + 32) * 2) return undefined
  return {
    guid: '0x' + hex.slice(81 * 2, 113 * 2),
    // sendTo is a bytes32; an EVM address is its low 20 bytes.
    to: '0x' + hex.slice(113 * 2 + 24, 113 * 2 + 64),
  }
}

/**
 * Reconstruct this range's cross-chain sends.
 *
 * Neither event alone is an edge: `OFTSent` knows the sender but not the recipient, and the packet
 * knows the recipient but names the OFT contract as its sender. Joined on the guid they are one
 * transfer between two parties, which is what the graph needs — and both are emitted on the source
 * chain, so the edge exists even for a send that never arrived because we blocked it.
 *
 * A send whose packet is missing from the range is skipped rather than guessed at. It happens at a
 * chunk boundary only if the two logs straddle it, which they cannot: they are in one transaction.
 */
export async function scanBridgeSends(
  source: LogSource,
  tokens: readonly string[],
  endpoint: string,
  fromBlock: number,
  toBlock: number,
  onSkip?: (guid: string, reason: string) => void,
): Promise<BridgeSendRow[]> {
  if (tokens.length === 0) return []
  const sentTopic = topic(oftInterface, 'OFTSent')

  const sends: Array<{ log: ethers.providers.Log; guid: string; from: string; dstEid: number; value: string }> = []
  for (const token of tokens) {
    const logs = await source.getLogs({ address: token, topics: [sentTopic], fromBlock, toBlock })
    for (const log of logs) {
      try {
        const d = oftInterface.decodeEventLog('OFTSent', log.data, log.topics)
        sends.push({
          log,
          guid: (d.guid as string).toLowerCase(),
          from: (d.fromAddress as string).toLowerCase(),
          dstEid: Number(d.dstEid),
          value: (d.amountSentLD as ethers.BigNumber).toString(),
        })
      } catch (err) {
        onSkip?.(log.transactionHash, (err as Error).message)
      }
    }
  }
  if (sends.length === 0) return []

  // One request for the whole range, and only when the range holds one of our sends. `PacketSent`
  // indexes none of its parameters, so it cannot be filtered to our OApps — this pulls every
  // packet in the chunk. Fine at testnet volumes (single digits per chunk here); a busy chain
  // would want to read the receipts of our own send transactions instead.
  //
  // The guid, not the transaction, is what identifies ours, so a batched send resolves correctly.
  const packets = await source.getLogs({
    address: endpoint,
    topics: [topic(endpointInterface, 'PacketSent')],
    fromBlock,
    toBlock,
  })
  const recipients = new Map<string, string>()
  for (const log of packets) {
    try {
      const { encodedPayload } = endpointInterface.decodeEventLog('PacketSent', log.data, log.topics)
      const decoded = decodePacketRecipient(encodedPayload as string)
      if (decoded) recipients.set(decoded.guid.toLowerCase(), decoded.to.toLowerCase())
    } catch {
      // Another OApp's packet shape we cannot read is not ours to care about.
    }
  }

  const out: BridgeSendRow[] = []
  for (const s of sends) {
    const to = recipients.get(s.guid)
    if (!to) {
      onSkip?.(s.guid, 'no PacketSent found for this guid')
      continue
    }
    out.push({
      blockNumber: s.log.blockNumber,
      txHash: s.log.transactionHash.toLowerCase(),
      logIndex: s.log.logIndex,
      token: s.log.address.toLowerCase(),
      from: s.from,
      to,
      dstEid: s.dstEid,
      value: s.value,
      guid: s.guid,
    })
  }
  return out
}

/**
 * Scan `Transfer` events for the tracked tokens.
 *
 * Only ERC-20 transfers are collected. Native-value transfers would require trace APIs, which
 * most public RPCs do not expose, so the graph is token-transfer-shaped for now — worth knowing
 * when reading an exposure result.
 *
 * A log that will not decode is skipped rather than thrown: ERC-721 shares the Transfer topic
 * but keeps all three parameters indexed, so a non-ERC-20 contract in TRACKED_TOKENS would
 * otherwise abort the same chunk every tick and freeze the cursor for good. `onSkip` keeps the
 * skips visible instead of silent.
 */
export async function scanTransfers(
  source: LogSource,
  tokens: readonly string[],
  fromBlock: number,
  toBlock: number,
  onSkip?: (token: string, reason: string) => void,
): Promise<TransferRow[]> {
  if (tokens.length === 0) return []
  const transferTopic = topic(erc20Interface, 'Transfer')
  const out: TransferRow[] = []
  // getLogs takes a single address or an array depending on the node; querying per token keeps
  // behaviour identical across providers and bounds each response.
  for (const token of tokens) {
    const logs = await source.getLogs({ address: token, topics: [transferTopic], fromBlock, toBlock })
    for (const log of logs) {
      try {
        out.push(decodeTransfer(log))
      } catch (err) {
        onSkip?.(log.address.toLowerCase(), (err as Error).message)
      }
    }
  }
  return out
}
