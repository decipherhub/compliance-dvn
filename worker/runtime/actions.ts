import { ethers } from 'ethers'
import type { ResolvedChain } from './config'
import type { TxSender } from './tx-sender'
import type { VerifyPacketDeps } from './scanner'
import type { OnChainVerdict } from '../assess/verdict'
import { decodeHeader } from '../chain/header'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash) external',
  'function recordVerdict(bytes32 payloadHash, uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash) external',
]
const RECEIVE_ULN_ABI = ['function commitVerification(bytes packetHeader, bytes32 payloadHash) external']
const ENDPOINT_ABI = [
  'function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) external payable',
  'function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)',
]

const HASH_ZERO = '0x' + '0'.repeat(64)

export type Actions = Pick<
  VerifyPacketDeps,
  'verify' | 'commit' | 'recordVerdict' | 'execute' | 'abandoned' | 'commitState'
>

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
    /**
     * Run `lzReceive` on the destination endpoint, delivering the message.
     *
     * Committing only makes a packet executable; the delivery itself is a separate call that the
     * LayerZero executor normally makes. It does not track custom DVNs, so a committed packet can
     * sit undelivered indefinitely — the same reason the worker already drives the commit. Execution
     * is permissionless once committed, so the operator key suffices.
     *
     * The origin is decoded from the packet header rather than passed alongside it, so a packet
     * released from the deferred queue needs nothing beyond what it already persisted.
     */
    execute: (dst: ResolvedChain, header: string, guid: string, message: string) => {
      const endpoint = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, signers[dst.key])
      const h = decodeHeader(header)
      const origin = { srcEid: h.srcEid, sender: h.sender, nonce: h.nonce.toString() }
      return senders[dst.key].send('lzReceive', ({ nonce, gasPrice }) =>
        endpoint.lzReceive(origin, h.receiverAddress, guid, message, '0x', {
          nonce,
          gasPrice: toBn(gasPrice),
        }),
      )
    },
    /**
     * Has the owner abandoned this packet by skipping its nonce?
     *
     * `EndpointV2.skip` is the only way to give up on a message: it moves `lazyInboundNonce` past
     * the slot without ever setting a payload hash, so the channel can move on and that nonce can
     * never execute again. A read, not a write — the worker cannot skip anything itself (skipping
     * is the OApp delegate's call, not the operator's), it only notices that a human did.
     *
     * The pair of reads is what distinguishes a skip from a delivery: both leave the nonce behind
     * `lazyInboundNonce`, but a delivered packet had a payload hash committed first. A packet in
     * the deferred queue was never verified by us, so it cannot have been delivered.
     */
    abandoned: async (dst: ResolvedChain, header: string) => {
      const endpoint = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, signers[dst.key])
      const h = decodeHeader(header)
      const lazy: ethers.BigNumber = await endpoint.lazyInboundNonce(h.receiverAddress, h.srcEid, h.sender)
      if (lazy.lt(h.nonce.toString())) return false
      const committed: string = await endpoint.inboundPayloadHash(
        h.receiverAddress,
        h.srcEid,
        h.sender,
        h.nonce.toString(),
      )
      return committed === HASH_ZERO
    },
    /**
     * How far the packet already is on the destination — the question a failed commit or delivery
     * actually raises. Read from the endpoint rather than guessed from a revert selector: the ULN
     * reports "already committed" and "not verified yet" identically, because committing deletes
     * the attestation it would otherwise have found.
     */
    commitState: async (dst: ResolvedChain, header: string, payloadHash: string) => {
      const endpoint = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, signers[dst.key])
      const h = decodeHeader(header)
      const nonce = h.nonce.toString()
      const committed: string = await endpoint.inboundPayloadHash(h.receiverAddress, h.srcEid, h.sender, nonce)
      if (committed.toLowerCase() === payloadHash.toLowerCase()) return 'committed'
      // A slot holding some other payload is not ours to commit and not a race we lost either;
      // reported as pending so it surfaces rather than being quietly accepted.
      if (committed !== HASH_ZERO) return 'pending'
      const lazy: ethers.BigNumber = await endpoint.lazyInboundNonce(h.receiverAddress, h.srcEid, h.sender)
      return lazy.lt(nonce) ? 'pending' : 'cleared'
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
