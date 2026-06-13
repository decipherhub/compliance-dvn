export interface OftMessage { toAddress: string; amountSD: bigint; composed: boolean }

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Decode the OFT message: sendTo[0:32] (address = last 20 bytes), amountSD[32:40]. */
export function decodeOftMessage(messageHex: string): OftMessage {
  const m = stripHex(messageHex)
  if (m.length < 40 * 2) throw new Error(`OFT message must be >= 40 bytes, got ${m.length / 2}`)
  const sendTo = m.slice(0, 64)
  const toAddress = '0x' + sendTo.slice(24)
  const amountSD = BigInt('0x' + m.slice(64, 80))
  return { toAddress, amountSD, composed: m.length > 40 * 2 }
}
