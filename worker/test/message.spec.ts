import { describe, it, expect } from 'vitest'
import { decodeOftMessage } from '../chain/message'

describe('decodeOftMessage', () => {
  it('decodes sendTo + amountSD', () => {
    const sendTo = '000000000000000000000000' + 'cc'.repeat(20)
    const amountSD = '0000000000000064'
    const m = decodeOftMessage('0x' + sendTo + amountSD)
    expect(m.toAddress).toBe('0x' + 'cc'.repeat(20))
    expect(m.amountSD).toBe(100n)
    expect(m.composed).toBe(false)
  })
})
