/**
 * Contract risk provider — the on-chain facts about an address that bear on risk.
 *
 * Scope is deliberately what a node can read for itself: whether the address holds code,
 * whether it sits behind an upgradeable proxy, and who controls it. Source-verification status
 * is NOT here — it cannot be observed on-chain and belongs to the indexer feed.
 *
 * Every lookup is cached and time-bounded. The worker blocks on this per packet, so an
 * unresponsive RPC must degrade the decision (the caller turns a failure into a hold), never
 * stall the scan loop.
 */

/** The slice of a chain provider this needs. Kept tiny so tests stay offline. */
export interface ChainReader {
  getCode(address: string): Promise<string>
  getStorageAt(address: string, slot: string): Promise<string>
  call(tx: { to: string; data: string }): Promise<string>
}

/** EIP-1967 standard slots: keccak256("eip1967.proxy.<field>") - 1. */
const SLOT_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

const SELECTOR_OWNER = '0x8da5cb5b' // owner()
const SELECTOR_ADMIN = '0xf851a440' // admin()

const ZERO = '0x0000000000000000000000000000000000000000'

export interface ContractFacts {
  isContract: boolean
  /** An EIP-1967 implementation slot is set, so the code behind this address can change. */
  proxy: boolean
  implementation?: string
  /** Whoever the contract itself names as owner/admin, if it exposes one. */
  controller?: string
}

export interface ContractInspector {
  inspect(subject: string, chainKey: string): Promise<ContractFacts>
}

export interface ContractInspectorOptions {
  readers: Record<string, ChainReader>
  /** Per-inspection budget. Exceeding it rejects, which the caller turns into a hold. */
  timeoutMs?: number
  /** How long facts stay cached. Upgrades are rare; a few minutes is plenty. */
  cacheTtlMs?: number
  maxCacheEntries?: number
  now?: () => number
}

/** Read a 32-byte word as an address, or undefined when the slot is empty. */
function wordToAddress(word: string): string | undefined {
  if (!word || word === '0x') return undefined
  const hex = word.replace(/^0x/, '').padStart(64, '0')
  const addr = '0x' + hex.slice(24)
  return addr === ZERO ? undefined : addr.toLowerCase()
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

interface CacheEntry {
  facts: ContractFacts
  expiresAt: number
}

export class RpcContractInspector implements ContractInspector {
  private cache = new Map<string, CacheEntry>()
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly now: () => number

  constructor(private readonly opts: ContractInspectorOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000
    this.maxCacheEntries = opts.maxCacheEntries ?? 5000
    this.now = opts.now ?? Date.now
  }

  async inspect(subject: string, chainKey: string): Promise<ContractFacts> {
    const address = subject.toLowerCase()
    const key = `${chainKey}:${address}`
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.facts

    const reader = this.opts.readers[chainKey]
    // No reader for this chain means we cannot make a claim. Say so rather than reporting a
    // clean EOA, which would read as "checked and fine".
    if (!reader) throw new Error(`no chain reader configured for '${chainKey}'`)

    const facts = await withTimeout(this.read(reader, address), this.timeoutMs, `contract inspect ${key}`)
    this.remember(key, facts)
    return facts
  }

  private async read(reader: ChainReader, address: string): Promise<ContractFacts> {
    const code = await reader.getCode(address)
    if (!code || code === '0x') return { isContract: false, proxy: false }

    // Proxy detection and controller discovery are independent; neither should mask the other.
    const [implementation, slotAdmin, owner, adminFn] = await Promise.all([
      reader.getStorageAt(address, SLOT_IMPLEMENTATION).then(wordToAddress, () => undefined),
      reader.getStorageAt(address, SLOT_ADMIN).then(wordToAddress, () => undefined),
      reader.call({ to: address, data: SELECTOR_OWNER }).then(wordToAddress, () => undefined),
      reader.call({ to: address, data: SELECTOR_ADMIN }).then(wordToAddress, () => undefined),
    ])

    return {
      isContract: true,
      proxy: implementation !== undefined,
      implementation,
      // Prefer the proxy admin: on an upgradeable contract it is the address that can swap the
      // code out, which outranks whatever the implementation calls its owner.
      controller: slotAdmin ?? adminFn ?? owner,
    }
  }

  private remember(key: string, facts: ContractFacts): void {
    if (this.cache.size >= this.maxCacheEntries) {
      // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { facts, expiresAt: this.now() + this.cacheTtlMs })
  }
}
