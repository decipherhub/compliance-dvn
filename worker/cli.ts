import 'dotenv/config'
import { ethers } from 'ethers'
import { Command, InvalidArgumentError } from 'commander'
import { loadConfig, CHAIN_REGISTRY, ResolvedChain } from './runtime/config'
import { buildRiskStore, makeAssessor, combine, Assessment } from './assess/assess'
import { scanPacketSent } from './chain/events'
import { submitVerification, commitVerification, approvePacket } from './chain/verify'
import { ethersReader } from './chain/reader'
import { RpcContractInspector, type ChainReader } from './assess/providers/contract'
import { RpcTokenInspector } from './assess/providers/token'
import { encodeVerdict } from './assess/verdict'
import { trace } from './tracker/trace'
import { Checkpoint } from './checkpoint'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
/** 0x prefix optional — ethers accepts a bare 64-hex key. */
const HEX_PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/** Exit codes: 0 success, 1 runtime error, 2 usage/validation error. */
const EXIT = { OK: 0, RUNTIME: 1, USAGE: 2 } as const

function parseAddress(value: string): string {
  if (!EVM_ADDRESS.test(value)) throw new InvalidArgumentError('must be a 20-byte EVM address (0x + 40 hex chars)')
  return value.toLowerCase()
}
function parseTxHash(value: string): string {
  if (!TX_HASH.test(value)) throw new InvalidArgumentError('must be a 32-byte tx hash (0x + 64 hex chars)')
  return value.toLowerCase()
}
function parseChainKey(value: string): string {
  if (!(value in CHAIN_REGISTRY)) {
    throw new InvalidArgumentError(`unknown chain '${value}' (known: ${Object.keys(CHAIN_REGISTRY).join(', ')})`)
  }
  return value
}

/** Print a result as pretty JSON or human-readable text. */
function emit(json: boolean, data: unknown, human: () => void): void {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  else human()
}

function renderAssessment(label: string, a: Assessment): string {
  const detail = a.reasonCodes.length ? ` [${a.reasonCodes.join(', ')}]` : ''
  return `  ${label}: ${a.subject} -> ${a.action} (score ${a.score})${detail}`
}

async function cmdAssess(address: string, opts: { json?: boolean }): Promise<void> {
  const assess = makeAssessor((await buildRiskStore()).store)
  const result = await assess(address)
  emit(!!opts.json, result, () => {
    process.stdout.write(`Assessment for ${result.subject}\n`)
    process.stdout.write(`  action: ${result.action}\n`)
    process.stdout.write(`  score:  ${result.score}\n`)
    if (result.reasonCodes.length) {
      process.stdout.write(`  reasons: ${result.reasonCodes.join(', ')}\n`)
      for (const e of result.evidence) {
        process.stdout.write(`    ${e.type} (weight ${e.weight}, ${e.source}, confidence ${e.confidence})\n`)
      }
    }
  })
}

async function cmdTrace(txHash: string, opts: { json?: boolean }): Promise<void> {
  const result = await trace(txHash)
  emit(!!opts.json, result, () => {
    process.stdout.write(`Trace ${result.guid}\n`)
    process.stdout.write(`  pathway: eid ${result.srcEid} -> ${result.dstEid}  status=${result.status}\n`)
    process.stdout.write(renderAssessment('sender  ', result.sender) + '\n')
    process.stdout.write(renderAssessment('receiver', result.receiver) + '\n')
  })
}

