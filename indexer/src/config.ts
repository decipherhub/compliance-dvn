import { z } from 'zod'
import { DEFAULT_SOURCIFY_URL } from './verify/sourcify'

/**
 * Static chain metadata. Mirrors the worker's CHAIN_REGISTRY — the indexer watches the same
 * DVN contracts, so the two must agree on EIDs and endpoints.
 */
export interface ChainStatic {
  name: string
  eid: number
  /** EVM chain id — what the source verifier keys on, as opposed to the LayerZero eid. */
  chainId: number
  rpcEnv: string
  rpcDefault: string
  dvnEnv: string
}

export const CHAIN_REGISTRY: Record<string, ChainStatic> = {
  baseSepolia: {
    name: 'base-sepolia',
    eid: 40245,
    chainId: 84532,
    rpcEnv: 'RPC_URL_BASE_SEPOLIA',
    rpcDefault: 'https://sepolia.base.org',
    dvnEnv: 'DVN_BASE_SEPOLIA',
  },
  optimismSepolia: {
    name: 'optimism-sepolia',
    eid: 40232,
    chainId: 11155420,
    rpcEnv: 'RPC_URL_OPTIMISM_SEPOLIA',
    rpcDefault: 'https://sepolia.optimism.io',
    dvnEnv: 'DVN_OPTIMISM_SEPOLIA',
  },
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

export interface ResolvedChain {
  key: string
  name: string
  eid: number
  chainId: number
  rpc: string
  dvn: string
}

/**
 * A per-token inbound threshold.
 *
 * `minValue` is a decimal string in the token's smallest unit, not a float — a uint256 does not
 * fit a JS number, and rounding a threshold is how a dusting defence silently stops working.
 */
export interface TokenMinimum {
  chain: string
  token: string
  minValue: string
}

const UINT_DECIMAL = /^\d{1,78}$/

/**
 * Parse `chain:token:minValue` triples.
 *
 * Returns problems rather than throwing so `loadConfig` can report them alongside everything
 * else — an operator should see every misconfiguration in one boot, not one per restart.
 */
export function parseTokenMinimums(raw: string): { minimums: TokenMinimum[]; problems: string[] } {
  const minimums: TokenMinimum[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const fields = part.split(':').map((f) => f.trim())
    if (fields.length !== 3) {
      problems.push(`TOKEN_MINIMUMS: '${part}' must be chain:token:minValue`)
      continue
    }
    const [chain, tokenRaw, minValue] = fields
    const token = tokenRaw.toLowerCase()

    if (!(chain in CHAIN_REGISTRY)) {
      problems.push(`TOKEN_MINIMUMS: unknown chain '${chain}' (known: ${Object.keys(CHAIN_REGISTRY).join(', ')})`)
      continue
    }
    if (!EVM_ADDRESS.test(token)) {
      problems.push(`TOKEN_MINIMUMS: '${tokenRaw}' is not a 20-byte EVM address`)
      continue
    }
    if (!UINT_DECIMAL.test(minValue)) {
      problems.push(
        `TOKEN_MINIMUMS: minValue '${minValue}' for ${chain}:${token} must be a decimal integer in the token's smallest unit`,
      )
      continue
    }
    const key = `${chain}|${token}`
    if (seen.has(key)) {
      problems.push(`TOKEN_MINIMUMS: duplicate entry for ${chain}:${token}`)
      continue
    }
    seen.add(key)
    minimums.push({ chain, token, minValue })
  }
  return { minimums, problems }
}

export interface Config {
  readonly nodeEnv: string
  readonly databaseUrl: string
  readonly chains: readonly ResolvedChain[]
  readonly pollMs: number
  readonly confirmations: number
  /** How far back to look on a cold cursor. */
  readonly scanWindow: number
  /** Maximum blocks per getLogs call, so a cold start does not ask for a million blocks. */
  readonly scanChunk: number
  /** How many blocks to unwind when a reorg is detected. */
  readonly reorgDepth: number
  readonly feedSigningKey: string
  readonly feedSource: string
  readonly feedTtlSec: number
  readonly feedRebuildMs: number
  readonly policyVersion: number
  /** ERC-20 contracts whose Transfer events build the graph. Empty means no edges are built. */
  readonly trackedTokens: readonly string[]
  /** Source verifier base URL. Empty disables verification lookups entirely. */
  readonly verifierUrl: string
  readonly verifyBatch: number
  readonly verifyTtlSec: number
  /**
   * Minimum transfer value, per chain and token, for an INBOUND edge to count as exposure.
   * Without an entry a token is never labelled inbound, so this is what turns the
   * `sanctions_1hop_inbound` signal on.
   */
  readonly tokenMinimums: readonly TokenMinimum[]
  readonly httpPort: number
  readonly logLevel: string
}

function intField(def: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? def : v),
    z.coerce.number().int().min(min).max(max),
  )
}

