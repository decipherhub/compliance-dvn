import { describe, it, expect } from 'vitest'
import { briefError } from '../runtime/errors'

/**
 * The shapes ethers actually produced against OP Sepolia, trimmed to the fields the formatter
 * reads. Both filled hundreds of characters of log line with the transaction and receipt.
 */
const REVERTING_ESTIMATE = Object.assign(
  new Error(
    'cannot estimate gas; transaction may fail or may require manual gas limit ' +
      '[ See: https://links.ethers.org/v5-errors-UNPREDICTABLE_GAS_LIMIT ] (error={"reason":"execution reverted",' +
      '"code":"UNPREDICTABLE_GAS_LIMIT","transaction":{"data":"0x0894edf1…very long…"}}, tx={…})',
  ),
  {
    code: 'UNPREDICTABLE_GAS_LIMIT',
    reason: 'execution reverted',
    error: { code: 'SERVER_ERROR', error: { code: 3, data: '0x4c3118d4' } },
  },
)

const MINED_REVERT = Object.assign(
  new Error(
    'transaction failed [ See: https://links.ethers.org/v5-errors-CALL_EXCEPTION ] ' +
      '(transactionHash="0x12ae45e1bb541e2770911046e940f72e03ba95355bb483baf4c0500345a73aed", ' +
      'transaction={…}, receipt={…}, code=CALL_EXCEPTION, version=providers/5.8.0)',
  ),
  {
    code: 'CALL_EXCEPTION',
    transactionHash: '0x12ae45e1bb541e2770911046e940f72e03ba95355bb483baf4c0500345a73aed',
    receipt: { status: 0 },
  },
)

describe('briefError', () => {
  it('names the custom error instead of dumping the transaction', () => {
    const out = briefError(REVERTING_ESTIMATE)
    expect(out).toContain('UNPREDICTABLE_GAS_LIMIT')
    expect(out).toContain('LZ_ULN_Verifying')
    expect(out).not.toContain('0x0894edf1') // no calldata
    expect(out.length).toBeLessThan(120)
    // Shorter than the message it replaces — and the real one, with the full transaction inlined,
    // ran past a thousand characters where this fixture is abridged.
    expect(out.length).toBeLessThan(REVERTING_ESTIMATE.message.length / 2)
  })

  it('keeps the transaction hash for a revert that was mined', () => {
    const out = briefError(MINED_REVERT)
    expect(out).toContain('CALL_EXCEPTION')
    expect(out).toContain('tx 0x12ae45e1bb541e2770911046e940f72e03ba95355bb483baf4c0500345a73aed')
    expect(out).not.toContain('receipt')
    expect(out.length).toBeLessThan(140)
  })

  // Revert output and calldata both arrive under `data`; only one of them is an explanation.
  it('does not mistake calldata for revert output', () => {
    const noRevert = Object.assign(new Error('server error'), {
      code: 'SERVER_ERROR',
      data: '0x0894edf1' + 'ab'.repeat(200),
    })
    expect(briefError(noRevert)).not.toContain('revert')
  })

  it('leaves ordinary errors as they were', () => {
    expect(briefError(new Error('rpc down'))).toBe('rpc down')
    expect(briefError('plain string')).toBe('plain string')
    expect(briefError(undefined)).toBe('undefined')
  })

  it('reports an unmapped selector as its raw value rather than hiding it', () => {
    const unknown = Object.assign(new Error('cannot estimate gas'), {
      code: 'UNPREDICTABLE_GAS_LIMIT',
      error: { error: { code: 3, data: '0xdeadbeef00000000' } },
    })
    expect(briefError(unknown)).toContain('revert 0xdeadbeef')
  })
})
