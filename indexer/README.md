# External Indexer

A third-party component, separate from the DVN worker. It collects on-chain risk events,
builds the graph, and publishes a **signed snapshot feed** that the worker ingests into its
local `RiskStore`. The worker never talks to this database.

```
Authoritative feeds + DVN events
        ↓
   External Indexer  (this folder)
        ↓
signed snapshot / delta feed
        ↓
DVN worker local RiskStore  (worker/assess)
        ↓
LayerZero packet verification
```

## Boundaries

Owns: `RiskVerdict` event collection, reorg handling, dedup, N-hop graph, exposure counts,
label propagation, long-term storage, dashboards, and **signing the published feed** (the
signing key lives here, never in the worker).

Does not own: packet verification, `submitVerification`, or any enforcement decision. The
worker treats this as one source among several, subject to source trust level and signature
verification.

## Run it

```bash
cp .env.example .env    # set FEED_SIGNING_KEY, the DVN addresses, and TRACKED_TOKENS
docker compose up -d
curl localhost:9091/feed/latest.json
```

Then point the worker at it: `INDEXER_FEED_URL=http://<host>:9091/feed/latest.json` and add this
instance's signer address to the worker's `INDEXER_SIGNERS`. The signing key never leaves here —
the worker only ever needs the address.

`TRACKED_TOKENS` is the setting that actually turns proximity on. Empty means no transfer edges
are collected, so the feed will be valid, signed, and empty.

## Layout

| Path                 | Contents                                                   |
| -------------------- | ---------------------------------------------------------- |
| `docker-compose.yml` | postgres 16 + indexer                                      |
| `Dockerfile`         | indexer image (unprivileged, healthchecked)                |
| `db/migrations/`     | schema: blocks, edges, seeds, verdicts, approvals, feeds   |
| `src/config.ts`      | env validation; fails with every problem at once           |
| `src/chain/`         | event decoding for RiskVerdict / PacketApproved / ERC-20   |
| `src/ingest/`        | scan loop, reorg rollback, idempotent writes, seed refresh |
| `src/graph/`         | one-hop proximity and exposure counts                      |
| `src/verify/`        | Sourcify v2 client + verification refresh pass             |
| `src/feed/`          | snapshot builder + EIP-191 signer                          |
| `src/http/`          | `/feed/latest.json`, `/healthz`, `/readyz`, `/metrics`     |
| `deploy/`            | Grafana dashboard (Prometheus + Postgres)                  |

## How it works

**Ingest.** Each chain is scanned only up to `head - CONFIRMATIONS`, in `SCAN_CHUNK_BLOCKS`
ranges, and every write is `ON CONFLICT DO NOTHING` on `(chain, tx_hash, log_index)` — so
re-scanning a range is idempotent and a rollback is safe rather than duplicating rows. The cursor
advances per committed chunk inside the same transaction as the rows.

**Reorgs.** Detected by comparing the recorded hash for the cursor height against the node's
current hash for that height; block numbers alone cannot tell you the chain was rewritten. On a
mismatch the last `REORG_DEPTH` blocks are deleted and rescanned. Only touched blocks are
recorded, so rather than searching for the exact fork point (which sparse history would stop
short of), a bounded window is unwound wholesale. Whether the rewrite went deeper is answered
against a real anchor — the deepest block still on record below that window — and if that also
disagrees the scan aborts loudly instead of leaving stale rows underneath it.

