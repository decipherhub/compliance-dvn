import { z } from 'zod'

/**
 * Static, deploy-invariant metadata for each supported chain. RPC URLs and the
 * ComplianceDVN address are injected from the environment (per-chain), everything
 * else (endpoint, ULNs, EIDs) is fixed by the LayerZero deployment.
 */
export interface ChainStatic {
  name: string
  eid: number
  chainId: number
  endpoint: string
  sendUln: string
  receiveUln: string
  rpcEnv: string
  rpcDefault: string
  dvnEnv: string
}

export const CHAIN_REGISTRY: Record<string, ChainStatic> = {
  baseSepolia: {
    name: 'base-sepolia',
    eid: 40245,
    chainId: 84532,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xC1868e054425D378095A003EcbA3823a5D0135C9',
    receiveUln: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d',
    rpcEnv: 'RPC_URL_BASE_SEPOLIA',
    rpcDefault: 'https://sepolia.base.org',
    dvnEnv: 'DVN_BASE_SEPOLIA',
  },
  optimismSepolia: {
    name: 'optimism-sepolia',
    eid: 40232,
    chainId: 11155420,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f',
    receiveUln: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca',
    rpcEnv: 'RPC_URL_OPTIMISM_SEPOLIA',
    rpcDefault: 'https://sepolia.optimism.io',
    dvnEnv: 'DVN_OPTIMISM_SEPOLIA',
  },
}

/** A chain resolved for this run: static metadata + env-provided RPC and DVN address. */
export interface ResolvedChain {
  key: string
  name: string
  eid: number
  chainId: number
  rpc: string
  endpoint: string
  sendUln: string
  receiveUln: string
  dvn: string
}

export interface Config {
  readonly nodeEnv: string
  /** The operator key the worker signs verify/commit/recordVerdict with. */
  readonly operatorPrivateKey: string
  readonly chains: readonly ResolvedChain[]
  readonly pollMs: number
  /**
   * Confirmations asserted in `submitVerification`. Must be at least the pathway's ULN
   * `confirmations`, or the destination does not treat the packet as verifiable.
   */
  readonly confirmations: number
  /**
   * How far behind the head to stop scanning. Independent of the attested value above: reading a
   * block sooner is a latency choice, while the attested number is a protocol requirement.
   */
  readonly scanConfirmations: number
  readonly denylistRefreshMs: number
  /**
   * How often to re-ingest the indexer feed alone. Much shorter than a full rebuild because it is
   * one local request, not a re-download of OFAC and OpenSanctions.
   */
  readonly feedRefreshMs: number
  readonly maxDenylistStalenessMs: number
  readonly txMaxRetries: number
  readonly txGasBumpPct: number
  readonly httpPort: number
  readonly logLevel: string
  readonly checkpointPath: string
  readonly testDenylist: string
  /** Empty disables indexer feed ingest entirely. */
  readonly indexerFeedUrl: string
  readonly indexerSigners: readonly string[]
  readonly feedMaxSkewSec: number
  readonly degradedMode: 'degrade' | 'halt'
  /**
   * Non-allow actions that get a separate `recordVerdict` transaction. `allow` is never listed:
   * it rides along on `submitVerification` at no extra cost and is always recorded.
   */
  readonly emitVerdictFor: readonly ('delay' | 'manual-review' | 'block')[]
}

/**
 * A 32-byte private key, with the 0x prefix optional.
 *
 * ethers accepts a bare 64-hex key, so requiring the prefix would reject a configuration that
 * works perfectly well. Values are normalized to the 0x form below so everything downstream sees
 * one shape.
 */
const HEX_PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/** Canonicalize to the 0x form. */
const withHexPrefix = (v: string) => (v.startsWith('0x') ? v : `0x${v}`)
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** Coerce an env string to an integer with a default, bounded by [min, max]. */
function intField(def: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? def : v),
    z.coerce.number().int().min(min).max(max),
  )
}

