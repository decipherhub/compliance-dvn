import { describe, it, expect } from 'vitest'
import { decodeHeader } from '../chain/header'

describe('decodeHeader', () => {
  it('decodes the 81-byte packet header', () => {
    const hex =
      '01' +
      '0000000000000007' +
      '00009d28' +
      '000000000000000000000000' + 'aa'.repeat(20) +
      '00009d35' +
      '000000000000000000000000' + 'bb'.repeat(20)
    const h = decodeHeader('0x' + hex)
    expect(h.version).toBe(1)
    expect(h.nonce).toBe(7n)
    expect(h.srcEid).toBe(40232)
    expect(h.dstEid).toBe(40245)
    expect(h.senderAddress).toBe('0x' + 'aa'.repeat(20))
    expect(h.receiverAddress).toBe('0x' + 'bb'.repeat(20))
  })
})
