import { beforeEach, describe, expect, it } from 'vitest'

import { GRAPH_DEPTH, computeProximity, exposureCounts, inboundLabels, outboundLabels } from '../src/graph/proximity'
import { IngestStore } from '../src/ingest/store'

import { applySchema, memDb, seedFixture } from './helpers/memdb'


const SANCTIONED = '0x' + 'a'.repeat(40)
const MIXER = '0x' + 'b'.repeat(40)
const SUBJECT = '0x' + '1'.repeat(40)
const OTHER = '0x' + '2'.repeat(40)
const THIRD = '0x' + '3'.repeat(40)
const FOURTH = '0x' + '4'.repeat(40)
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
  it('is fixed at 3, matching the worker N_HOP policy', () => {
    expect(GRAPH_DEPTH).toBe(3)
  })

  // Every edge past the subject's own first hop must clear the token minimum, so with no
  // minimums configured the graph degrades to depth 1 — exactly the pre-v2 behaviour.
  it('does not extend past one hop when no token minimums are configured', async () => {
    // SUBJECT -> OTHER -> SANCTIONED. Only OTHER is one hop away.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '1', logIndex: 1 },
      ],
    })
    expect(await computeProximity(db)).toEqual([{ subject: OTHER, labels: ['sanctions_1hop'] }])
  })
})

