import { ethers } from 'ethers'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations) external',
]

const RECEIVE_ULN_ABI = [
  'function commitVerification(bytes packetHeader, bytes32 payloadHash) external',
]

export async function submitVerification(
  signer: ethers.Signer,
  dvnAddress: string,
  packetHeader: string,
  payloadHash: string,
  confirmations: number,
): Promise<string> {
  const dvn = new ethers.Contract(dvnAddress, DVN_ABI, signer)
  const tx = await dvn.submitVerification(packetHeader, payloadHash, confirmations)
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
