import { describe, it, expect } from 'vitest'
import { parseOfacList, ingestOfac } from '../assess/ingest/ofac'
import { RiskStore } from '../assess/store'

describe('OFAC ingest', () => {
  it('parses a JSON array of addresses', () => {
    const addrs = parseOfacList(JSON.stringify(['0xAAA', '0xbbb', 'nothex', '']))
    expect(addrs).toEqual(['0xaaa', '0xbbb'])
  })

  it('loads parsed addresses into the risk store as ofac sanctions entries', async () => {
    const store = new RiskStore()
    await ingestOfac(store, async () => JSON.stringify(['0x1234567890123456789012345678901234567890']))
    expect(store.has('0x1234567890123456789012345678901234567890')).toBe(true)
    const entry = store.lookup('0x1234567890123456789012345678901234567890')[0]
    expect(entry.labels).toContain('sanctions')
    expect(entry.source).toBe('ofac')
  })
})