const ScalarSchema = z.object({
  NODE_ENV: z.string().optional().default('production'),
  /**
   * The OPERATOR key, named explicitly rather than as a bare `PRIVATE_KEY`.
   *
   * The repo root's .env has a `PRIVATE_KEY` too, and there it is the OWNER key. Sharing the name
   * across the two files made one mistake — copying root .env into worker/ — silently hand the
   * worker the owner key, and with it the ability to approve the very packets it withheld. The
   * distinct name means that copy fails loudly instead.
   */
  OPERATOR_PRIVATE_KEY: z
    .string({ error: 'OPERATOR_PRIVATE_KEY is required' })
    .regex(HEX_PRIVATE_KEY, 'OPERATOR_PRIVATE_KEY must be a 32-byte hex key (64 hex chars, 0x prefix optional)')
    .transform(withHexPrefix),
  POLL_MS: intField(15_000, 1),
  DVN_CONFIRMATIONS: intField(5, 0),
  /** Defaults to DVN_CONFIRMATIONS below when unset, preserving the previous single-knob behaviour. */
  SCAN_CONFIRMATIONS: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  DENYLIST_REFRESH_MS: intField(1_800_000, 1),
  FEED_REFRESH_MS: intField(30_000, 1),
  MAX_DENYLIST_STALENESS_MS: intField(3_600_000, 1),
  TX_MAX_RETRIES: intField(3, 0, 20),
  TX_GAS_BUMP_PCT: intField(15, 0, 1000),
  HTTP_PORT: intField(9090, 1, 65535),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v))
    .pipe(z.enum(LOG_LEVELS)),
  CHECKPOINT_PATH: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? '.context/dvn-checkpoint.json' : v)),
  TEST_DENYLIST: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  SCAM_TOKENS: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  INDEXER_FEED_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim()),
  INDEXER_SIGNERS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim()),
  FEED_MAX_SKEW_SEC: intField(300, 0, 86_400),
  DEGRADED_MODE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'degrade' : v))
    .pipe(z.enum(['degrade', 'halt'])),
  EMIT_VERDICT_EVENTS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 'block' : v.trim()))
    .transform((v) => (v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(z.enum(['delay', 'manual-review', 'block']))),
})

/** Thrown when the environment fails validation; `.message` lists every problem. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid worker configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export interface LoadConfigOptions {
  /**
   * Refuse to boot when an owner-capable key is present in the environment, even alongside a
   * valid OPERATOR_PRIVATE_KEY. The long-running service sets this: the owner key approves the
   * very packets the worker withholds, so the two must never share a process environment. Owner
   * actions (approve, skip) are signed elsewhere — in MetaMask via the dashboard, or a deploy
   * shell — never by this process.
   */
  forbidOwnerKeys?: boolean
}

/** Env vars that carry owner authority; see the deploy scripts. */
const OWNER_KEY_VARS = ['PRIVATE_KEY', 'OWNER_PRIVATE_KEY'] as const

