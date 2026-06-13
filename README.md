# Compliance DVN

A LayerZero V2 **Decentralized Verifier Network (DVN)** that embeds AML/sanctions
screening into message verification, **blocking non-compliant OFT transfers before
they settle on the destination chain**. When our node is configured as a *required*
DVN, withholding its `verify` attestation prevents `commitVerification` — so the
message never lands. That withheld attestation is the **veto**.

Post-hoc monitoring is commoditized. The differentiator here is **pre-settlement
enforcement**, embedded directly in LayerZero's verification step.

## Live demo (Base Sepolia ⇄ Optimism Sepolia)

Two identical OFT transfers, Optimism Sepolia → Base Sepolia, differing only in the
recipient. The off-chain worker screened each and acted:

| Demo | Recipient | Worker action | LayerZero Scan | Delivered |
| --- | --- | --- | --- | --- |
| **Clean** | `0x…cCCc` (not flagged) | `VERIFY` + `COMMIT` | [`DELIVERED`](https://testnet.layerzeroscan.com/tx/0x5ec2e442e0fef14233ab0d92ca04fd9046328f741f947261814eedfbc001aef1) | ✅ 1 TOY minted on Base |
| **Flagged** | `0x…dEaD` (on denylist) | `VETO` (withheld verify) | [`INFLIGHT`](https://testnet.layerzeroscan.com/tx/0xf9038c4f4dd851b56a619f15bc0eea702a97d6924a2fac2e2b6c386edac8f5ae) | ❌ never committed, balance stays 0 |

The flagged transfer is permanently stuck at verification: the required DVN never
attested, so `commitVerification` reverts `LZ_ULN_Verifying` and the executor can
never `lzReceive`.

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

- **On-chain (`contracts/ComplianceDVN.sol`)** is deliberately thin: it implements
  `ILayerZeroDVN` (`assignJob`/`getFee`) so `SendUln302` dispatches & accrues its fee,
  and exposes operator-gated `submitVerification` → `IReceiveUlnE2.verify`. **All
  judgment is off-chain; the veto is simply the absence of a `verify` call.**
- **Off-chain (`worker/`)** screens with `assess()` against a denylist built from real
  data and decides verify vs. withhold.

## Risk engine (`worker/assess/`)

`assess(address) → { tags, score, reasons, blocked }`, chain-independent direct-hit
lookup over a denylist merged from:

- **OFAC SDN** crypto addresses ([0xB10C extract](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses))
- **OpenSanctions** `us_ofac_sdn` `CryptoWallet` entities (bulk FtM, no API key)
- Curated **mixer** contracts (Tornado Cash)
- An operator **test denylist** (`TEST_DENYLIST`) so a live blocked transfer is demoable

`combine(assess(sender), assess(receiver), assess(recipient)).blocked` drives the veto
— blocked if **any** party is flagged. (Live denylist built to 101 entries in the demo.)

`worker/tracker/` adds the **Tier 1** observation-only tracker: `cli trace <txHash>`
reconstructs a route via the LayerZero Scan API and colors each endpoint with `assess()`.

## Deployed contracts

| Contract | Base Sepolia (40245) | Optimism Sepolia (40232) |
| --- | --- | --- |
| ComplianceDVN | `0x5d5B0c36D1e522C0BB44fdd6402576De42484Ee0` | `0x8bc1f192391018Ee605D7A8D9B761159d91092C3` |
| ToyOFT | `0xdEc1591D39ECb8278d1a2256a5BF17507A375F00` | `0xdEc1591D39ECb8278d1a2256a5BF17507A375F00` |

Wired with our DVN as the **single required DVN** (`requiredDVNCount = 1`) on both
chains, both directions — so a single withheld attestation is a 100% block.

## Run it

```bash
pnpm install
cp .env.example .env            # set PRIVATE_KEY, optionally RPCs and TEST_DENYLIST

# Contracts (Foundry + Hardhat)
pnpm compile
forge test                      # 31 passing — incl. the on-chain veto proof
pnpm test:worker                # 16 passing — assess(), decoders, checkpoint, tracker

# Deploy + wire (testnet; needs a funded key on both chains)
npx hardhat lz:deploy  --ci --networks base-sepolia,optimism-sepolia --tags ComplianceDVN,ToyOFT
#   → record the two ComplianceDVN addresses into .env (DVN_BASE_SEPOLIA / DVN_OPTIMISM_SEPOLIA)
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

- **Foundry (31):** `ComplianceDVN` unit (fee/job/operator-gating/admin) and a
  `TestHelperOz5` integration that proves the veto deterministically — a clean packet
  delivers, a withheld one reverts `commitVerification` with `LZ_ULN_Verifying` so the
  recipient balance stays 0.
- **Vitest (16):** `assess()`/`combine()`, 81-byte header & OFT-message decoders,
  `JobAssigned` assignment filter, durable checkpoint, and the tracker transform.

## Design notes & gotchas (learned the hard way)

- **`assignJob` must NOT check `msg.value`.** `SendUln302` calls it with `msg.value == 0`
  and accrues worker fees internally (`SendUlnBase._assignJobs`). A `require(msg.value >= fee)`
  reverts every real send.
- **ULN config is per-chain.** A connection `from: A → to: B` configures the OApp on A;
  *both* its `sendConfig` and `receiveConfig` are applied on A and must reference **A's own
  DVN** (a DVN address only has code on its own chain). Cross-referencing reverts the quote
  or the commit.
- **The default executor won't `commitVerification` for a custom (unregistered) DVN** — it
  shows verification `WAITING`. So the worker drives `commitVerification` itself; once
  committed the executor performs `lzReceive`.
- **Fail-closed:** on RPC/assess/submit errors the worker does not mark a packet processed
  (it retries) and never verifies on uncertainty. A blocked verdict marks-processed without
  verifying (a permanent veto). Worker downtime stalls legit traffic rather than passing it.
- **Assignment filter:** the worker only acts on packets our DVN was actually assigned
  (correlating `PacketSent` with our DVN's `JobAssigned`), so it never wastes gas verifying
  other OApps' packets on the shared endpoint.

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
