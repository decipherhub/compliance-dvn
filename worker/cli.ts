import 'dotenv/config'
import { ethers } from 'ethers'
import { Command, InvalidArgumentError } from 'commander'
import { loadConfig, CHAIN_REGISTRY, ResolvedChain } from './runtime/config'
import { buildDenylist, makeAssessor, combine, Assessment } from './assess/assess'
import { scanPacketSent } from './chain/events'
import { submitVerification, commitVerification } from './chain/verify'
import { trace } from './tracker/trace'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

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
  const verdict = a.blocked ? 'BLOCKED' : 'clean'
  const detail = a.blocked ? ` [${a.tags.join(', ')}] ${a.reasons.join('; ')}` : ''
  return `  ${label}: ${a.address} -> ${verdict}${detail}`
}

async function cmdAssess(address: string, opts: { json?: boolean }): Promise<void> {
  const assess = makeAssessor(await buildDenylist())
  const result = assess(address)
  emit(!!opts.json, result, () => {
    process.stdout.write(`Assessment for ${result.address}\n`)
    process.stdout.write(`  verdict: ${result.blocked ? 'BLOCKED' : 'clean'}\n`)
    if (result.blocked) {
      process.stdout.write(`  tags:    ${result.tags.join(', ')}\n`)
      process.stdout.write(`  reasons: ${result.reasons.join('; ')}\n`)
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
  const assess = makeAssessor(await buildDenylist())

  const results: Array<Record<string, unknown>> = []
  for (const p of packets) {
    const verdict = combine([assess(p.senderAddress), assess(p.receiverAddress), assess(p.oft.toAddress)])
    const dst = byEid.get(p.dstEid)
    const row: Record<string, unknown> = {
      payloadHash: p.payloadHash,
      dstEid: p.dstEid,
      dstChain: dst?.key ?? null,
      blocked: verdict.blocked,
      tags: verdict.tags,
      reasons: verdict.reasons,
      action: 'pending',
    }

    if (!dst) {
      row.action = 'skipped:unknown-dst'
    } else if (verdict.blocked) {
      row.action = 'veto'
    } else if (opts.dryRun) {
      row.action = 'dry-run:would-verify'
    } else {
      const signer = new ethers.Wallet(config.privateKey, new ethers.providers.JsonRpcProvider(dst.rpc))
      const verifyTx = await submitVerification(signer, dst.dvn, p.header, p.payloadHash, config.confirmations)
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
      if (r.blocked) process.stdout.write(`    VETO [${(r.tags as string[]).join(', ')}] ${(r.reasons as string[]).join('; ')}\n`)
      if (r.verifyTx) process.stdout.write(`    verify tx: ${r.verifyTx}\n`)
      if (r.commitTx) process.stdout.write(`    commit tx: ${r.commitTx}\n`)
    }
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

  program.addHelpText(
    'after',
    `\nExamples:\n  $ dvn-cli assess 0x0000000000000000000000000000000000000000\n  $ dvn-cli verify baseSepolia 0x<txhash> --dry-run\n  $ dvn-cli trace 0x<txhash> --json\n`,
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