/**
 * Validate the environment and resolve the active chain set. Fails fast with a single
 * aggregated error enumerating every problem, so an operator fixes one boot, not ten.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const problems: string[] = []

  if (opts.forbidOwnerKeys) {
    for (const key of OWNER_KEY_VARS) {
      if ((env[key] ?? '').trim()) {
        problems.push(
          `${key} must not be set in the worker service's environment. It is an OWNER key — the one ` +
            'that approves held packets — and a worker holding it could release its own holds. Keep it ' +
            'in your deploy shell (owner actions are signed in MetaMask via the dashboard) and give ' +
            'the service only OPERATOR_PRIVATE_KEY.',
        )
      }
    }
  }

  const scalar = ScalarSchema.safeParse(env)
  if (!scalar.success) {
    for (const issue of scalar.error.issues) {
      const key = issue.path.join('.') || '(root)'
      problems.push(`${key}: ${issue.message}`)
    }
  }

  // Name the likely cause rather than just the symptom. A bare PRIVATE_KEY with no
  // OPERATOR_PRIVATE_KEY almost always means the repo root's .env was copied here — and there
  // PRIVATE_KEY is the OWNER key. Running with it would give the worker approval rights over the
  // packets it withheld, so this is worth spelling out instead of a generic "required" message.
  if (!(env.OPERATOR_PRIVATE_KEY ?? '').trim() && (env.PRIVATE_KEY ?? '').trim()) {
    problems.push(
      'PRIVATE_KEY is set but OPERATOR_PRIVATE_KEY is not. The worker signs with the OPERATOR key; ' +
        "the repo root's PRIVATE_KEY is the OWNER key and must never reach this process — it is what " +
        'approves held packets. Set OPERATOR_PRIVATE_KEY to the worker key and remove PRIVATE_KEY.',
    )
  }

  // Resolve the enabled chain set independently of scalar success so we surface all problems.
  const known = Object.keys(CHAIN_REGISTRY)
  const enabledRaw = (env.CHAINS_ENABLED ?? '').trim()
  let enabledKeys: string[]
  if (enabledRaw === '') {
    enabledKeys = known
  } else {
    enabledKeys = enabledRaw.split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = enabledKeys.filter((k) => !(k in CHAIN_REGISTRY))
    if (unknown.length) {
      problems.push(`CHAINS_ENABLED references unknown chain(s): ${unknown.join(', ')} (known: ${known.join(', ')})`)
      enabledKeys = enabledKeys.filter((k) => k in CHAIN_REGISTRY)
    }
  }

  const chains: ResolvedChain[] = []
  for (const key of enabledKeys) {
    const s = CHAIN_REGISTRY[key]
    const dvn = (env[s.dvnEnv] ?? '').trim()
    if (!EVM_ADDRESS.test(dvn)) {
      problems.push(`${s.dvnEnv}: required for enabled chain '${key}' and must be a 20-byte EVM address`)
      continue
    }
    const rpc = (env[s.rpcEnv] ?? '').trim() || s.rpcDefault
    chains.push({
      key,
      name: s.name,
      eid: s.eid,
      chainId: s.chainId,
      rpc,
      endpoint: s.endpoint,
      sendUln: s.sendUln,
      receiveUln: s.receiveUln,
      dvn,
    })
  }

  // Cross-field invariant: a stale-but-valid window must cover at least one refresh attempt.
  if (scalar.success && scalar.data.MAX_DENYLIST_STALENESS_MS < scalar.data.DENYLIST_REFRESH_MS) {
    problems.push(
      `MAX_DENYLIST_STALENESS_MS (${scalar.data.MAX_DENYLIST_STALENESS_MS}) must be >= DENYLIST_REFRESH_MS (${scalar.data.DENYLIST_REFRESH_MS})`,
    )
  }

  // An unsigned feed is worse than no feed: without an allowlist any host that answers the URL
  // could inject labels, so refuse to start rather than ingest one unverified.
  //
  // Read from the raw environment rather than the parsed result, so a bad allowlist is reported
  // alongside any other problem instead of only after that one is fixed.
  const indexerSigners = (env.INDEXER_SIGNERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if ((env.INDEXER_FEED_URL ?? '').trim() !== '') {
    if (indexerSigners.length === 0) {
      problems.push('INDEXER_SIGNERS: required when INDEXER_FEED_URL is set (comma-separated EVM addresses)')
    }
    const bad = indexerSigners.filter((s) => !EVM_ADDRESS.test(s))
    if (bad.length) problems.push(`INDEXER_SIGNERS: not valid EVM addresses: ${bad.join(', ')}`)
  }

  if (problems.length) throw new ConfigError(problems)
  const d = scalar.data!

  return Object.freeze({
    nodeEnv: d.NODE_ENV,
    operatorPrivateKey: d.OPERATOR_PRIVATE_KEY,
    chains: Object.freeze(chains),
    pollMs: d.POLL_MS,
    confirmations: d.DVN_CONFIRMATIONS,
    scanConfirmations: d.SCAN_CONFIRMATIONS ?? d.DVN_CONFIRMATIONS,
    denylistRefreshMs: d.DENYLIST_REFRESH_MS,
    feedRefreshMs: d.FEED_REFRESH_MS,
    maxDenylistStalenessMs: d.MAX_DENYLIST_STALENESS_MS,
    txMaxRetries: d.TX_MAX_RETRIES,
    txGasBumpPct: d.TX_GAS_BUMP_PCT,
    httpPort: d.HTTP_PORT,
    logLevel: d.LOG_LEVEL,
    checkpointPath: d.CHECKPOINT_PATH,
    testDenylist: d.TEST_DENYLIST,
    indexerFeedUrl: d.INDEXER_FEED_URL,
    indexerSigners: Object.freeze(indexerSigners),
    feedMaxSkewSec: d.FEED_MAX_SKEW_SEC,
    degradedMode: d.DEGRADED_MODE,
    emitVerdictFor: Object.freeze(d.EMIT_VERDICT_EVENTS),
  })
}