async function cmdVerify(
  chainKey: string,
  txHash: string,
  opts: { json?: boolean; dryRun?: boolean },
): Promise<void> {
  const config = loadConfig()
  const src = config.chains.find((c) => c.key === chainKey)
  if (!src) {
    throw new CliError(
      `chain '${chainKey}' is not enabled (enabled: ${config.chains.map((c) => c.key).join(', ')}); set CHAINS_ENABLED and the chain's DVN address`,
      EXIT.USAGE,
    )
  }
  const byEid = new Map<number, ResolvedChain>(config.chains.map((c) => [c.eid, c]))

  const provider = new ethers.providers.JsonRpcProvider(src.rpc)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new CliError(`transaction ${txHash} not found on ${chainKey}`, EXIT.RUNTIME)

  const packets = await scanPacketSent(provider, src.endpoint, receipt.blockNumber, receipt.blockNumber)

  // Screen with the same contract checks the service uses, so a dry run predicts it faithfully.
  const dstProviders: Record<string, ethers.providers.JsonRpcProvider> = {}
  const readers: Record<string, ChainReader> = { [src.key]: ethersReader(provider) }
  for (const c of config.chains) {
    if (c.key === src.key) continue
    dstProviders[c.key] = new ethers.providers.JsonRpcProvider(c.rpc)
    readers[c.key] = ethersReader(dstProviders[c.key])
  }
  const assess = makeAssessor((await buildRiskStore()).store, {
    contracts: new RpcContractInspector({ readers }),
    tokens: new RpcTokenInspector({ readers }),
  })

  const results: Array<Record<string, unknown>> = []
  for (const p of packets) {
    const dst = byEid.get(p.dstEid)
    const verdict = combine(
      await Promise.all([
        assess(p.senderAddress, src.key),
        assess(p.receiverAddress, dst?.key),
        assess(p.oft.toAddress, dst?.key),
      ]),
    )
    const row: Record<string, unknown> = {
      payloadHash: p.payloadHash,
      dstEid: p.dstEid,
      dstChain: dst?.key ?? null,
      verdict: verdict.action,
      score: verdict.score,
      reasonCodes: verdict.reasonCodes,
      action: 'pending',
    }

    if (!dst) {
      row.action = 'skipped:unknown-dst'
    } else if (verdict.action === 'block') {
      row.action = 'veto'
    } else if (verdict.action !== 'allow') {
      // One-shot command: report the hold, leave the deferral bookkeeping to the service.
      row.action = `withheld:${verdict.action}`
    } else if (opts.dryRun) {
      row.action = 'dry-run:would-verify'
    } else {
      const signer = new ethers.Wallet(config.operatorPrivateKey, new ethers.providers.JsonRpcProvider(dst.rpc))
      const parties = [
        { subject: p.senderAddress, chainKey: src.key },
        { subject: p.receiverAddress, chainKey: dst.key },
        { subject: p.oft.toAddress, chainKey: dst.key },
      ]
      const { encoded, unmapped } = encodeVerdict(p.payloadHash, verdict, parties)
      if (unmapped.length) row.unmappedReasons = unmapped
      row.evidenceHash = encoded.evidenceHash
      const verifyTx = await submitVerification(
        signer,
        dst.dvn,
        p.header,
        p.payloadHash,
        config.confirmations,
        encoded,
      )
      row.verifyTx = verifyTx
      try {
        row.commitTx = await commitVerification(signer, dst.receiveUln, p.header, p.payloadHash)
        row.action = 'verified+committed'
      } catch (err) {
        row.action = 'verified;commit-pending'
        row.commitError = (err as Error).message
      }
    }
    results.push(row)
  }

  emit(!!opts.json, { chain: chainKey, txHash, packets: results }, () => {
    process.stdout.write(`Verify ${chainKey} tx ${txHash} — ${results.length} packet(s)\n`)
    for (const r of results) {
      process.stdout.write(`  ${r.payloadHash} -> dst=${r.dstChain ?? r.dstEid} action=${r.action}\n`)
      if (r.verdict !== 'allow') {
        process.stdout.write(`    ${r.verdict} score=${r.score} [${(r.reasonCodes as string[]).join(', ')}]\n`)
      }
      if (r.verifyTx) process.stdout.write(`    verify tx: ${r.verifyTx}\n`)
      if (r.commitTx) process.stdout.write(`    commit tx: ${r.commitTx}\n`)
    }
  })
}

async function cmdPending(opts: { json?: boolean }): Promise<void> {
  const config = loadConfig()
  const held = new Checkpoint(config.checkpointPath).deferredEntries()
  const rows = held.map(([key, r]) => ({
    key,
    payloadHash: r.payloadHash,
    dstEid: r.dstEid,
    srcChain: r.srcChainKey,
    action: r.action,
    score: r.score,
    reasonCodes: r.reasonCodes,
    attempts: r.attempts,
    heldSince: new Date(r.firstDeferredAt).toISOString(),
    retryAfter: r.action === 'delay' ? new Date(r.retryAfter).toISOString() : null,
  }))
  emit(!!opts.json, { pending: rows }, () => {
    if (!rows.length) return void process.stdout.write('No packets held.\n')
    process.stdout.write(`${rows.length} packet(s) held\n`)
    for (const r of rows) {
      process.stdout.write(`  ${r.key}  ${r.action}  score=${r.score}  attempts=${r.attempts}\n`)
      process.stdout.write(`    src=${r.srcChain} dstEid=${r.dstEid} since=${r.heldSince}\n`)
      process.stdout.write(`    reasons: ${r.reasonCodes.join(', ') || '(none)'}\n`)
      if (r.action === 'manual-review') {
        process.stdout.write(`    approve with: dvn-cli approve <dstChainKey> ${r.payloadHash}\n`)
      }
    }
  })
}

/**
 * Approve a held packet on-chain. Signs with OWNER_PRIVATE_KEY, which is CLI-only on purpose:
 * `approvePacket` is owner-gated so the worker (operator key) cannot release its own holds.
 * The approval is recorded on the DVN that submits the verification — the destination chain's.
 */
