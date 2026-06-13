import { describe, it, expect } from 'vitest'
import { parseOfacList, ingestOfac } from '../assess/ingest/ofac'
import { Denylist } from '../assess/store'

describe('OFAC ingest', () => {
  it('parses a JSON array of addresses', () => {
    const addrs = parseOfacList(JSON.stringify(['0xAAA', '0xbbb', 'nothex', '']))
    expect(addrs).toEqual(['0xaaa', '0xbbb'])
  })

  it('loads parsed addresses into a denylist', async () => {
    const dl = new Denylist()
    await ingestOfac(dl, async () => JSON.stringify(['0x1234567890123456789012345678901234567890']))
    expect(dl.has('0x1234567890123456789012345678901234567890')).toBe(true)
    expect(dl.lookup('0x1234567890123456789012345678901234567890')?.tags).toContain('ofac')
  })
})
