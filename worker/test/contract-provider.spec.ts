import { describe, it, expect, vi } from 'vitest'
import { RpcContractInspector, type ChainReader } from '../assess/providers/contract'

const ADDR = '0x' + 'a'.repeat(40)
const IMPL = '0x' + 'b'.repeat(40)
const ADMIN = '0x' + 'c'.repeat(40)
const OWNER = '0x' + 'd'.repeat(40)

const SLOT_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const EMPTY_WORD = '0x' + '0'.repeat(64)

/** Right-align an address into a 32-byte word, the way storage and returndata hold it. */
const word = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')

function reader(overrides: Partial<ChainReader> = {}): ChainReader {
  return {
    getCode: async () => '0x60006000',
    getStorageAt: async () => EMPTY_WORD,
    call: async () => EMPTY_WORD,
    ...overrides,
  }
}

describe('RpcContractInspector', () => {
  it('reports an EOA without probing further', async () => {
    const getStorageAt = vi.fn(async () => EMPTY_WORD)
    const inspector = new RpcContractInspector({ readers: { base: reader({ getCode: async () => '0x', getStorageAt }) } })
    expect(await inspector.inspect(ADDR, 'base')).toEqual({ isContract: false, proxy: false })
    expect(getStorageAt).not.toHaveBeenCalled()
  })

  it('detects an EIP-1967 proxy and its implementation', async () => {
    const inspector = new RpcContractInspector({
      readers: {
        base: reader({
          getStorageAt: async (_a, slot) => (slot === SLOT_IMPLEMENTATION ? word(IMPL) : EMPTY_WORD),
        }),
      },
    })
    const facts = await inspector.inspect(ADDR, 'base')
    expect(facts.isContract).toBe(true)
    expect(facts.proxy).toBe(true)
    expect(facts.implementation).toBe(IMPL)
  })

  it('is not a proxy when the implementation slot is empty', async () => {
    const inspector = new RpcContractInspector({ readers: { base: reader() } })
    const facts = await inspector.inspect(ADDR, 'base')
    expect(facts.proxy).toBe(false)
    expect(facts.implementation).toBeUndefined()
  })

  it('prefers the proxy admin slot over owner(), since it can swap the code out', async () => {
    const inspector = new RpcContractInspector({
      readers: {
        base: reader({
          getStorageAt: async (_a, slot) => (slot === SLOT_ADMIN ? word(ADMIN) : EMPTY_WORD),
          call: async () => word(OWNER),
        }),
      },
    })
    expect((await inspector.inspect(ADDR, 'base')).controller).toBe(ADMIN)
  })

  it('falls back to owner() when no admin slot is set', async () => {
    const inspector = new RpcContractInspector({ readers: { base: reader({ call: async () => word(OWNER) }) } })
    expect((await inspector.inspect(ADDR, 'base')).controller).toBe(OWNER)
  })

  it('has no controller when the contract exposes neither', async () => {
    const inspector = new RpcContractInspector({ readers: { base: reader() } })
    expect((await inspector.inspect(ADDR, 'base')).controller).toBeUndefined()
  })

  it('tolerates a reverting owner()/admin() without failing the whole inspection', async () => {
    const inspector = new RpcContractInspector({
      readers: {
        base: reader({
          call: async () => { throw new Error('execution reverted') },
          getStorageAt: async (_a, slot) => (slot === SLOT_IMPLEMENTATION ? word(IMPL) : EMPTY_WORD),
        }),
      },
    })
    const facts = await inspector.inspect(ADDR, 'base')
    expect(facts.proxy).toBe(true) // proxy detection still succeeded
    expect(facts.controller).toBeUndefined()
  })

  it('caches within the TTL and re-reads after it', async () => {
    let t = 1000
    const getCode = vi.fn(async () => '0x60006000')
    const inspector = new RpcContractInspector({
      readers: { base: reader({ getCode }) },
      cacheTtlMs: 5000,
      now: () => t,
    })
    await inspector.inspect(ADDR, 'base')
    await inspector.inspect(ADDR.toUpperCase(), 'base') // same address, different case
    expect(getCode).toHaveBeenCalledTimes(1)
    t = 6001
    await inspector.inspect(ADDR, 'base')
    expect(getCode).toHaveBeenCalledTimes(2)
  })

  it('caches per chain, not per address', async () => {
    const getCode = vi.fn(async () => '0x60006000')
    const inspector = new RpcContractInspector({ readers: { base: reader({ getCode }), opt: reader({ getCode }) } })
    await inspector.inspect(ADDR, 'base')
    await inspector.inspect(ADDR, 'opt')
    expect(getCode).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest entry past maxCacheEntries', async () => {
    const getCode = vi.fn(async () => '0x60006000')
    const inspector = new RpcContractInspector({ readers: { base: reader({ getCode }) }, maxCacheEntries: 2 })
    await inspector.inspect('0x' + '1'.repeat(40), 'base')
    await inspector.inspect('0x' + '2'.repeat(40), 'base')
    await inspector.inspect('0x' + '3'.repeat(40), 'base') // evicts the first
    expect(getCode).toHaveBeenCalledTimes(3)
    await inspector.inspect('0x' + '1'.repeat(40), 'base') // must re-read
    expect(getCode).toHaveBeenCalledTimes(4)
  })

  it('rejects rather than hangs when the RPC stalls', async () => {
    const inspector = new RpcContractInspector({
      readers: { base: reader({ getCode: () => new Promise(() => {}) }) },
      timeoutMs: 10,
    })
    await expect(inspector.inspect(ADDR, 'base')).rejects.toThrow(/timed out after 10ms/)
  })

  it('rejects for an unconfigured chain rather than reporting a clean EOA', async () => {
    const inspector = new RpcContractInspector({ readers: { base: reader() } })
    await expect(inspector.inspect(ADDR, 'unknownChain')).rejects.toThrow(/no chain reader configured/)
  })

  it('does not cache a failed inspection', async () => {
    let fail = true
    const getCode = vi.fn(async () => {
      if (fail) throw new Error('rpc down')
      return '0x60006000'
    })
    const inspector = new RpcContractInspector({ readers: { base: reader({ getCode }) } })
    await expect(inspector.inspect(ADDR, 'base')).rejects.toThrow(/rpc down/)
    fail = false
    expect((await inspector.inspect(ADDR, 'base')).isContract).toBe(true)
  })
})
