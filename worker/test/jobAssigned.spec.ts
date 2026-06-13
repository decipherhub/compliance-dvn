import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { DVN_EVENT_ABI, decodeJobAssignedPayloadHash } from '../chain/events'

describe('JobAssigned decoding', () => {
  it('round-trips the payloadHash from an encoded JobAssigned log', () => {
    const iface = new ethers.utils.Interface(DVN_EVENT_ABI)
    const ev = iface.getEvent('JobAssigned')
    const payloadHash = '0x' + '11'.repeat(32)
    const log = iface.encodeEventLog(ev, [40245, payloadHash, 5, '0x' + 'aa'.repeat(20)])

    const decoded = decodeJobAssignedPayloadHash(iface, log.data, log.topics)
    expect(decoded).toBe(payloadHash.toLowerCase())
  })
})
