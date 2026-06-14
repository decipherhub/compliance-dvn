# Extending `assess()`

This is the risk-judgment core. The DVN worker calls it before attesting a packet; if it
says `blocked`, the worker withholds verification and the cross-chain message never settles.
Everything you add here flows straight into that on-chain veto.

## What it does today

`assess(address)` is a direct-hit lookup against a prebuilt denylist. Nothing more.

- `score` is binary: `100` if the address is in the list, `0` if not.
- `blocked` is just `score === 100`.
- The list is built once at startup from four sources (`buildDenylist`): OFAC SDN crypto
  addresses, OpenSanctions crypto wallets, a curated mixer set, and an operator test list.
- `combine([...])` runs `assess` on the sender, receiver, and OFT recipient, and blocks if
  any one of them is a hit.

So right now this is sanctions/mixer screening by membership. There is no proximity, no
behavioral signal, no graded risk. The `score` field and the "1-hop" idea are shape only;
the logic is not implemented.

## The contract (do not break this)

```ts
interface Assessment { address: string; tags: string[]; score: number; reasons: string[]; blocked: boolean }
type Assessor = (address: string) => Assessment
```

- `blocked` is the only field the worker acts on. `tags` / `reasons` / `score` are for logs
  and the tracer.
- Addresses are lowercased everywhere. Keep it that way.
- `assess` is chain-independent. Do not pass chain context into it.
- The worker calls `assess` inline before each attestation, so keep it deterministic and
  fast, and fail closed: if a signal is unavailable, do not silently return `blocked: false`.

## Where to add logic

| You want to | Touch | Notes |
| --- | --- | --- |
| Add a data source | new `ingest/<source>.ts`, then wire it into `buildDenylist()` | Follow the `Fetcher` pattern in `ingest/ofac.ts` so it stays unit-testable offline. |
| Grade the risk score | `makeAssessor()` in `assess.ts` | Replace the binary `100`/`0` with a real score, and decide the `blocked` threshold there. |
| Change the veto policy | `combine()` in `assess.ts` | Today: block if any party hits. You might block on a combined score, or only on the recipient. |
| Add graph / behavioral signals (1-hop exposure, counterparty risk) | `assess.ts` + every call site | This needs data beyond a local set, so `Assessor` likely becomes `async`. See below. |

### Going async (graph lookups, external risk APIs)

A local set lookup is sync. The moment you need a network or graph query, change the type to
`(address: string) => Promise<Assessment>` and update all three call sites to `await`:

- `worker/service.ts` (`handlePacket` — the live veto path)
- `worker/cli.ts` (`cmdAssess`, `cmdVerify`)
- `worker/tracker/trace.ts` (`buildTrace`)

Cache aggressively and bound latency. The worker blocks on this call per packet, and a slow
or failing lookup must fail closed (withhold), not pass.

## Run it

```bash
pnpm test:worker          # unit tests live in worker/test/
pnpm cli assess <address> # one-shot: see the Assessment for any address
```

Add tests next to the existing ones (`worker/test/assess.spec.ts`, `ingest/*` specs). Keep
network calls behind an injected fetcher so tests stay offline.
