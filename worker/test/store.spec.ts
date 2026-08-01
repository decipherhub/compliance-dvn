import { describe, it, expect } from 'vitest'
import { RiskStore } from '../assess/store'

describe('RiskStore', () => {
  it('normalizes case and detects membership', () => {
    const store = new RiskStore()
    store.upsert({ subject: '0xAAbbCC', labels: ['sanctions'], source: 'ofac' })
    expect(store.has('0xaabbcc')).toBe(true)
    expect(store.lookup('0xAABBCC')[0].labels).toContain('sanctions')
    expect(store.has('0x000001')).toBe(false)
  })

  it('keeps one entry per source so each keeps its own TTL and confidence', () => {
    const store = new RiskStore()
    store.upsert({ subject: '0x01', labels: ['sanctions'], source: 'ofac' })
    store.upsert({ subject: '0x01', labels: ['mixer_exposure'], source: 'trusted_indexer' })
    const entries = store.lookup('0x01')
    expect(entries.length).toBe(2)
    expect(entries.map((e) => e.source).sort()).toEqual(['ofac', 'trusted_indexer'])
    expect(store.size).toBe(1) // one subject, two assertions
  })

  it('merges labels and refreshes lastSeen when the same source re-asserts', () => {
    let t = 1000
    const store = new RiskStore({ now: () => t })
    store.upsert({ subject: '0x01', labels: ['sanctions'], source: 'ofac' })
    t = 5000
    store.upsert({ subject: '0x01', labels: ['sanctioned_mixer'], source: 'ofac' })
    const entries = store.lookup('0x01')
    expect(entries.length).toBe(1)
    expect(entries[0].labels.sort()).toEqual(['sanctioned_mixer', 'sanctions'])
    expect(entries[0].firstSeen).toBe(1000)
    expect(entries[0].lastSeen).toBe(5000)
  })

  it('defaults confidence from the source trust table', () => {
    const store = new RiskStore()
    store.upsert({ subject: '0x01', labels: ['sanctions'], source: 'ofac' })
    store.upsert({ subject: '0x02', labels: ['mixer_exposure'], source: 'public_event' })
    expect(store.lookup('0x01')[0].confidence).toBe(1)
    expect(store.lookup('0x02')[0].confidence).toBe(0.3)
  })

  it('hides expired entries without hiding live ones for the same subject', () => {
    let t = 1000
    const store = new RiskStore({ now: () => t })
    store.upsert({ subject: '0x01', labels: ['sanctions'], source: 'ofac' }) // no expiry
    store.upsert({ subject: '0x01', labels: ['mixer_exposure'], source: 'trusted_indexer', expiresAt: 2000 })
    expect(store.lookup('0x01').length).toBe(2)
    t = 2001
    const live = store.lookup('0x01')
    expect(live.length).toBe(1)
    expect(live[0].source).toBe('ofac') // the permanent sanctions label survives the feed's TTL
  })

  it('prunes expired entries and drops subjects left empty', () => {
    let t = 1000
    const store = new RiskStore({ now: () => t })
    store.upsert({ subject: '0x01', labels: ['mixer_exposure'], source: 'trusted_indexer', expiresAt: 2000 })
    store.upsert({ subject: '0x02', labels: ['sanctions'], source: 'ofac' })
    t = 2001
    expect(store.prune()).toBe(1)
    expect(store.has('0x01')).toBe(false)
    expect(store.has('0x02')).toBe(true)
  })

  it('counts live entries per source', () => {
    const store = new RiskStore()
    store.upsert({ subject: '0x01', labels: ['sanctions'], source: 'ofac' })
    store.upsert({ subject: '0x02', labels: ['sanctions'], source: 'ofac' })
    store.upsert({ subject: '0x02', labels: ['mixer_exposure'], source: 'trusted_indexer' })
    expect(store.countsBySource()).toEqual({ ofac: 2, trusted_indexer: 1 })
  })
})
