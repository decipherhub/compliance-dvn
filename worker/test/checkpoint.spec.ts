import { describe, it, expect, afterEach } from 'vitest'
import { Checkpoint } from '../checkpoint'
import { rmSync, existsSync } from 'fs'

const PATH = '/tmp/dvn-checkpoint-test.json'
afterEach(() => { if (existsSync(PATH)) rmSync(PATH) })

describe('Checkpoint', () => {
  it('persists last block per chain and processed packets', () => {
    const c = new Checkpoint(PATH)
    c.setLastBlock('baseSepolia', 100)
    c.markProcessed('0xpackethash')
    c.save()

    const c2 = new Checkpoint(PATH)
    expect(c2.getLastBlock('baseSepolia')).toBe(100)
    expect(c2.isProcessed('0xpackethash')).toBe(true)
    expect(c2.isProcessed('0xother')).toBe(false)
  })

  // The processed set is a dedupe cache, not a ledger: without a bound it grows with every
  // packet ever screened and is rewritten to disk on each save.
  it('evicts the oldest processed keys past the cap', () => {
    const c = new Checkpoint(PATH)
    const cap = 50_000
    for (let i = 0; i <= cap; i++) c.markProcessed(`key-${i}`)
    expect(c.isProcessed('key-0')).toBe(false) // oldest evicted
    expect(c.isProcessed('key-1')).toBe(true)
    expect(c.isProcessed(`key-${cap}`)).toBe(true) // newest kept
  })
})
