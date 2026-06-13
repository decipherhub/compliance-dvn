import { describe, it, expect } from 'vitest'
import { makeAssessor, combine } from '../assess/assess'
import { Denylist } from '../assess/store'

describe('assess + combine', () => {
  const dl = new Denylist()
  dl.add('0x00000000000000000000000000000000000000aa', 'ofac', 'sdn')
  const assess = makeAssessor(dl)

  it('flags a denylisted address as blocked', () => {
    const r = assess('0x00000000000000000000000000000000000000AA')
    expect(r.blocked).toBe(true)
    expect(r.tags).toContain('ofac')
    expect(r.score).toBe(100)
  })

  it('passes a clean address', () => {
    const r = assess('0x00000000000000000000000000000000000000bb')
    expect(r.blocked).toBe(false)
    expect(r.score).toBe(0)
  })

  it('combine blocks if any party is blocked', () => {
    const clean = assess('0x00000000000000000000000000000000000000bb')
    const bad = assess('0x00000000000000000000000000000000000000aa')
    expect(combine([clean, clean]).blocked).toBe(false)
    expect(combine([clean, bad, clean]).blocked).toBe(true)
    expect(combine([clean, bad]).reasons.length).toBeGreaterThan(0)
  })
})
