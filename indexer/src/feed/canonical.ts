/**
 * Deterministic JSON: object keys sorted, arrays left in order, no whitespace.
 *
 * MUST stay byte-for-byte identical to `worker/assess/canonical.ts`. The two live in separate
 * packages with separate Docker builds, so this is a deliberate copy rather than a shared import;
 * `test/canonical.spec.ts` pins the output against the same fixture the worker's suite uses, so
 * drift fails a test instead of silently breaking every signature.
 *
 * Non-integer numbers are rejected because float formatting is not guaranteed to round-trip
 * identically across languages — a document carrying one could hash differently on each side.
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
