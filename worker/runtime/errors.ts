/**
 * Compact rendering of chain errors for the log.
 *
 * ethers puts the entire transaction and receipt into `error.message`, so logging it verbatim buries
 * one line of meaning under a kilobyte of hex that is already available from the tx hash. What an
 * operator needs is the error class, the revert reason, and the transaction to look at.
 */

/**
 * Custom-error selectors worth naming, since a bare `0x4c3118d4` in a log is unreadable.
 *
 * Selector collisions across contracts are possible in principle; these are the ones this worker
 * actually provokes, so the mapping is unambiguous in practice.
 */
const SELECTORS: Record<string, string> = {
  // Our DVN
  '0x7c214f04': 'NotOperator',
  '0x7f2e1049': 'NotSendLibrary',
  '0x60df9f87': 'UnknownAction',
  '0xa0940ea9': 'VerificationRequiresAllow',
  '0x61c9fc06': 'AllowNotSeparatelyRecorded',
  '0x118cdaa7': 'OwnableUnauthorizedAccount',
  // LayerZero ULN / endpoint. LZ_ULN_Verifying doubles as "already committed" — committing deletes
  // the attestation the ULN would otherwise find, so the two states share one error.
  '0x4c3118d4': 'LZ_ULN_Verifying (or already committed)',
  '0xc09b6350': 'LZ_InvalidNonce',
  '0x0177e1ca': 'LZ_PathNotVerifiable',
  '0xc9bf37b7': 'LZ_ULN_InvalidPacketHeader',
  '0x3a9ae7b9': 'LZ_ULN_InvalidPacketVersion',
  '0xb24ab92f': 'LZ_ULN_Unauthorized',
  '0x6592671c': 'LZ_ULN_InvalidWorkerOptions',
}

/** Revert data, wherever ethers nested it. Only accepted alongside a revert signal. */
function revertData(err: unknown): string | undefined {
  for (let e = err as Record<string, unknown> | undefined, depth = 0; e && depth < 6; depth++) {
    const data = e.data
    // `code: 3` is the JSON-RPC execution-reverted code; requiring it (or an explicit reason) keeps
    // calldata — which also lives under `data` on some layers — from being read as revert output.
    const reverted = e.code === 3 || /execution reverted/i.test(String(e.reason ?? ''))
    if (reverted && typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase()
    e = e.error as Record<string, unknown> | undefined
  }
  return undefined
}

/** The message up to the point ethers starts dumping structures into it. */
function firstClause(message: string): string {
  return message.split(/\s*(?:\[ See:|\(error=|\(transaction=|\(transactionHash=)/)[0].trim()
}

/**
 * One line: error class, named revert, and the transaction to inspect.
 *
 * Non-chain errors fall through to their own message, so a plain `new Error('rpc down')` reads the
 * same as it always did.
 */
export function briefError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const e = err as Record<string, any>
  const bits: string[] = []

  if (typeof e.code === 'string') bits.push(e.code)

  // Why it failed, best available: the named revert beats ethers' generic prose. The message clause
  // is the fallback, not an addition — "cannot estimate gas; transaction may fail or may require
  // manual gas limit" says nothing once `revert LZ_ULN_Verifying` is on the line.
  const selector = revertData(err)
  if (selector) bits.push(`revert ${SELECTORS[selector] ?? selector}`)
  else if (typeof e.reason === 'string' && e.reason) bits.push(e.reason)
  else bits.push(firstClause(String(e.message ?? '')))

  const tx = e.transactionHash ?? e.receipt?.transactionHash
  if (typeof tx === 'string') bits.push(`tx ${tx}`)

  const line = bits.filter(Boolean).join(' · ')
  return line || String(err)
}