describe('multi-hop paths (depth 2-3)', () => {
  it('labels a 2-hop route at sanctions_2hop and the intermediary at 1 hop', async () => {
    // SUBJECT -> OTHER -> SANCTIONED, the relayed edge above the minimum.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 101, logIndex: 1 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await computeProximity(db)).toEqual([
      { subject: SUBJECT, labels: ['sanctions_2hop'] },
      { subject: OTHER, labels: ['sanctions_1hop'] },
    ])
  })

  it('labels a 3-hop route at sanctions_3hop, and stops at GRAPH_DEPTH', async () => {
    // FOURTH -> SUBJECT -> OTHER -> THIRD -> SANCTIONED: SUBJECT is 3 hops out, FOURTH is 4.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: FOURTH, to: SUBJECT, value: MIN, block: 99, logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 1 },
        { token: TOKEN, from: OTHER, to: THIRD, value: MIN, block: 101, logIndex: 2 },
        { token: TOKEN, from: THIRD, to: SANCTIONED, value: MIN, block: 102, logIndex: 3 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    const labelled = await outboundLabels(db)
    expect(labelled).toContainEqual({ subject: SUBJECT, label: 'sanctions_3hop' })
    expect(labelled.find((l) => l.subject === FOURTH)).toBeUndefined() // 4 hops: out of reach
  })

  it('reports the closest approach only, not every longer route', async () => {
    // A direct edge AND a 2-hop route to the same seed class -> just sanctions_1hop.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', block: 100, logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 1 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 101, logIndex: 2 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await outboundLabels(db)).toContainEqual({ subject: SUBJECT, label: 'sanctions_1hop' })
    expect(await outboundLabels(db)).not.toContainEqual({ subject: SUBJECT, label: 'sanctions_2hop' })
  })

  // The smear defence: someone the subject once paid later dusts a sanctioned address. The
  // dust edge is not the subject's act, so below the minimum it cannot extend a path to them.
  it('does not extend a path over a relayed edge below the minimum', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: MIN, block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '1', block: 101, logIndex: 1 }, // dust
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect((await outboundLabels(db)).find((l) => l.subject === SUBJECT)).toBeUndefined()
    // The dusting intermediary still earns its own 1-hop label — sending was its act.
    expect(await outboundLabels(db)).toContainEqual({ subject: OTHER, label: 'sanctions_1hop' })
  })

  // Funds cannot flow backwards in time: the relayed edge predates the subject's own.
  it('rejects a path whose hops go backwards in block order', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 100, logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 200, logIndex: 1 }, // later
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect((await outboundLabels(db)).find((l) => l.subject === SUBJECT)).toBeUndefined()
  })

  it('does not chain hops across different chains', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { chain: 'baseSepolia', token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 0 },
        { chain: 'optimismSepolia', token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 200, logIndex: 1 },
      ],
      minimums: [
        { chain: 'baseSepolia', token: TOKEN, min: MIN },
        { chain: 'optimismSepolia', token: TOKEN, min: MIN },
      ],
    })
    expect((await outboundLabels(db)).find((l) => l.subject === SUBJECT)).toBeUndefined()
  })

  // A route through another sanctioned address is that address's proximity, not a longer path.
  it('does not route a path through a seed', async () => {
    await seedFixture(db, {
      seeds: [
        { subject: SANCTIONED, label: 'sanctions' },
        { subject: MIXER, label: 'sanctioned_mixer' },
      ],
      edges: [
        { token: TOKEN, from: SUBJECT, to: MIXER, value: '1', block: 100, logIndex: 0 },
        { token: TOKEN, from: MIXER, to: SANCTIONED, value: MIN, block: 101, logIndex: 1 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    // Direct mixer exposure, but no sanctions_2hop "through" the mixer.
    expect(await outboundLabels(db)).toEqual([{ subject: SUBJECT, label: 'mixer_exposure' }])
  })

  it('grades mixer proximity by depth too', async () => {
    await seedFixture(db, {
      seeds: [{ subject: MIXER, label: 'sanctioned_mixer' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: MIXER, value: MIN, block: 101, logIndex: 1 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await outboundLabels(db)).toContainEqual({ subject: SUBJECT, label: 'mixer_exposure_2hop' })
  })

  it('labels inbound multi-hop receipt when every edge clears the minimum', async () => {
    // SANCTIONED -> OTHER -> SUBJECT, both edges above the minimum.
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SANCTIONED, to: OTHER, value: MIN, block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SUBJECT, value: MIN, block: 101, logIndex: 1 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    const labelled = await inboundLabels(db)
    expect(labelled).toContainEqual({ subject: SUBJECT, label: 'sanctions_2hop_inbound' })
    expect(labelled).toContainEqual({ subject: OTHER, label: 'sanctions_1hop_inbound' })
  })

  /**
   * Mints and burns are Transfer events to/from the zero address, and an OFT cross-chain send is
   * exactly that pair. Left as a vertex it joins every holder to every other one: here B burned
   * (cross-chain send) and the token later minted to OTHER, who paid a sanctioned address — two
   * unrelated supply events that must not put B two hops from a seed.
   */
  it('never routes a path through the zero address (mint/burn)', async () => {
    const ZERO = '0x' + '0'.repeat(40)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: ZERO, value: MIN, block: 100, logIndex: 0 }, // burn
        { token: TOKEN, from: ZERO, to: OTHER, value: MIN, block: 101, logIndex: 1 }, // mint
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 102, logIndex: 2 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    const labelled = await outboundLabels(db)
    expect(labelled).toContainEqual({ subject: OTHER, label: 'sanctions_1hop' })
    expect(labelled.find((l) => l.subject === SUBJECT)).toBeUndefined() // no 3-hop via 0x0
    expect(labelled.find((l) => l.subject === ZERO)).toBeUndefined() // 0x0 is not an actor
  })

  it('does not label inbound receipt when the final edge is dust', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SANCTIONED, to: OTHER, value: MIN, block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SUBJECT, value: '1', block: 101, logIndex: 1 }, // dust
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect((await inboundLabels(db)).find((l) => l.subject === SUBJECT)).toBeUndefined()
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

describe('computeProximity', () => {
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
    expect(await computeProximity(db)).toEqual([
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
    expect(await computeProximity(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })

  it('returns nothing for an empty graph', async () => {
    expect(await computeProximity(db)).toEqual([])
  })

  it('returns nothing when there are edges but no seeds', async () => {
    await seedFixture(db, { edges: [{ token: TOKEN, from: SUBJECT, to: OTHER, value: '1' }] })
    expect(await computeProximity(db)).toEqual([])
  })

  it('is stable in subject order, so identical graphs produce identical feeds', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: '1', logIndex: 0 },
        { token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', logIndex: 1 },
      ],
    })
    const subjects = (await computeProximity(db)).map((e) => e.subject)
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
    expect(await computeProximity(db)).toEqual([]) // nothing configured yet

    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: MIN }])
    expect(await computeProximity(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop_inbound'] }])
  })

  // Config is the only source of these values, so removing an entry must remove the threshold.
  it('removes a threshold that is no longer configured', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: MIN }],
    })
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: MIN }])
    expect((await computeProximity(db)).length).toBe(1)

    await store.replaceTokenMinimums([])
    expect(await computeProximity(db)).toEqual([])
  })

  it('applies the configured value as the actual cutoff', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: '5000' }],
    })
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: '5001' }])
    expect(await computeProximity(db)).toEqual([]) // just below
    await store.replaceTokenMinimums([{ chain: 'baseSepolia', token: TOKEN, minValue: '5000' }])
    expect((await computeProximity(db)).length).toBe(1) // exactly at the cutoff counts
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
    expect((await computeProximity(db)).length).toBe(1)
  })

  it('leaves outbound labels unaffected by thresholds', async () => {
    const store = new IngestStore(db)
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1' }],
    })
    await store.replaceTokenMinimums([]) // no thresholds at all
    expect(await computeProximity(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })
})

