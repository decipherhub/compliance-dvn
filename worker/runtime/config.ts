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
  readonly privateKey: string
  readonly chains: readonly ResolvedChain[]
  readonly pollMs: number
  readonly confirmations: number
  readonly denylistRefreshMs: number
  readonly maxDenylistStalenessMs: number
  readonly txMaxRetries: number
  readonly txGasBumpPct: number
  readonly httpPort: number
  readonly logLevel: string
  readonly checkpointPath: string
  readonly testDenylist: string
}

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
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
  PRIVATE_KEY: z
    .string({ error: 'PRIVATE_KEY is required' })
    .regex(HEX_PRIVATE_KEY, 'PRIVATE_KEY must be a 32-byte hex string (0x + 64 hex chars)'),
  POLL_MS: intField(15_000, 1),
  DVN_CONFIRMATIONS: intField(5, 0),
  DENYLIST_REFRESH_MS: intField(1_800_000, 1),
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
})

/** Thrown when the environment fails validation; `.message` lists every problem. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid worker configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/**
 * Validate the environment and resolve the active chain set. Fails fast with a single
 * aggregated error enumerating every problem, so an operator fixes one boot, not ten.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []

  const scalar = ScalarSchema.safeParse(env)
  if (!scalar.success) {
    for (const issue of scalar.error.issues) {
      const key = issue.path.join('.') || '(root)'
      problems.push(`${key}: ${issue.message}`)
    }
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

  if (problems.length) throw new ConfigError(problems)
  const d = scalar.data!

  return Object.freeze({
    nodeEnv: d.NODE_ENV,
    privateKey: d.PRIVATE_KEY,
    chains: Object.freeze(chains),
    pollMs: d.POLL_MS,
    confirmations: d.DVN_CONFIRMATIONS,
    denylistRefreshMs: d.DENYLIST_REFRESH_MS,
    maxDenylistStalenessMs: d.MAX_DENYLIST_STALENESS_MS,
    txMaxRetries: d.TX_MAX_RETRIES,
    txGasBumpPct: d.TX_GAS_BUMP_PCT,
    httpPort: d.HTTP_PORT,
    logLevel: d.LOG_LEVEL,
    checkpointPath: d.CHECKPOINT_PATH,
    testDenylist: d.TEST_DENYLIST,
  })
}
