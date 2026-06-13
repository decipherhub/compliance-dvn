import { describe, it, expect } from 'vitest'
import { ingestMixers, MIXER_ADDRESSES } from '../assess/ingest/mixers'
import { loadTestDenylist } from '../assess/testDenylist'
import { Denylist } from '../assess/store'

describe('mixers + test denylist', () => {
  it('loads curated mixer addresses', () => {
    const dl = new Denylist()
    ingestMixers(dl)
    expect(dl.size).toBe(MIXER_ADDRESSES.length)
    expect(dl.lookup(MIXER_ADDRESSES[0])?.tags).toContain('mixer')
  })

  it('loads operator test entries from env CSV', () => {
    const dl = new Denylist()
    loadTestDenylist(dl, '0xdeadbeef00000000000000000000000000000001,0xDEADBEEF00000000000000000000000000000002')
    expect(dl.has('0xdeadbeef00000000000000000000000000000001')).toBe(true)
    expect(dl.lookup('0xdeadbeef00000000000000000000000000000002')?.tags).toContain('test')
  })
})
