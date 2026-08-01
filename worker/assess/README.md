# Extending `assess()`

This is the risk-judgment core. The DVN worker calls it before attesting a packet; the action
it returns decides whether the cross-chain message settles, waits, or never settles at all.
Everything you add here flows straight into that on-chain outcome.

## What it does today

`assess(subject)` reads every live entry for a subject out of the `RiskStore`, turns each label
into a piece of `Evidence`, and hands the set to the policy engine.

- `RiskStore` keeps one entry **per source** per subject, each with its own confidence, TTL,
  and optional evidence hash. Per-source entries are deliberate: a feed entry that expires in
  an hour must not drag a permanent OFAC label out of the store with it.
- `evaluate()` in `policy.ts` sums label weights (capped at 100), picks a candidate action from
  `ACTION_THRESHOLDS`, then **clamps** it to a ceiling. Two things cap each claim: how far its
  source is trusted (`SOURCE_TRUST`), and whether it asserts a direct hit (`DIRECT_HIT_LABELS`).
  So a pile of `public_event` labels can total 100 and still only reach `delay`, and stacked
  *derived* labels reach `manual-review` rather than blocking — an inference is not grounds for
  freezing funds. The cap is applied **per claim** and the most permissive claim wins, so an
  untrusted "sanctions" next to a trusted 1-hop label cannot combine into a block.
- `combine([...])` folds the sender, receiver, and OFT recipient into one verdict: worst action
  wins, scores are maxed rather than summed.
- The store is built at startup from four sources (`buildRiskStore`): OFAC SDN crypto
  addresses, OpenSanctions crypto wallets, a curated mixer set, and an operator test list.

Contract signals come from `providers/contract.ts`, which reads what a node can see for itself:
whether the address holds code, whether an EIP-1967 implementation slot is set
(`upgradeable_proxy`), and who controls it — if the owner/admin carries labels of its own, that
becomes `contract_admin_risk`.

Token signals come from `providers/token.ts`. When a party is an OFT it resolves the ERC-20 that
OFT actually moves, then screens **that** address: curated `scam_token` labels come from the
store, and a `fake_stablecoin_suspect` label is raised when a token claims a major stablecoin's
symbol from a non-canonical address. Evidence about the token names the token as its `subject`,
not the OApp that moves it.

Graph signals (`sanctions_1hop`, `sanctions_1hop_inbound`, `mixer_exposure`) and
`unverified_contract` come from the indexer feed, not from here — the first three need a
transfer graph and the last needs an external verifier, neither of which belongs in the packet
decision path. See `indexer/README.md`.

Not implemented anywhere yet: `honeypot_suspect`, which needs transaction simulation. Its weight
exists in `policy.ts` but nothing populates it.

## The contract (do not break this)

```ts
type RiskAction = 'allow' | 'delay' | 'manual-review' | 'block'
interface Assessment { subject: string; score: number; action: RiskAction; reasonCodes: string[]; evidence: Evidence[] }
type Assessor = (subject: string, chainKey?: string) => Promise<Assessment>
```

- `action` is what the worker acts on. `score` / `reasonCodes` / `evidence` explain it.
- Subjects are lowercased everywhere. Keep it that way.
- `chainKey` selects which chain's state contract checks run against. A packet's parties do
  **not** share a chain — the sender is an OApp on the source, the receiver and OFT recipient
  are on the destination — so it cannot be inferred. Omit it for store-only screening.
- The worker calls `assess` inline before each attestation, so keep it bounded and cached, and
  fail closed: when a signal is unavailable the verdict is floored at `delay`, never `allow`.
- A failed check must not become a scored label. Scoring it would let an RPC hiccup stack onto
  an existing 70-point label and cross the block threshold; the floor keeps the two separate.

## Where to add logic

| You want to | Touch | Notes |
| --- | --- | --- |
| Add a data source | new `ingest/<source>.ts`, then wire it into `buildRiskStore()` | Follow the `Fetcher` pattern in `ingest/ofac.ts` so it stays unit-testable offline. Pick the right `LabelSource` — it decides how far the source can escalate. |
| Curate scam tokens | `SCAM_TOKENS` env, read by `ingest/tokens.ts` | `scam_token` scores 100, so an entry blocks every transfer of that token. Confirmed only. |
| Add a canonical stablecoin | `CANONICAL_STABLECOINS` in `providers/token.ts` | A wrong entry flags the REAL token. A symbol with no entry for the chain is not judged, so omitting a chain is safe and guessing is not. |
| Add a new signal | a label + weight in `LABEL_WEIGHTS`, then whatever populates it | Weights are policy, so bump `POLICY_VERSION` when you change them. Also add a bit to `REASON_BITS` in `verdict.ts` — append only, never renumber. |
| Let a new label cause a refusal | `DIRECT_HIT_LABELS` in `policy.ts` | Only for labels asserting the subject *is* the thing, not that it is near one. Everything else tops out at `manual-review` no matter how high it scores. |
| Change thresholds or the veto policy | `ACTION_THRESHOLDS` / `evaluate()` in `policy.ts` | These values are agreed with the team; do not tune them ad hoc. |
| Change how much a source is trusted | `SOURCE_TRUST` in `sources.ts` | The single place enforcement authority lives. |
| Add graph / behavioral signals (1-hop exposure, counterparty risk) | the indexer feed, then `ingest/feed.ts` | Depth and dusting thresholds live in `N_HOP`. The DVN does not walk the graph itself. |
| Add a chain-state signal | `providers/contract.ts` (or a sibling provider) | Read through the narrow `ChainReader` interface so tests stay offline, and keep every call inside the timeout. |

### Adding a provider that does I/O

`Assessor` is already async, so a new provider does not change the signature — but it does
share the packet loop's latency budget. Follow what `RpcContractInspector` does:

- take a narrow reader interface, not an ethers provider (the adapter lives in `chain/reader.ts`)
- cache by `chainKey:address` with a TTL, and bound every lookup with a timeout
- do **not** cache failures, and do not let one optional sub-read (a reverting `owner()`) fail
  the whole inspection
- throw on "cannot determine" rather than returning a clean-looking default; the caller turns
  that into a hold

Call sites to keep in mind if the signature ever changes again:

- `worker/runtime/scanner.ts` (`verifyPacket`, `processDeferred` — the live decision paths)

## Run it

```bash
pnpm test:worker          # unit tests live in worker/test/
```

Screening results and held packets are visible in the demo dashboard (`demo/dashboard/`) and on
the worker's HTTP surface (`/status`, `/pending`).

Add tests next to the existing ones (`worker/test/assess.spec.ts`, `ingest/*` specs). Keep
network calls behind an injected fetcher so tests stay offline.
