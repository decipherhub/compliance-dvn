import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import { ENDPOINT_ABI, parseEncodedPacket, scanPacketSent } from '../chain/events'

const HEADER =
  '01' + '0000000000000007' + '00009d28' +
  '000000000000000000000000' + 'aa'.repeat(20) + '00009d35' +
  '000000000000000000000000' + 'bb'.repeat(20)
const GUID = '11'.repeat(32)
const OFT_MESSAGE = '000000000000000000000000' + 'cc'.repeat(20) + '0000000000000064'

/** A provider that returns exactly the PacketSent logs we hand it. */
function providerWith(encodedPayloads: string[]): ethers.providers.Provider {
  const iface = new ethers.utils.Interface(ENDPOINT_ABI)
  const logs = encodedPayloads.map((encodedPayload) => {
    const { data, topics } = iface.encodeEventLog(iface.getEvent('PacketSent'), [
      encodedPayload,
      '0x',
      ethers.constants.AddressZero,
    ])
    return { data, topics }
  })
  return { getLogs: async () => logs } as unknown as ethers.providers.Provider
}

describe('scanPacketSent', () => {
  // The endpoint is shared by every OApp on the chain. Before this was handled, one stranger's
  // 16-byte message threw out of the scan, and because the checkpoint freezes on failure the
  // worker retried the same block forever and never advanced again.
  it('skips foreign packets it cannot decode instead of aborting the scan', async () => {
    const ours = '0x' + HEADER + GUID + OFT_MESSAGE
    const foreignShortMessage = '0x' + HEADER + GUID + 'dd'.repeat(16) // real shape seen on OP Sepolia
    const foreignTruncatedHeader = '0x' + 'ee'.repeat(40)
    const onSkip = vi.fn()

    const packets = await scanPacketSent(
      providerWith([foreignShortMessage, ours, foreignTruncatedHeader]),
      '0xendpoint',
      1,
      2,
      onSkip,
    )

    expect(packets).toHaveLength(1)
    expect(packets[0].oft.toAddress).toBe('0x' + 'cc'.repeat(20))
    expect(onSkip).toHaveBeenCalledTimes(2)
    // Skips stay identifiable: the payload hash needs only the split, not a successful decode.
    for (const [payloadHash] of onSkip.mock.calls) expect(payloadHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('does not require an onSkip callback', async () => {
    const packets = await scanPacketSent(providerWith(['0x' + HEADER + GUID + 'dd'.repeat(16)]), '0xe', 1, 2)
    expect(packets).toEqual([])
  })
})

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
