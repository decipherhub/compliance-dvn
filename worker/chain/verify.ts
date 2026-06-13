import { ethers } from 'ethers'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations) external',
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
