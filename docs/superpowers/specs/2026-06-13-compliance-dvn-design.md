# Compliance DVN — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming complete; pending spec review)

## Summary

A LayerZero V2 **Compliance DVN** that embeds AML/sanctions screening into the
message-verification step, blocking non-compliant OFT transfers *before*
settlement. When our node is configured as a **required DVN**, withholding its
`verify` attestation prevents `commitVerification`, so the message never lands on
the destination chain. That withheld attestation — the **veto** — is the target
deliverable.

Post-hoc observation is a solved, commoditized problem. The differentiator here is
**pre-settlement enforcement**.

**Rationale (from product spec):** laundering is migrating from mixers to bridges
(TRM Labs: bridges +66%, mixers −37%); the largest 2026 DeFi hack to date occurred
on LayerZero (Kelp DAO, ~$292M).

## Locked Decisions

| Topic | Decision |
| --- | --- |
| Fidelity | Real testnet, end-to-end (deploy + live veto demo) |
| Toolchain | `create-lz-oapp` scaffold: Hardhat + Foundry hybrid, pnpm, TypeScript worker |
| Chains | Base Sepolia (eid 40245) ⇄ Optimism Sepolia (eid 40232) |
| Headline demo | Optimism Sepolia → Base Sepolia (veto enforced on Base) |
| Risk engine | Real OFAC SDN + OpenSanctions ingestion, **direct-hit only** (no 1-hop in v1), union'd with an operator-controlled test denylist |
| Worker | Always-on watcher **+** one-shot CLI; durable checkpoint; **fail-closed** |
| Tier 1 tracker | In scope, fully implemented (built last) |

## Scope Boundaries

- **Building:** an AML layer — two contracts we own (custom DVN + a demo "toy" OFT),
  the off-chain risk engine + worker, and the wiring/config to make the DVN required.
- **No permission required:** DVN deployment is permissionless. Enforcement power
  arises when an OApp selects us as `required`. This is an adoption problem, not an
  approval problem.

## Tiered Composition

One shared core, two layers on top.

| Layer | Role | Deployed |
| --- | --- | --- |
| Tier 0 core | risk module `assess()` | none (library) |
| Tier 1 | cross-chain tracker, observation-only | none |
| Tier 2 (goal) | Compliance DVN, pre-settlement block | 2 testnets |

## Architecture / Repository Layout

```
compliance-dvn/
├── contracts/
│   ├── ComplianceDVN.sol        # Tier 2: ILayerZeroDVN impl + operator-gated verify
│   └── ToyOFT.sol               # demo OFT (mint/burn) extending @layerzerolabs/oft-evm OFT
├── deploy/                      # hardhat-deploy scripts (per chain)
├── tasks/                       # setConfig wiring + demo send tasks
├── layerzero.config.ts          # pathway + requiredDVNs wiring (both directions)
├── worker/
│   ├── assess/                  # Tier 0 risk core
│   │   ├── ingest/
│   │   │   ├── ofac.ts          # OFAC SDN crypto-address loader
│   │   │   ├── opensanctions.ts # OpenSanctions crypto-entity loader
│   │   │   └── mixers.ts        # curated mixer / sanctioned-contract set
│   │   ├── store.ts             # normalized denylist (real + operator test entries)
│   │   └── assess.ts            # assess(addr)->{tags,score,reasons,blocked}; combine()
│   ├── chain/
│   │   ├── header.ts            # 81-byte packet-header decode
│   │   ├── message.ts           # OFT message decode (recipient, amount)
│   │   ├── events.ts            # PacketSent / job-assigned watchers per chain
│   │   └── verify.ts            # submitVerification call wrapper
│   ├── tracker/                 # Tier 1: route reconstruction via LayerZero Scan
│   ├── checkpoint.ts            # durable last-scanned block + processed-packet set
│   ├── service.ts               # always-on watcher (both chains)
│   └── cli.ts                   # one-shot: assess <addr> | verify <txHash> | trace <txHash>
├── test/
│   ├── foundry/                 # ComplianceDVN unit + TestHelperOz5 integration
│   └── worker/                  # vitest: assess() + decode vectors
├── hardhat.config.ts
└── .env.example
```

## Component Designs

### Tier 2 — `ComplianceDVN.sol`

Implements the canonical `ILayerZeroDVN` interface so `SendUln302` will assign and
pay it. Exact import paths / struct fields finalized against the LayerZero monorepo
at build time.

- `assignJob(AssignJobParam calldata _param, bytes calldata _options) external payable returns (uint256 fee)`
  — called and paid by `SendUln302` on `send`. Records the job, emits `JobAssigned`
  (carrying `dstEid`, `packetHeader`, `payloadHash`, `confirmations`, `sender`),
  returns `fee`.
- `getFee(uint32 _dstEid, uint64 _confirmations, address _sender, bytes calldata _options) external view returns (uint256 fee)`
  — fee quote.
- `submitVerification(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external onlyOperator`
  — forwards to `IReceiveUlnE2(receiveUln).verify(...)`. **Withholding this is the veto.**
- Admin (Ownable): `setOperator`, `setFee`, `setReceiveUln`, `withdraw`.

The contract is intentionally thin: all judgment is off-chain. On-chain it only
conforms to the worker-job interface and gates the attestation behind the operator key.

### Tier 0 — `assess()`

- `assess(address) -> { tags: string[], score: number, reasons: string[], blocked: boolean }`,
  chain-independent, normalized (lowercased) address lookup.
- Ingest sources merged into one denylist store:
  - OFAC SDN crypto addresses (real).
  - OpenSanctions default crypto-entity dataset (real).
  - Curated mixer / sanctioned-contract set (e.g., Tornado Cash) (real).
  - **Operator test denylist** — addresses whose keys we control, so a live blocked
    transfer can actually be originated on testnet.
