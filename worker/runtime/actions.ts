import { ethers } from 'ethers'
import type { ResolvedChain } from './config'
import type { TxSender } from './tx-sender'
import type { VerifyPacketDeps } from './scanner'
import type { OnChainVerdict } from '../assess/verdict'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash) external',
  'function recordVerdict(bytes32 payloadHash, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash) external',
]
const RECEIVE_ULN_ABI = ['function commitVerification(bytes packetHeader, bytes32 payloadHash) external']

export type Actions = Pick<VerifyPacketDeps, 'verify' | 'commit' | 'recordVerdict'>

/**
 * Wire the on-chain calls through each destination chain's TxSender, so every transaction gets
 * sequential nonces, gas escalation, and bounded retries. `submitVerification` and
 * `recordVerdict` are on our DVN; the ReceiveUln's `commitVerification` is not — all three run
 * on the destination chain, keyed by `dst.key`.
 */
export function createActions(
  signers: Record<string, ethers.Wallet>,
  senders: Record<string, TxSender>,
  confirmations: number,
): Actions {
  const toBn = (gasPrice: bigint) => ethers.BigNumber.from(gasPrice.toString())
  const mask = (v: bigint) => ethers.BigNumber.from(v.toString())

  return {
    verify: (dst: ResolvedChain, header: string, payloadHash: string, verdict: OnChainVerdict) => {
      const dvn = new ethers.Contract(dst.dvn, DVN_ABI, signers[dst.key])
      return senders[dst.key].send('verify', ({ nonce, gasPrice }) =>
        dvn.submitVerification(
          header,
          payloadHash,
          confirmations,
          verdict.action,
          verdict.score,
          mask(verdict.reasonMask),
          verdict.evidenceHash,
          { nonce, gasPrice: toBn(gasPrice) },
        ),
      )
    },
    commit: (dst: ResolvedChain, header: string, payloadHash: string) => {
      const uln = new ethers.Contract(dst.receiveUln, RECEIVE_ULN_ABI, signers[dst.key])
      return senders[dst.key].send('commit', ({ nonce, gasPrice }) =>
        uln.commitVerification(header, payloadHash, { nonce, gasPrice: toBn(gasPrice) }),
      )
    },
    recordVerdict: (dst: ResolvedChain, payloadHash: string, verdict: OnChainVerdict) => {
      const dvn = new ethers.Contract(dst.dvn, DVN_ABI, signers[dst.key])
      return senders[dst.key].send('recordVerdict', ({ nonce, gasPrice }) =>
        dvn.recordVerdict(
          payloadHash,
          verdict.action,
          verdict.score,
          mask(verdict.reasonMask),
          verdict.evidenceHash,
          { nonce, gasPrice: toBn(gasPrice) },
        ),
      )
    },
  }
}
