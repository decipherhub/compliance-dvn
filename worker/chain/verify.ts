import { ethers } from 'ethers'
import type { OnChainVerdict } from '../assess/verdict'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash) external',
  'function approvePacket(bytes32 payloadHash) external',
]

const RECEIVE_ULN_ABI = [
  'function commitVerification(bytes packetHeader, bytes32 payloadHash) external',
]

/**
 * Attest a packet and record the verdict that permitted it. The contract only accepts
 * ACTION_ALLOW here, so the caller must have decided to allow the packet.
 */
export async function submitVerification(
  signer: ethers.Signer,
  dvnAddress: string,
  packetHeader: string,
  payloadHash: string,
  confirmations: number,
  verdict: OnChainVerdict,
): Promise<string> {
  const dvn = new ethers.Contract(dvnAddress, DVN_ABI, signer)
  const tx = await dvn.submitVerification(
    packetHeader,
    payloadHash,
    confirmations,
    verdict.action,
    verdict.score,
    ethers.BigNumber.from(verdict.reasonMask.toString()),
    verdict.evidenceHash,
  )
  const receipt = await tx.wait()
  return receipt.transactionHash
}

/**
 * Approve a packet the worker withheld for manual review. Owner-only on-chain, so the signer
 * here is the owner key — never the worker's operator key.
 */
export async function approvePacket(
  signer: ethers.Signer,
  dvnAddress: string,
  payloadHash: string,
): Promise<string> {
  const dvn = new ethers.Contract(dvnAddress, DVN_ABI, signer)
  const tx = await dvn.approvePacket(payloadHash)
  const receipt = await tx.wait()
  return receipt.transactionHash
}

/**
 * Commit the verification on the destination ReceiveUln302 (permissionless).
 * In production the LayerZero executor calls this once required DVNs verify, but the
 * default executor does not track custom DVNs — so our worker drives it. Once committed,
 * the executor performs lzReceive and the message is delivered.
 */
export async function commitVerification(
  signer: ethers.Signer,
  receiveUln: string,
  packetHeader: string,
  payloadHash: string,
): Promise<string> {
  const uln = new ethers.Contract(receiveUln, RECEIVE_ULN_ABI, signer)
  const tx = await uln.commitVerification(packetHeader, payloadHash)
  const receipt = await tx.wait()
  return receipt.transactionHash
}
