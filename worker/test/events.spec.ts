import { describe, it, expect } from 'vitest'
import { parseEncodedPacket } from '../chain/events'

describe('parseEncodedPacket', () => {
  it('splits header / guid / message and computes payloadHash', () => {
    const header = '01' + '0000000000000007' + '00009d28' +
      '000000000000000000000000' + 'aa'.repeat(20) + '00009d35' +
      '000000000000000000000000' + 'bb'.repeat(20)
    const guid = '11'.repeat(32)
    const message = '000000000000000000000000' + 'cc'.repeat(20) + '0000000000000064'
    const encoded = '0x' + header + guid + message

    const p = parseEncodedPacket(encoded)
    expect(p.header.length).toBe(2 + 81 * 2)
    expect(p.oft.toAddress).toBe('0x' + 'cc'.repeat(20))
    expect(p.payloadHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(p.dstEid).toBe(40245)
    expect(p.srcEid).toBe(40232)
  })
})
