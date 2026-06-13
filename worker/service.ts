import 'dotenv/config'
import { ethers } from 'ethers'
import { CHAINS, COMPLIANCE_DVN, ChainCfg } from './config'
import { buildDenylist, makeAssessor, combine } from './assess/assess'
import { scanPacketSent, scanJobAssigned, ParsedPacket } from './chain/events'
import { submitVerification, commitVerification } from './chain/verify'
import { Checkpoint } from './checkpoint'

const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || '.context/dvn-checkpoint.json'
const POLL_MS = Number(process.env.POLL_MS || 15000)
const CONFIRMATIONS = Number(process.env.DVN_CONFIRMATIONS || 5)

function chainByEid(eid: number): ChainCfg | undefined {
  return Object.values(CHAINS).find((c) => c.eid === eid)
}
function chainKeyByEid(eid: number): string | undefined {
  return Object.entries(CHAINS).find(([, c]) => c.eid === eid)?.[0]
}

async function main() {
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('PRIVATE_KEY required')

  console.log('[worker] building denylist…')
  const dl = await buildDenylist()
  const assess = makeAssessor(dl)
  console.log(`[worker] denylist size=${dl.size}`)

  const cp = new Checkpoint(CHECKPOINT_PATH)
  const providers: Record<string, ethers.providers.JsonRpcProvider> = {}
  const signers: Record<string, ethers.Wallet> = {}
  for (const [key, c] of Object.entries(CHAINS)) {
    providers[key] = new ethers.providers.JsonRpcProvider(c.rpc)
    signers[key] = new ethers.Wallet(pk, providers[key])
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const [srcKey, src] of Object.entries(CHAINS)) {
      try {
        const provider = providers[srcKey]
        const head = await provider.getBlockNumber()
        const safeHead = head - CONFIRMATIONS
        let from = cp.getLastBlock(srcKey)
        if (from === 0) from = Math.max(0, safeHead - 50)
        if (safeHead <= from) continue

        const srcDvn = COMPLIANCE_DVN[srcKey]
        if (!srcDvn) {
          console.warn(`[worker] no ComplianceDVN address for ${srcKey}; cannot filter by assignment, skipping`)
          // Nothing to verify without our DVN address; advance the checkpoint to avoid re-scan storms.
          cp.setLastBlock(srcKey, safeHead)
          cp.save()
          continue
        }

        // Only act on packets actually assigned to our DVN (JobAssigned on the source chain).
        const assigned = await scanJobAssigned(provider, srcDvn, from + 1, safeHead)
        const packets = await scanPacketSent(provider, src.endpoint, from + 1, safeHead)
        for (const p of packets) {
          if (!assigned.has(p.payloadHash.toLowerCase())) continue
          await handlePacket(p, assess, signers, cp)
        }
        cp.setLastBlock(srcKey, safeHead)
        cp.save()
      } catch (err) {
        console.error(`[worker] scan error on ${srcKey} (fail-closed, will retry):`, (err as Error).message)
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function handlePacket(
  p: ParsedPacket,
  assess: ReturnType<typeof makeAssessor>,
  signers: Record<string, ethers.Wallet>,
  cp: Checkpoint,
) {
  const key = `${p.payloadHash}:${p.dstEid}`
  if (cp.isProcessed(key)) return

  const dstKey = chainKeyByEid(p.dstEid)
  const dst = chainByEid(p.dstEid)
  if (!dstKey || !dst) { console.log(`[worker] skip: unknown dstEid ${p.dstEid}`); return }
  const dvnAddr = COMPLIANCE_DVN[dstKey]
  if (!dvnAddr) { console.log(`[worker] skip: no ComplianceDVN address for ${dstKey}`); return }

  const verdict = combine([
    assess(p.senderAddress),
    assess(p.receiverAddress),
    assess(p.oft.toAddress),
  ])

  if (verdict.blocked) {
    console.log(`[VETO] withholding verify for payloadHash=${p.payloadHash} reasons=${verdict.reasons.join('; ')}`)
    cp.markProcessed(key)
    cp.save()
    return
  }

  try {
    const txHash = await submitVerification(signers[dstKey], dvnAddr, p.header, p.payloadHash, CONFIRMATIONS)
    console.log(`[VERIFY] payloadHash=${p.payloadHash} tx=${txHash}`)
    cp.markProcessed(key)
    cp.save()
    // Drive commit so the message is delivered: the default LZ executor does not commit
    // for custom (unregistered) DVNs, so the worker commits, then the executor lzReceives.
    try {
      const commitTx = await commitVerification(signers[dstKey], dst.receiveUln, p.header, p.payloadHash)
      console.log(`[COMMIT] payloadHash=${p.payloadHash} tx=${commitTx}`)
    } catch (cerr) {
      console.log(`[worker] commit pending (verified on-chain; executor/next-run may commit):`, (cerr as Error).message)
    }
  } catch (err) {
    console.error(`[worker] submitVerification failed (will retry):`, (err as Error).message)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
