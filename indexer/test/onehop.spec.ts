import { describe, it, expect, beforeEach } from 'vitest'
import { computeOneHop, outboundLabels, inboundLabels, exposureCounts, GRAPH_DEPTH } from '../src/graph/onehop'
import { IngestStore } from '../src/ingest/store'
import { applySchema, memDb, seedFixture } from './helpers/memdb'
import type { Db } from '../src/db'

const SANCTIONED = '0x' + 'a'.repeat(40)
const MIXER = '0x' + 'b'.repeat(40)
const SUBJECT = '0x' + '1'.repeat(40)
const OTHER = '0x' + '2'.repeat(40)
const TOKEN = '0x' + 'd'.repeat(40)
const UNTRACKED_TOKEN = '0x' + 'e'.repeat(40)

// 0.01 ETH in wei — the inbound threshold from the worker's N_HOP policy.
const MIN = '10000000000000000'

let db: ReturnType<typeof memDb>

beforeEach(() => {
  db = memDb()
  applySchema(db)
})

describe('graph depth', () => {
  // Depth is a policy decision, not an implementation detail. Pinning it here means raising it
  // requires deliberately changing this expectation.
  it('is fixed at 1, matching the worker N_HOP policy', () => {
    expect(GRAPH_DEPTH).toBe(1)
  })

  it('does not label a subject two hops from a seed', async () => {
    // SUBJECT -> OTHER -> SANCTIONED. Only OTHER is one hop away.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '1', logIndex: 1 },
      ],
    })
    expect(await computeOneHop(db)).toEqual([{ subject: OTHER, labels: ['sanctions_1hop'] }])
  })
})

describe('outbound labels (subject -> seed)', () => {
  it('labels a subject that sent to a sanctioned address, at any value', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }], // 1 wei is enough
    })
    expect(await outboundLabels(db)).toEqual([{ subject: SUBJECT, label: 'sanctions_1hop' }])
  })

  it('needs no token minimum configured — sending is the subject own act', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: UNTRACKED_TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    expect((await outboundLabels(db)).length).toBe(1)
  })

  it('maps a sanctioned mixer to mixer_exposure', async () => {
    await seedFixture(db, {
      seeds: [{ subject: MIXER, label: 'sanctioned_mixer' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: MIXER, value: '1' }],
    })
    expect(await outboundLabels(db)).toEqual([{ subject: SUBJECT, label: 'mixer_exposure' }])
  })

  it('does not label the seed itself when it moves funds', async () => {
    await seedFixture(db, {
      seeds: [
        { subject: SANCTIONED, label: 'sanctions' },
        { subject: MIXER, label: 'sanctioned_mixer' },
      ],
      edges: [{ token: TOKEN, from: SANCTIONED, to: MIXER, value: '1' }],
    })
    expect(await outboundLabels(db)).toEqual([])
  })

  it('ignores a self-transfer', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SANCTIONED, value: '1' }],
    })
    expect(await outboundLabels(db)).toEqual([])
  })

  it('leaves an unrelated subject unlabelled', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: OTHER, value: '1' }],
    })
    expect(await outboundLabels(db)).toEqual([])
  })
})

describe('inbound labels (seed -> subject)', () => {
  it('labels a subject that received at or above the minimum', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await inboundLabels(db)).toEqual([{ subject: SUBJECT, label: 'sanctions_1hop_inbound' }])
  })

  // The dusting defence: a sanctioned address paying a victim 1 wei must not taint them.
  it('IGNORES a dust transfer below the minimum', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: '1' }],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await inboundLabels(db)).toEqual([])
  })

  // No configured minimum means we cannot judge the amount, so we do not label at all. A
  // permissive default here would turn every dust transfer into evidence.
  it('does not label a token with no configured minimum', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: UNTRACKED_TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
    })
    expect(await inboundLabels(db)).toEqual([])
  })

  it('compares uint256 values numerically, not as strings', async () => {
    // '9' > '1000...' lexicographically but is far smaller numerically. A text comparison would
    // wrongly label this.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: '9' }],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await inboundLabels(db)).toEqual([])
  })

  it('handles a value larger than a JS safe integer', async () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: huge }],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect((await inboundLabels(db)).length).toBe(1)
  })

  it('respects the per-chain minimum, not just the token', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ chain: 'optimismSepolia', token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
      minimums: [{ chain: 'baseSepolia', token: TOKEN, min: MIN }], // configured for a different chain
    })
    expect(await inboundLabels(db)).toEqual([])
  })
})

