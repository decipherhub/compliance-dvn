import { describe, it, expect } from 'vitest'
import { ingestMixers, MIXER_ADDRESSES } from '../assess/ingest/mixers'
import { loadTestDenylist } from '../assess/testDenylist'
import { RiskStore } from '../assess/store'

describe('mixers + test denylist', () => {
  it('loads curated mixer addresses with ofac authority', () => {
    const store = new RiskStore()
    ingestMixers(store)
    expect(store.size).toBe(MIXER_ADDRESSES.length)
    const entry = store.lookup(MIXER_ADDRESSES[0])[0]
    expect(entry.labels).toContain('sanctioned_mixer')
    expect(entry.source).toBe('ofac')
    expect(entry.subjectType).toBe('contract')
  })

  it('loads operator test entries from env CSV', () => {
    const store = new RiskStore()
    loadTestDenylist(store, '0xdeadbeef00000000000000000000000000000001,0xDEADBEEF00000000000000000000000000000002')
    expect(store.has('0xdeadbeef00000000000000000000000000000001')).toBe(true)
    const entry = store.lookup('0xdeadbeef00000000000000000000000000000002')[0]
    expect(entry.labels).toContain('operator_deny')
    expect(entry.source).toBe('operator')
  })
})