async function cmdApprove(chainKey: string, payloadHash: string, opts: { json?: boolean }): Promise<void> {
  const ownerKey = (process.env.OWNER_PRIVATE_KEY ?? '').trim()
  if (!HEX_PRIVATE_KEY.test(ownerKey)) {
    throw new CliError(
      'OWNER_PRIVATE_KEY is required to approve (64 hex chars, 0x prefix optional). It is intentionally separate from the worker OPERATOR_PRIVATE_KEY.',
      EXIT.USAGE,
    )
  }
  const config = loadConfig()
  const dst = config.chains.find((c) => c.key === chainKey)
  if (!dst) {
    throw new CliError(
      `chain '${chainKey}' is not enabled (enabled: ${config.chains.map((c) => c.key).join(', ')})`,
      EXIT.USAGE,
    )
  }
  const signer = new ethers.Wallet(ownerKey.startsWith('0x') ? ownerKey : `0x${ownerKey}`, new ethers.providers.JsonRpcProvider(dst.rpc))
  const tx = await approvePacket(signer, dst.dvn, payloadHash)
  emit(!!opts.json, { chain: chainKey, payloadHash, approver: signer.address, tx }, () => {
    process.stdout.write(`Approved ${payloadHash} on ${chainKey}\n`)
    process.stdout.write(`  approver: ${signer.address}\n`)
    process.stdout.write(`  tx:       ${tx}\n`)
    process.stdout.write('The worker releases the packet on its next scan of this chain.\n')
  })
}

/** A CLI-layer error carrying the exit code to use. */
class CliError extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

function buildProgram(): Command {
  const program = new Command()
  program
    .name('dvn-cli')
    .description('Compliance DVN operator CLI — screen addresses, verify packets, trace messages.')
    .version('1.0.0')
    .showHelpAfterError('(add --help for usage)')

  program
    .command('assess')
    .description('Assess one address against the sanctions denylist')
    .argument('<address>', 'EVM address to screen', parseAddress)
    .option('--json', 'emit machine-readable JSON')
    .action(cmdAssess)

  program
    .command('verify')
    .description('Scan a transaction for LayerZero packets, screen parties, and verify or veto')
    .argument('<chainKey>', `source chain (${Object.keys(CHAIN_REGISTRY).join(' | ')})`, parseChainKey)
    .argument('<txHash>', 'transaction hash on the source chain', parseTxHash)
    .option('--json', 'emit machine-readable JSON')
    .option('--dry-run', 'assess and report verdicts without sending transactions')
    .action(cmdVerify)

  program
    .command('trace')
    .description('Trace a message via the LayerZero Scan API, risk-colored')
    .argument('<txHash>', 'source transaction hash', parseTxHash)
    .option('--json', 'emit machine-readable JSON')
    .action(cmdTrace)

  program
    .command('pending')
    .description('List packets the worker is holding (delay / manual-review)')
    .option('--json', 'emit machine-readable JSON')
    .action(cmdPending)

  program
    .command('approve')
    .description('Approve a held packet on-chain (owner key; requires OWNER_PRIVATE_KEY)')
    .argument('<chainKey>', `destination chain (${Object.keys(CHAIN_REGISTRY).join(' | ')})`, parseChainKey)
    .argument('<payloadHash>', 'payload hash of the held packet', parseTxHash)
    .option('--json', 'emit machine-readable JSON')
    .action(cmdApprove)

  program.addHelpText(
    'after',
    `\nExamples:\n  $ dvn-cli assess 0x0000000000000000000000000000000000000000\n  $ dvn-cli verify baseSepolia 0x<txhash> --dry-run\n  $ dvn-cli trace 0x<txhash> --json\n  $ dvn-cli pending\n  $ dvn-cli approve optimismSepolia 0x<payloadHash>\n`,
  )

  // exitOverride is per-command: apply it to the program AND every subcommand so all
  // usage/validation errors surface to our handler for consistent exit codes.
  program.exitOverride()
  for (const c of program.commands) c.exitOverride()

  return program
}

async function main(): Promise<void> {
  const program = buildProgram()
  try {
    await program.parseAsync(process.argv)
    process.exit(EXIT.OK)
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`)
      process.exit(err.code)
    }
    // commander throws CommanderError for usage/help/version with its own exitCode.
    const e = err as { code?: string; exitCode?: number; message?: string }
    if (e?.code === 'commander.helpDisplayed' || e?.code === 'commander.version' || e?.code === 'commander.help') {
      process.exit(EXIT.OK)
    }
    if (typeof e?.exitCode === 'number' && e.exitCode !== 0) {
      // Validation / unknown-command / missing-argument errors from commander.
      process.exit(EXIT.USAGE)
    }
    process.stderr.write(`error: ${e?.message ?? String(err)}\n`)
    process.exit(EXIT.RUNTIME)
  }
}

void main()