describe('computeOneHop', () => {
  it('merges both directions into one entry per subject', async () => {
    await seedFixture(db, {
      seeds: [
        { subject: SANCTIONED, label: 'sanctions' },
        { subject: MIXER, label: 'sanctioned_mixer' },
      ],
      edges: [
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', logIndex: 0 },
        { token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN, logIndex: 1 },
        { token: TOKEN, from: SUBJECT, to: MIXER, value: '1', logIndex: 2 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await computeOneHop(db)).toEqual([
      { subject: SUBJECT, labels: ['mixer_exposure', 'sanctions_1hop', 'sanctions_1hop_inbound'] },
    ])
  })

  it('deduplicates repeated edges to the same seed', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '2', logIndex: 1 },
      ],
    })
    expect(await computeOneHop(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })

  it('returns nothing for an empty graph', async () => {
    expect(await computeOneHop(db)).toEqual([])
  })

  it('returns nothing when there are edges but no seeds', async () => {
    await seedFixture(db, { edges: [{ token: TOKEN, from: SUBJECT, to: OTHER, value: '1' }] })
    expect(await computeOneHop(db)).toEqual([])
  })

  it('is stable in subject order, so identical graphs produce identical feeds', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '1', logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', logIndex: 1 },
      ],
    })
    const subjects = (await computeOneHop(db)).map((e) => e.subject)
    expect(subjects).toEqual([...subjects].sort())
  })
})

/**
 * The inbound path is inert until thresholds exist, so the wiring from configuration into
 * `token_minimums` is what actually turns `sanctions_1hop_inbound` on.
 */
describe('inbound thresholds from configuration', () => {
  it('produces no inbound label until thresholds are applied', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
    })
    expect(await computeOneHop(db)).toEqual([]) // nothing configured yet

    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: MIN }])
    expect(await computeOneHop(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop_inbound'] }])
  })

  // Config is the only source of these values, so removing an entry must remove the threshold.
  it('removes a threshold that is no longer configured', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
    })
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: MIN }])
    expect((await computeOneHop(db)).length).toBe(1)

    await store.replaceTokenMinimums([])
    expect(await computeOneHop(db)).toEqual([])
  })

  it('applies the configured value as the actual cutoff', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: '5000' }],
    })
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: '5001' }])
    expect(await computeOneHop(db)).toEqual([]) // just below
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: '5000' }])
    expect((await computeOneHop(db)).length).toBe(1) // exactly at the cutoff counts
  })

  it('lowercases the token so a checksummed config entry still matches', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
    })
    await store.replaceTokenMinimums([
      { chain: 'baseSepolia', token: TOKEN.toUpperCase().replace('0X', '0x'), minValue: MIN },
    ])
    expect((await computeOneHop(db)).length).toBe(1)
  })

  it('leaves outbound labels unaffected by thresholds', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    await store.replaceTokenMinimums([]) // no thresholds at all
    expect(await computeOneHop(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })
})

describe('exposureCounts', () => {
  it('counts distinct seeds a subject touched', async () => {
    await seedFixture(db, {
      seeds: [
        { subject: SANCTIONED, label: 'sanctions' },
        { subject: MIXER, label: 'sanctioned_mixer' },
      ],
      edges: [
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: MIXER, value: '1', logIndex: 1 },
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '5', logIndex: 2 }, // same seed again
      ],
    })
    const counts = await exposureCounts(db)
    expect(counts.find((c) => c.subject === SUBJECT)?.seeds).toBe(2)
  })
})