- `combine(assess(sender), assess(receiver), assess(recipient))` — `blocked` if **any**
  party is blocked. This is what the worker consults before attesting.
- **Note on the testnet/data gap:** real sanctioned addresses are mainnet addresses
  whose keys nobody benign controls, so they cannot originate a testnet transfer.
  The union with a controllable test entry is what makes the live blocked demo possible;
  the real lists prove the pipeline is genuine. 1-hop exposure scoring is deferred
  (sparse testnet graphs make it theater) but the `assess()` return shape leaves room
  to add it later.

### Off-chain Worker

`encodedPacket = header(81) || guid(32) || message`

Flow:
1. Watch source endpoint for `PacketSent` / confirm our DVN received the job
   (`DVNFeePaid` / our `JobAssigned`).
2. Decode header (81 bytes): `[version(1)][nonce(8)][srcEid(4)][sender(32)][dstEid(4)][receiver(32)]`.
3. `payload = guid || message`; `payloadHash = keccak256(payload)`.
4. Decode OFT recipient (and amount) from `message`.
5. Wait for `UlnConfig.confirmations` source-chain blocks.
6. `combine(assess(sender), assess(receiver), assess(recipient))`:
   - **blocked** ⇒ withhold (log the veto, do not call verify).
   - **clean** ⇒ `complianceDVN.submitVerification(header, payloadHash, confirmations)`.
7. Checkpoint.

Operational requirements:
- **Stateful, must not miss events** — durable checkpoint of last-scanned block.
- **Idempotent** — a processed-packet guard keyed by `(packetHeader, payloadHash)`
  prevents double-verify.
- **Fail-closed** — on RPC/data-source/assess errors, do **not** auto-verify; withhold
  and alert. Verifying a possibly-bad packet would defeat the purpose. (Trade-off:
  worker downtime stalls legit traffic — acceptable and documented for v1.)
- Two entrypoints: `pnpm worker` (always-on, both chains) and `pnpm cli ...` (one-shot).

### Tier 1 — Cross-chain Tracker (observation only)

`pnpm cli trace <txHash>`: reconstruct the message route via the LayerZero Scan API,
then color each endpoint/party with `assess()`. Read-only — no attestation, no
deployment. Reuses the Tier 0 core. Built last.

### Wiring / DVN Selection

The selection point is a single `UlnConfig.requiredDVNs` array.

- `layerzero.config.ts` sets `requiredDVNs = [ComplianceDVN]` with
  `requiredDVNCount = 1` (single required ⇒ withholding = 100% block) on **both**
  the send ULN (source) and receive ULN (destination), symmetric across both chains.
- Applied via a `setConfig` task as the OApp owner (`CONFIG_TYPE_ULN = 2`;
  `setConfig` is owner-gated via `_assertAuthorized(_oapp)`).
- **Symmetry is mandatory:** the same DVN must be required on the source `SendUlnConfig`
  and destination `ReceiveUlnConfig`, or `commitVerification` fails on mismatch.

Reference config shape (from product spec):
```solidity
uint32 constant CONFIG_TYPE_ULN = 2;
address[] memory required = new address[](1);
required[0] = complianceDVN;                 // this array IS the selection
UlnConfig memory uln = UlnConfig({
    confirmations: 5, requiredDVNCount: 1, optionalDVNCount: 0,
    optionalDVNThreshold: 0, requiredDVNs: required, optionalDVNs: new address[](0)
});
SetConfigParam[] memory params = new SetConfigParam[](1);
params[0] = SetConfigParam({ eid: srcEid, configType: CONFIG_TYPE_ULN, config: abi.encode(uln) });
ILayerZeroEndpointV2(endpoint).setConfig(oapp, receiveLib, params); // caller = OApp owner
```

## Testing Strategy

- **Foundry unit:** `ComplianceDVN` — `assignJob`/`getFee` return values & fee
  collection, `submitVerification` access control (onlyOperator), admin setters,
  `withdraw`.
- **Foundry integration:** `TestHelperOz5` from `@layerzerolabs/test-devtools-evm-foundry`
  wires our DVN into a local send → verify → commit → `lzReceive` loop. Assert:
  a flagged packet **never delivers** (commit blocked) and a clean packet does.
- **Vitest (worker):** `assess()` lookups (real-format addresses + test entries),
  `combine()` logic, 81-byte header decode and OFT-message decode against known vectors.
- **Live testnet:** deploy to both chains → wire DVN required (both directions) →
  run two scripted transfers: a clean transfer (delivers) and a flagged transfer
  (stalls, never commits). Capture LayerZero Scan links as evidence.

## Error Handling

- **Contract:** `onlyOperator` on verify, `Ownable` on admin, explicit fee accounting,
  safe native-token `withdraw`.
- **Worker:** fail-closed on any uncertainty; bounded retries on transient RPC errors;
  idempotency guard; checkpoint after each processed packet so a restart resumes cleanly.

## Secrets / Config

- `.env` (gitignored), `.env.example` committed.
- `PRIVATE_KEY` (deployer/operator), `RPC_URL_BASE_SEPOLIA`, `RPC_URL_OPTIMISM_SEPOLIA`,
  optional `OPENSANCTIONS_API_KEY`, optional block-explorer keys for verification.

## Out of Scope (v1)

- 1-hop / multi-hop graph exposure scoring (interface leaves room).
- Mainnet deployment.
- Optional-DVN threshold schemes (we use single-required for an unambiguous veto).
- On-chain governance of the denylist (judgment stays off-chain by design).
```

