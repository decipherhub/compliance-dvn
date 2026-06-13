import { describe, it, expect } from 'vitest'
import { buildTrace } from '../tracker/trace'
import { Denylist } from '../assess/store'
import { makeAssessor } from '../assess/assess'

describe('buildTrace', () => {
  it('colors endpoints with assess() and reports status', () => {
    const dl = new Denylist()
    dl.add('0x00000000000000000000000000000000000000aa', 'ofac', 'sdn')
    const assess = makeAssessor(dl)
    const apiResponse = {
      data: [{
        pathway: {
          srcEid: 40232, dstEid: 40245,
          sender: { address: '0x00000000000000000000000000000000000000AA' },
          receiver: { address: '0x00000000000000000000000000000000000000bb' },
        },
        status: { name: 'INFLIGHT' }, guid: '0xguid',
      }],
    }
    const t = buildTrace(apiResponse, assess)
    expect(t.srcEid).toBe(40232)
    expect(t.dstEid).toBe(40245)
    expect(t.status).toBe('INFLIGHT')
    expect(t.sender.blocked).toBe(true)
    expect(t.receiver.blocked).toBe(false)
  })
})