const ScalarSchema = z.object({
  NODE_ENV: z.string().optional().default('production'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  FEED_SIGNING_KEY: z
    .string({ error: 'FEED_SIGNING_KEY is required' })
    .regex(HEX_PRIVATE_KEY, 'FEED_SIGNING_KEY must be a 32-byte hex key (64 hex chars, 0x prefix optional)')
    .transform(withHexPrefix),
  FEED_SOURCE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'trusted-indexer-a' : v.trim())),
  FEED_TTL_SEC: intField(7200, 60),
  FEED_REBUILD_MS: intField(600_000, 1000),
  POLICY_VERSION: intField(1, 0),
  POLL_MS: intField(15_000, 1),
  CONFIRMATIONS: intField(5, 0),
  SCAN_BACKFILL_BLOCKS: intField(5000, 1),
  SCAN_CHUNK_BLOCKS: intField(2000, 1, 50_000),
  REORG_DEPTH: intField(32, 1, 1000),
  TRACKED_TOKENS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim()),
  VERIFIER_URL: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? DEFAULT_SOURCIFY_URL : v.trim())),
  VERIFY_BATCH: intField(50, 1, 500),
  VERIFY_TTL_SEC: intField(604_800, 60),
  TOKEN_MINIMUMS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim()),
  HTTP_PORT: intField(9091, 1, 65535),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v))
    .pipe(z.enum(LOG_LEVELS)),
})

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid indexer configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/**
 * Validate the environment and resolve the active chain set, failing with every problem at once
 * so an operator fixes one boot rather than ten.
 *
 * The feed TTL must comfortably exceed the rebuild interval: if a document could expire before
 * its replacement is built, the worker's screening would flap between having feed labels and not.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []

  const scalar = ScalarSchema.safeParse(env)
  if (!scalar.success) {
    for (const issue of scalar.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
  }

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
    chains.push({
      key,
      name: s.name,
      eid: s.eid,
      chainId: s.chainId,
      rpc: (env[s.rpcEnv] ?? '').trim() || s.rpcDefault,
      dvn,
    })
  }

  // Read from the raw environment rather than the parsed result: if some other scalar failed we
  // still want to report a bad token list now, instead of after the operator fixes that one.
  const trackedTokens = (env.TRACKED_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  const badTokens = trackedTokens.filter((t) => !EVM_ADDRESS.test(t))
  if (badTokens.length) problems.push(`TRACKED_TOKENS: not valid EVM addresses: ${badTokens.join(', ')}`)

  const { minimums: tokenMinimums, problems: minimumProblems } = parseTokenMinimums(env.TOKEN_MINIMUMS ?? '')
  problems.push(...minimumProblems)

  if (scalar.success && scalar.data.FEED_TTL_SEC * 1000 <= scalar.data.FEED_REBUILD_MS) {
    problems.push(
      `FEED_TTL_SEC (${scalar.data.FEED_TTL_SEC}s) must exceed FEED_REBUILD_MS (${scalar.data.FEED_REBUILD_MS}ms) — otherwise a feed can expire before its replacement exists`,
    )
  }

  if (problems.length) throw new ConfigError(problems)
  const d = scalar.data!

  return Object.freeze({
    nodeEnv: d.NODE_ENV,
    databaseUrl: d.DATABASE_URL,
    chains: Object.freeze(chains),
    pollMs: d.POLL_MS,
    confirmations: d.CONFIRMATIONS,
    scanWindow: d.SCAN_BACKFILL_BLOCKS,
    scanChunk: d.SCAN_CHUNK_BLOCKS,
    reorgDepth: d.REORG_DEPTH,
    feedSigningKey: d.FEED_SIGNING_KEY,
    feedSource: d.FEED_SOURCE,
    feedTtlSec: d.FEED_TTL_SEC,
    feedRebuildMs: d.FEED_REBUILD_MS,
    policyVersion: d.POLICY_VERSION,
    trackedTokens: Object.freeze(trackedTokens),
    verifierUrl: d.VERIFIER_URL,
    verifyBatch: d.VERIFY_BATCH,
    verifyTtlSec: d.VERIFY_TTL_SEC,
    tokenMinimums: Object.freeze(tokenMinimums),
    httpPort: d.HTTP_PORT,
    logLevel: d.LOG_LEVEL,
  })
}
