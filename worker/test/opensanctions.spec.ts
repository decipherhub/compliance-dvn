import { describe, it, expect } from 'vitest'
import { parseOpenSanctionsNdjson } from '../assess/ingest/opensanctions'

describe('OpenSanctions ingest', () => {
  it('extracts EVM publicKey values from CryptoWallet entities', () => {
    const ndjson = [
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['0x1234567890123456789012345678901234567890'], currency: ['ETH'] } }),
      JSON.stringify({ schema: 'Person', properties: { name: ['Bob'] } }),
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['bc1qxyz'] } }),
      '',
    ].join('\n')
    expect(parseOpenSanctionsNdjson(ndjson)).toEqual(['0x1234567890123456789012345678901234567890'])
  })
})
