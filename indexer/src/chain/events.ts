import { ethers } from 'ethers'

/** Events the indexer decodes. Must match ComplianceDVN.sol and ERC-20. */
export const DVN_ABI = [
  'event RiskVerdict(bytes32 indexed payloadHash, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash)',
  'event PacketApproved(bytes32 indexed payloadHash, address approver)',
]
export const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']

export const dvnInterface = new ethers.utils.Interface(DVN_ABI)
export const erc20Interface = new ethers.utils.Interface(ERC20_ABI)

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
 * Scan `Transfer` events for the tracked tokens.
 *
 * Only ERC-20 transfers are collected. Native-value transfers would require trace APIs, which
 * most public RPCs do not expose, so the graph is token-transfer-shaped for now — worth knowing
 * when reading an exposure result.
 */
export async function scanTransfers(
  source: LogSource,
  tokens: readonly string[],
  fromBlock: number,
  toBlock: number,
): Promise<TransferRow[]> {
  if (tokens.length === 0) return []
  const transferTopic = topic(erc20Interface, 'Transfer')
  const out: TransferRow[] = []
  // getLogs takes a single address or an array depending on the node; querying per token keeps
  // behaviour identical across providers and bounds each response.
  for (const token of tokens) {
    const logs = await source.getLogs({ address: token, topics: [transferTopic], fromBlock, toBlock })
    for (const log of logs) out.push(decodeTransfer(log))
  }
  return out
}
