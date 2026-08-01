/**
 * Deterministic JSON: object keys sorted, arrays left in order, no whitespace.
 *
 * Used wherever two independent implementations must agree on bytes — signing an indexer feed,
 * and hashing an evidence document that the indexer will later re-derive. Non-integer numbers
 * are rejected because float formatting is not guaranteed to round-trip identically across
 * languages, so one carrying a float could hash differently on each side.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) throw new Error('cannot canonicalize undefined')
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error(`non-integer number cannot be canonicalized: ${value}`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
  return `{${parts.join(',')}}`
}
