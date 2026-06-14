# Compliance DVN

[![CI](https://github.com/decipherhub/compliance-dvn/actions/workflows/ci.yml/badge.svg)](https://github.com/decipherhub/compliance-dvn/actions/workflows/ci.yml)
[![CodeQL](https://github.com/decipherhub/compliance-dvn/actions/workflows/codeql.yml/badge.svg)](https://github.com/decipherhub/compliance-dvn/actions/workflows/codeql.yml)
[![Slither](https://github.com/decipherhub/compliance-dvn/actions/workflows/slither.yml/badge.svg)](https://github.com/decipherhub/compliance-dvn/actions/workflows/slither.yml)

A LayerZero V2 Decentralized Verifier Network (DVN) that screens OFT transfers for
AML/sanctions hits during message verification and blocks non-compliant ones before
they settle on the destination chain. When this node is configured as a required DVN,
withholding its `verify` attestation prevents `commitVerification`, so the message
never lands. That withheld attestation is the veto.

Commercial tools already cover post-hoc monitoring. This one enforces at send time,
inside LayerZero's own verification step.

## Live demo (Base Sepolia / Optimism Sepolia)

Two identical OFT transfers, Optimism Sepolia to Base Sepolia, differing only in the
recipient. The off-chain worker screened each and acted:

| Demo    | Recipient               | Worker action            | LayerZero Scan                                                                                                         | Delivered                            |
| ------- | ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Clean   | `0x…cCCc` (not flagged) | `VERIFY` + `COMMIT`      | [`DELIVERED`](https://testnet.layerzeroscan.com/tx/0x5ec2e442e0fef14233ab0d92ca04fd9046328f741f947261814eedfbc001aef1) | Yes, 1 TOY minted on Base            |
| Flagged | `0x…dEaD` (on denylist) | `VETO` (withheld verify) | [`INFLIGHT`](https://testnet.layerzeroscan.com/tx/0xf9038c4f4dd851b56a619f15bc0eea702a97d6924a2fac2e2b6c386edac8f5ae)  | No, never committed, balance stays 0 |

The flagged transfer is stuck at verification. The required DVN never attested, so
`commitVerification` reverts `LZ_ULN_Verifying` and the executor can never `lzReceive`.

## How the veto works

```
send (OP)                                          destination (Base)
  │  SendUln302.assignJob ─► ComplianceDVN(OP)        ReceiveUln302
  │     emits JobAssigned (payloadHash)                    ▲
  ▼                                                        │ verify(header, payloadHash, conf)
PacketSent(encodedPacket)                                  │  (ONLY if compliant)
  │                                                ComplianceDVN(Base).submitVerification
  ▼                                                        ▲
off-chain worker:                                          │
  1. sees JobAssigned → packet is ours                     │
  2. decode header(81)+guid(32)+message                    │
  3. assess(sender, receiver, recipient)  ───── clean ─────┘  then commitVerification → lzReceive → delivered
                                          ───── blocked ──► withhold (VETO) → commitVerification reverts → stalls
```

The on-chain contract (`contracts/ComplianceDVN.sol`) is thin. It implements
`ILayerZeroDVN` (`assignJob`/`getFee`) so `SendUln302` dispatches to it and accrues
its fee, and it exposes an operator-gated `submitVerification` that forwards to
`IReceiveUlnE2.verify`. All judgment lives off-chain; the veto is the absence of a
`verify` call. The worker (`worker/`) screens with `assess()` against a denylist and
decides whether to verify or withhold.

## Risk engine (`worker/assess/`)

`assess(address) → { tags, score, reasons, blocked }` does a chain-independent
direct-hit lookup over a denylist merged from four sources:

- OFAC SDN crypto addresses ([0xB10C extract](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses))
- OpenSanctions `us_ofac_sdn` `CryptoWallet` entities (bulk FtM, no API key)
- Curated mixer contracts (Tornado Cash)
- An operator test denylist (`TEST_DENYLIST`) so a live blocked transfer is demoable

`combine(assess(sender), assess(receiver), assess(recipient)).blocked` drives the
veto: blocked if any party is flagged. The live denylist built to 101 entries during
the demo.

`worker/tracker/` adds the Tier 1 observation-only tracker. `cli trace <txHash>`
reconstructs a route via the LayerZero Scan API and colors each endpoint with `assess()`.

## Deployed contracts

| Contract      | Base Sepolia (40245)                         | Optimism Sepolia (40232)                     |
| ------------- | -------------------------------------------- | -------------------------------------------- |
| ComplianceDVN | `0x5d5B0c36D1e522C0BB44fdd6402576De42484Ee0` | `0x8bc1f192391018Ee605D7A8D9B761159d91092C3` |
| ToyOFT        | `0xdEc1591D39ECb8278d1a2256a5BF17507A375F00` | `0xdEc1591D39ECb8278d1a2256a5BF17507A375F00` |

The DVN is wired as the single required DVN (`requiredDVNCount = 1`) on both chains
in both directions, so one withheld attestation is a full block.

## Run it

```bash
pnpm install
cp .env.example .env            # set PRIVATE_KEY, optionally RPCs and TEST_DENYLIST

# Contracts (Foundry + Hardhat)
pnpm compile
forge test                      # 31 passing, incl. the on-chain veto proof
pnpm test:worker                # 16 passing: assess(), decoders, checkpoint, tracker

# Deploy + wire (testnet; needs a funded key on both chains)
npx hardhat lz:deploy  --ci --networks base-sepolia,optimism-sepolia --tags ComplianceDVN,ToyOFT
#   then record the two ComplianceDVN addresses into .env (DVN_BASE_SEPOLIA / DVN_OPTIMISM_SEPOLIA)
npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts --ci
npx hardhat dvn:status --network base-sepolia          # sanity

# Run the worker (always-on) + send demos
pnpm worker                                            # screens both chains, verifies/commits or vetoes
npx hardhat demo:send --network optimism-sepolia --to <clean_addr>   --dst base   # delivers
npx hardhat demo:send --network optimism-sepolia --to $TEST_DENYLIST --dst base   # vetoed

# One-shot CLI
pnpm cli assess <address>
pnpm cli trace  <txHash>        # Tier 1 route + risk coloring
```

## Tests

Foundry (31): `ComplianceDVN` unit tests (fee, job, operator-gating, admin) and a
`TestHelperOz5` integration that proves the veto. A clean packet delivers; a withheld
one reverts `commitVerification` with `LZ_ULN_Verifying`, so the recipient balance
stays 0.

Vitest (16): `assess()`/`combine()`, the 81-byte header and OFT-message decoders, the
`JobAssigned` assignment filter, the durable checkpoint, and the tracker transform.

## CI / CD

GitHub Actions enforce the same gates locally and on every PR:

| Workflow      | Trigger                       | What it does                                                                                                                                     |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`      | push to `main`, all PRs       | Lint (`eslint` + `prettier` + `solhint`); contracts (`forge build`/`test`, `hardhat compile`/`test`); worker (typecheck + vitest + Docker build) |
| `codeql.yml`  | push, PR, weekly              | CodeQL security + quality scan of JS/TS                                                                                                          |
| `slither.yml` | push, PR                      | Slither static analysis of the contracts; findings to the Security tab                                                                           |
| `publish.yml` | push to `main`, `v*.*.*` tags | Build + push the worker image to `ghcr.io/<owner>/compliance-dvn-worker` (`:edge` on main, semver + `:latest` on tags) and cut a GitHub Release  |

The contracts jobs run `pnpm install` before any `forge`/`slither` command — `foundry.toml`
remaps imports into `node_modules`, so the JS deps must be present first. The worker is
built and tested against its own `package.json` (Node 20) to mirror the shipped image.
Releasing is a tag: `git tag v1.2.3 && git push --tags`.

## Design notes and gotchas

`assignJob` must not check `msg.value`. `SendUln302` calls it with `msg.value == 0`
and accrues worker fees internally (`SendUlnBase._assignJobs`). A
`require(msg.value >= fee)` reverts every real send.

ULN config is per-chain. A connection `from: A → to: B` configures the OApp on A. Both
its `sendConfig` and `receiveConfig` are applied on A and must reference A's own DVN,
because a DVN address only has code on its own chain. Cross-referencing reverts the
quote or the commit.

The default executor does not call `commitVerification` for a custom, unregistered
DVN; it leaves verification at `WAITING`. So the worker calls `commitVerification`
itself, after which the executor performs `lzReceive`.

Fail-closed behavior: on RPC, assess, or submit errors the worker does not mark a
packet processed (it retries) and never verifies on uncertainty. A blocked verdict
marks the packet processed without verifying, a permanent veto. Worker downtime stalls
legitimate traffic rather than passing it.

Assignment filter: the worker only acts on packets its DVN was actually assigned,
correlating `PacketSent` with the DVN's `JobAssigned`, so it never spends gas
verifying other OApps' packets on the shared endpoint.

## Layout

```
contracts/ComplianceDVN.sol   ComplianceDVN.t.sol + ComplianceDvnVeto.t.sol (veto proof)
contracts/ToyOFT.sol          demo OFT
deploy/                       hardhat-deploy scripts
layerzero.config.ts           requiredDVNs = our DVN, both directions
tasks/                        dvn:status, demo:send
worker/assess/                Tier 0 risk engine (OFAC + OpenSanctions + mixers + test)
worker/chain/                 header/message decoders, PacketSent scanner, verify/commit
worker/tracker/               Tier 1 LayerZero-Scan tracker
worker/service.ts             always-on watcher (fail-closed)   worker/cli.ts  one-shot
docs/superpowers/             design spec + implementation plan
```
