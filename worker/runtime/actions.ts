import { ethers } from 'ethers'
import type { ResolvedChain } from './config'
import type { TxSender } from './tx-sender'
import type { VerifyPacketDeps } from './scanner'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations) external',
]
const RECEIVE_ULN_ABI = ['function commitVerification(bytes packetHeader, bytes32 payloadHash) external']

export type Actions = Pick<VerifyPacketDeps, 'verify' | 'commit'>

/**
 * Wire the on-chain verify/commit calls through each destination chain's TxSender, so every
 * transaction gets sequential nonces, gas escalation, and bounded retries. The DVN's
 * `submitVerification` and the ReceiveUln's `commitVerification` both run on the destination
 * chain, keyed by `dst.key`.
 */
export function createActions(
  signers: Record<string, ethers.Wallet>,
  senders: Record<string, TxSender>,
  confirmations: number,
): Actions {
  const toBn = (gasPrice: bigint) => ethers.BigNumber.from(gasPrice.toString())

  return {
    verify: (dst: ResolvedChain, header: string, payloadHash: string) => {
      const dvn = new ethers.Contract(dst.dvn, DVN_ABI, signers[dst.key])
      return senders[dst.key].send('verify', ({ nonce, gasPrice }) =>
        dvn.submitVerification(header, payloadHash, confirmations, { nonce, gasPrice: toBn(gasPrice) }),
      )
    },
    commit: (dst: ResolvedChain, header: string, payloadHash: string) => {
      const uln = new ethers.Contract(dst.receiveUln, RECEIVE_ULN_ABI, signers[dst.key])
      return senders[dst.key].send('commit', ({ nonce, gasPrice }) =>
        uln.commitVerification(header, payloadHash, { nonce, gasPrice: toBn(gasPrice) }),
      )
    },
  }
}
