import 'dotenv/config'
import { ethers } from 'ethers'
import { CHAINS, COMPLIANCE_DVN } from './config'
import { buildDenylist, makeAssessor, combine } from './assess/assess'
import { scanPacketSent } from './chain/events'
import { submitVerification } from './chain/verify'
import { trace } from './tracker/trace'

async function cmdAssess(addr: string) {
  const dl = await buildDenylist()
  const a = makeAssessor(dl)(addr)
  console.log(JSON.stringify(a, null, 2))
}

async function cmdVerify(chainKey: string, txHash: string) {
  const src = CHAINS[chainKey]
  if (!src) throw new Error(`unknown chain ${chainKey}`)
  const provider = new ethers.providers.JsonRpcProvider(src.rpc)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new Error('tx not found')
  const packets = await scanPacketSent(provider, src.endpoint, receipt.blockNumber, receipt.blockNumber)
  const dl = await buildDenylist()
  const assess = makeAssessor(dl)
  const pk = process.env.PRIVATE_KEY!
  for (const p of packets) {
    const verdict = combine([assess(p.senderAddress), assess(p.receiverAddress), assess(p.oft.toAddress)])
    const dstKey = Object.entries(CHAINS).find(([, c]) => c.eid === p.dstEid)?.[0]
    if (!dstKey) { console.log('skip unknown dstEid', p.dstEid); continue }
    if (verdict.blocked) { console.log('[VETO]', p.payloadHash, verdict.reasons); continue }
    const signer = new ethers.Wallet(pk, new ethers.providers.JsonRpcProvider(CHAINS[dstKey].rpc))
    const h = await submitVerification(signer, COMPLIANCE_DVN[dstKey], p.header, p.payloadHash, Number(process.env.DVN_CONFIRMATIONS || 5))
    console.log('[VERIFY]', p.payloadHash, 'tx=', h)
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'assess') return cmdAssess(a)
  if (cmd === 'verify') return cmdVerify(a, b)
  if (cmd === 'trace') return void console.log(JSON.stringify(await trace(a), null, 2))
  console.log('usage: cli <assess <addr> | verify <chainKey> <txHash> | trace <txHash>>')
}
main().catch((e) => { console.error(e); process.exit(1) })
