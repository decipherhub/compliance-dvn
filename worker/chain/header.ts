export interface PacketHeader {
  version: number
  nonce: bigint
  srcEid: number
  sender: string
  senderAddress: string
  dstEid: number
  receiver: string
  receiverAddress: string
}

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Decode the LayerZero V2 81-byte packet header. */
export function decodeHeader(headerHex: string): PacketHeader {
  const h = stripHex(headerHex)
  if (h.length !== 81 * 2) throw new Error(`header must be 81 bytes, got ${h.length / 2}`)
  const slice = (startByte: number, lenBytes: number) => h.slice(startByte * 2, (startByte + lenBytes) * 2)
  const sender = '0x' + slice(13, 32)
  const receiver = '0x' + slice(49, 32)
  return {
    version: parseInt(slice(0, 1), 16),
    nonce: BigInt('0x' + slice(1, 8)),
    srcEid: parseInt(slice(9, 4), 16),
    sender,
    senderAddress: '0x' + slice(13 + 12, 20),
    dstEid: parseInt(slice(45, 4), 16),
    receiver,
    receiverAddress: '0x' + slice(49 + 12, 20),
  }
}
