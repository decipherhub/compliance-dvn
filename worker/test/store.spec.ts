import { describe, it, expect } from 'vitest'
import { Denylist } from '../assess/store'

describe('Denylist', () => {
  it('normalizes case and detects membership', () => {
    const dl = new Denylist()
    dl.add('0xAAbbCC', 'ofac', 'SDN match')
    expect(dl.has('0xaabbcc')).toBe(true)
    expect(dl.lookup('0xAABBCC')?.tags).toContain('ofac')
    expect(dl.has('0x000001')).toBe(false)
  })

  it('merges multiple sources for the same address', () => {
    const dl = new Denylist()
    dl.add('0x01', 'ofac', 'r1')
    dl.add('0x01', 'mixer', 'r2')
    const e = dl.lookup('0x01')!
    expect(e.tags.sort()).toEqual(['mixer', 'ofac'])
    expect(e.reasons.length).toBe(2)
  })
})