**Graph.** Depth 3 (`GRAPH_DEPTH`, matching the worker's `N_HOP.depth`), direction-aware, with a
label per depth (`sanctions_1hop/2hop/3hop`, …) so the worker can weight distance. A path counts
only if funds could have flowed along it: same chain, non-decreasing block order, no vertex twice,
no seed anywhere but the far endpoint, and the shortest route wins. The subject's own first
outbound edge needs no threshold; every other edge — outbound relays and all inbound hops — must
clear the per-token minimum, because anyone can push (or relay) a tainted transfer to poison an
address they do not control.

Those minimums come from `TOKEN_MINIMUMS` and are **what turns the inbound signal on** — a token
with no entry is never labelled inbound, so leaving it empty means `sanctions_1hop_inbound` never
fires at all. The values are replaced wholesale on every boot (config is their only source, so
removing an entry must actually remove the threshold), and the indexer logs a warning naming any
tracked token that is missing one.

Only ERC-20 `Transfer` events build edges — native-value transfers need trace APIs most public
RPCs do not expose, which is worth knowing when reading an exposure result.

Raising depth past 1 is a policy decision, not a refactor: it changes what the DVN is willing to
refuse a transfer over, and a second hop needs its own weight and threshold since "two hops from a
sanctioned address" is much weaker evidence than one.

**Seeds.** OFAC / OpenSanctions / mixer lists are loaded as the seed set for proximity and are
replaced per source on refresh, so a lifted sanction stops seeding. They are deliberately **not**
republished — see below.

**Source verification.** Whether a contract's source is verified cannot be read from chain state,
so it comes from Sourcify's **v2** API (`GET /v2/contract/{chainId}/{address}`; v1 is in a
scheduled brownout and returns 503). Two stages, because asking a verifier about an EOA is wasted
budget: `getCode` first, then only contracts are looked up. Answers are cached for `VERIFY_TTL_SEC`
and each pass is capped at `VERIFY_BATCH` addresses, since v2 answers one address per request; a
429 stops the pass early and the remainder is retried.

The status is deliberately **three-valued**, not two. `verified: false` produces the
`unverified_contract` label, but a request that failed — a 503, a 429, a timeout — is recorded as
NULL and retried. Treating "we could not find out" as "not verified" would let a verifier outage
label every contract in the graph, which is the kind of failure that quietly inflates every score
it touches. This is enforced in `refresh.ts` and pinned by tests.

## What is deliberately not published

- **The seed labels themselves.** The worker reads OFAC and OpenSanctions first-hand. Re-feeding
  a `sanctions` label as a `trusted_indexer` claim would launder an authoritative source into a
  derived one, and derived labels cannot cause a refusal.
- **`action`, `confidence`, `score`.** All three belong to the worker (`SOURCE_TRUST`,
  `ACTION_THRESHOLDS`, `LABEL_WEIGHTS`). Asserting them here would move enforcement authority to
  the indexer.
- **Our own `RiskVerdict` events.** They are collected into `risk_verdicts` for audit and
  dashboards, but feeding our past verdicts back as labels is self-amplifying: a hold becomes
  evidence for the next hold. Consuming them would need an explicit decay or provenance rule
  that does not exist yet.

## Feed format (the contract with the worker)

The consumer already exists: `worker/assess/ingest/feed.ts`. Match it exactly — every rule below
is enforced there, and a feed that breaks one is rejected whole, not partially applied.

```json
{
  "version": 128,
  "generatedAt": 1782090000,
  "expiresAt": 1782093600,
  "source": "trusted-indexer-a",
  "policyVersion": 1,
  "entries": [{ "address": "0xabc…", "labels": ["sanctions_1hop", "mixer_exposure"] }],
  "signature": "0x…"
}
```

An entry may also carry `score`, `subjectType`, and `evidenceHash`; the worker accepts all three.
This implementation emits none of them — see "what is deliberately not published" above.

**Signing.** The signature is an EIP-191 `personal_sign` over the canonical JSON of the whole
document **minus** the `signature` field. Canonical means: object keys sorted, arrays left in
order, no whitespace. The worker recovers the signer and checks it against its allowlist, so
publish the signer address out of band.

**Integers only.** Every numeric field must be an integer. Float formatting is not guaranteed to
round-trip identically across languages, so a feed carrying one may verify on this side and fail
on the worker's. This is why entries carry no `confidence` — how far to trust this feed is the
worker's judgement (`SOURCE_TRUST`), not ours to assert.

**Unknown fields are signed too.** The worker preserves fields it does not recognise when
verifying, so adding one is backward-compatible. But note it will be _ignored_, not honoured.

**`action` is not ours to set.** A per-entry `action` is parsed and deliberately discarded. The
worker decides actions from its own policy; honouring ours would hand it enforcement authority
that `SOURCE_TRUST` exists to withhold.

**Derived labels cannot cause a refusal.** Graph-derived labels — `sanctions_1hop`,
`mixer_exposure`, and anything else outside the worker's `DIRECT_HIT_LABELS` — top out at
`manual-review` however high they score, and `score` cannot manufacture a direct hit either. This
is deliberate: an inference should route to a human, not freeze funds. If the indexer establishes
that an address genuinely IS sanctioned (not merely near one), publish `sanctions` — that is a
direct hit and will block.

