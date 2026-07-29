import { describe, it, expect } from 'vitest'
import { buildTrace } from '../tracker/trace'
import { RiskStore } from '../assess/store'
import { makeAssessor } from '../assess/assess'

describe('buildTrace', () => {
  it('colors endpoints with assess() and reports status', async () => {
    const store = new RiskStore()
    store.upsert({ subject: '0x00000000000000000000000000000000000000aa', labels: ['sanctions'], source: 'ofac' })
    const assess = makeAssessor(store)
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
    const t = await buildTrace(apiResponse, assess)
    expect(t.srcEid).toBe(40232)
    expect(t.dstEid).toBe(40245)
    expect(t.status).toBe('INFLIGHT')
    expect(t.sender.action).toBe('block')
    expect(t.receiver.action).toBe('allow')
  })
})