/**
 * Cross-chain sends.
 *
 * The burn/mint pair a bridged transfer leaves behind is not a counterparty relationship, and the
 * zero address is excluded from every path, so a bridged send used to reach a sanctioned address
 * without leaving anything the graph could see. The scanner now records the real pair as a `bridge`
 * edge; these tests pin what such an edge may and may not be used for.
 */
describe('bridge edges', () => {
  const BRIDGE = { kind: 'bridge', dstChain: 'optimismSepolia' }

  it('labels a sender who bridged straight to a sanctioned address', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SUBJECT, to: SANCTIONED, value: '1', ...BRIDGE }],
    })
    expect(await computeProximity(db)).toEqual([{ subject: SUBJECT, labels: ['sanctions_1hop'] }])
  })

  // The recipient of a bridge edge holds those funds on ANOTHER chain, so its activity on this one
  // is unrelated money. Following it would manufacture a path that no funds could have taken.
  it('never continues a path past a bridge edge', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        // SUBJECT bridged to OTHER (funds now on OP), and OTHER separately paid a sanctioned
        // address on this chain. SUBJECT is not 2 hops from the seed by way of that.
        { token: TOKEN, from: SUBJECT, to: OTHER, value: MIN, block: 100, logIndex: 0, ...BRIDGE },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 101, logIndex: 1 },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await computeProximity(db)).toEqual([{ subject: OTHER, labels: ['sanctions_1hop'] }])
  })

  // A bridge as the LAST hop is sound: the funds moved same-chain to the intermediary, which then
  // bridged them onward to the seed.
  it('allows a bridge as the final hop of a path', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [
        { token: TOKEN, from: SUBJECT, to: OTHER, value: '1', block: 100, logIndex: 0 },
        { token: TOKEN, from: OTHER, to: SANCTIONED, value: MIN, block: 101, logIndex: 1, ...BRIDGE },
      ],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    expect(await computeProximity(db)).toEqual([
      { subject: SUBJECT, labels: ['sanctions_2hop'] },
      { subject: OTHER, labels: ['sanctions_1hop'] },
    ])
  })

  it('applies the inbound minimum to a bridge edge like any other', async () => {
    await seedFixture(db, {
      seeds: [{ subject: SANCTIONED, label: 'sanctions' }],
      edges: [{ token: TOKEN, from: SANCTIONED, to: SUBJECT, value: '1', ...BRIDGE }],
      minimums: [{ token: TOKEN, min: MIN }],
    })
    // Below the threshold: a bridged dusting is still dusting.
    expect(await computeProximity(db)).toEqual([])
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