**Versioning.** `version` must strictly increase per `source`. The worker persists the highest
version it has accepted, so a replayed older feed is rejected even across a restart. Two
indexers publishing under different `source` names keep independent counters.

**Expiry is the TTL.** `expiresAt` is stamped onto every entry, so the worker stops scoring these
labels the moment the document goes stale — no purge step, no risk of a forgotten label. Keep
`expiresAt` comfortably longer than the worker's refresh interval (default 30 min) or screening
will flap. Removals need nothing special: the worker rebuilds its store from scratch each
refresh, so an address dropped from the feed is simply absent next time.

**`policyVersion`** must equal the worker's `POLICY_VERSION` (`worker/assess/policy.ts`). A
mismatch is rejected rather than reconciled — scores computed under different weights are not
comparable. Coordinate policy bumps across both sides.

## Out of scope

Hash provenance (hash chain / Merkle DAG over risk judgments) is **not** part of this design.
Feed integrity comes from the signature and the source allowlist, not from a provenance chain.

Not built yet, in rough order of usefulness: native-value edges (they emit no event, so they need
trace APIs most public RPCs do not expose), and depth > 1 traversal and label propagation beyond
one hop (depth 1 is the agreed policy, not a gap).

## Dashboard

```bash
docker compose --profile observability up -d
```

Grafana on <http://localhost:3000> (anonymous viewer; admin password `GRAFANA_ADMIN_PASSWORD`,
default `admin`), Prometheus on <http://localhost:9092>. Both bind to loopback only — anonymous
access is fine there and would not be on a shared interface. The profile keeps them out of the
default `up`, so a plain deployment still runs just postgres + indexer.

Provisioning wires everything up: two datasources with fixed uids (`dvn-prometheus`,
`dvn-postgres`) and **both** dashboards — this one and the worker's, bind-mounted straight from the
repo so they are always the committed version. Nothing to import by hand. Prometheus scrapes the
indexer over the compose network and the worker via `host.docker.internal:9090`, which assumes the
worker runs on the host; point `deploy/observability/prometheus.yml` elsewhere if it does not.

The indexer dashboard needs both datasources because they answer different questions: Prometheus
has the operational series (scan lag, reorgs, feed age), while the audit trail and graph output live
only in Postgres and are deliberately not exported as metrics — they are records, not gauges. That
split is also why the two disagree after a restart: Prometheus counters reset with the process, so
`dvn_decisions_total` can show one decision while `risk_verdicts` still holds every one ever made.

Four sections: **ingest health** (scan lag, reorgs, error rate, seed count), **published feed**
(version, entry count, age against `FEED_TTL_SEC`, build outcomes, history), **risk verdicts** (the
audit trail — verdicts by action over time, recent verdicts with reason masks, owner approvals, and
held packets with no approval yet), and **graph & verification** (labels by type, most-exposed
subjects, verification status, configured thresholds).

Two panels are worth knowing how to read:

- **Verification status** separates `unknown (retrying)` from `unverified`. Only the latter
  produces a label; the former means we never got an answer.
- **Inbound thresholds configured** shows which tokens actually have a minimum. A tracked token
  absent from that table is silently not producing inbound labels.

Event rows carry a block number, not a timestamp, so anything plotted over time joins through
`blocks.block_time`. When editing those panels, compute the timestamp in a CTE and pass a bare
column to `$__timeGroupAlias` / `$__timeFilter`: Grafana matches macro arguments with `\([^)]*\)`,
so a `to_timestamp(...)` call inside a macro is truncated at its own closing paren and the panel
fails with `macro __timeGroup needs time column and interval`.

## Tests

```bash
pnpm test
```

The SQL runs against an in-memory Postgres rather than being mocked, so the proximity queries,
the numeric uint256 comparisons, and the dusting threshold are genuinely executed. `canonicalize`
is duplicated from `worker/assess/canonical.ts` on purpose (separate packages, separate Docker
builds) and `test/feed.spec.ts` pins its output against a fixture, so drift fails a test instead
of silently breaking every signature.
