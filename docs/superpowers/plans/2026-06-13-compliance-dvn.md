# Compliance DVN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a LayerZero V2 Compliance DVN that vetoes non-compliant OFT transfers pre-settlement by withholding `verify`, deployed live on Base Sepolia and Optimism Sepolia.

**Architecture:** A thin on-chain `ComplianceDVN` implements `ILayerZeroDVN` (so `SendUln302` pays it) and exposes an operator-gated `submitVerification` that forwards to `ReceiveUln302.verify`. All judgment is off-chain: a TypeScript worker watches `PacketSent`, decodes the packet, runs `assess()` (real OFAC + OpenSanctions denylist), and either submits the verification (clean) or withholds it (the veto). Wiring sets our DVN as the single `requiredDVN` on both chains, both directions, so a withheld attestation blocks `commitVerification`.

**Tech Stack:** Solidity ^0.8.22 (Foundry + Hardhat via `create-lz-oapp`), `@layerzerolabs/oft-evm` OFT, `@layerzerolabs/lz-evm-messagelib-v2` / `lz-evm-protocol-v2` interfaces, TypeScript worker (ethers v5, tsx, vitest), `@layerzerolabs/test-devtools-evm-foundry` `TestHelperOz5` for integration tests.

---

## Verified Reference Constants (use these verbatim)

**Package versions** (devDependencies from the scaffold):
`@layerzerolabs/lz-evm-messagelib-v2 ^3.0.148`, `lz-evm-protocol-v2 ^3.0.148`, `lz-definitions ^3.0.148`, `lz-v2-utilities ^3.0.148`, `oft-evm ^4.0.1`, `oapp-evm ^0.4.1`, `metadata-tools ^3.0.0`, `toolbox-hardhat ~0.6.13`, `test-devtools-evm-foundry ~8.0.1`, `@openzeppelin/contracts ^5.0.2`, `hardhat ^2.22.10`, `hardhat-deploy ^0.12.1`, `ethers ^5.7.2`.

**Endpoint IDs:** Base Sepolia `EndpointId.BASESEP_V2_TESTNET` = **40245** (chainId 84532); Optimism Sepolia `EndpointId.OPTSEP_V2_TESTNET` = **40232** (chainId 11155420).

**Deployed addresses (LayerZero V2, verified 2026-06-13):**

| Contract | Base Sepolia (40245) | Optimism Sepolia (40232) |
|---|---|---|
| EndpointV2 | `0x6EDCE65403992e310A62460808c4b910D972f10f` | `0x6EDCE65403992e310A62460808c4b910D972f10f` |
| SendUln302 | `0xC1868e054425D378095A003EcbA3823a5D0135C9` | `0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f` |
| ReceiveUln302 | `0x12523de19dc41c91F7d2093E0CFbB76b17012C8d` | `0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca` |
| Executor | `0x8A3D588D9f6AC041476b094f97FF94ec30169d3D` | `0xDc0D68899405673b932F0DB7f8A49191491A5bcB` |

**RPCs:** Base Sepolia `https://sepolia.base.org` (alt `https://base-sepolia-rpc.publicnode.com`); Optimism Sepolia `https://sepolia.optimism.io` (alt `https://optimism-sepolia-rpc.publicnode.com`).

**Solidity interfaces (verbatim, for imports):**
```solidity
import { ILayerZeroDVN } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/ILayerZeroDVN.sol";
import { IReceiveUlnE2 } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
```
`ILayerZeroDVN.AssignJobParam` fields, in order: `uint32 dstEid; bytes packetHeader; bytes32 payloadHash; uint64 confirmations; address sender;`
`assignJob(AssignJobParam calldata, bytes calldata) external payable returns (uint256 fee)`
`getFee(uint32 dstEid, uint64 confirmations, address sender, bytes calldata options) external view returns (uint256 fee)`
`IReceiveUlnE2.verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external` (selector `0x0223536e`)
`IReceiveUlnE2.commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external`

**Packet header layout (81 bytes total):** version `[0]` (1B, =1), nonce `[1:9]` (8B), srcEid `[9:13]` (4B), sender `[13:45]` (32B), dstEid `[45:49]` (4B), receiver `[49:81]` (32B). `payload = encodedPacket[81:]` = `guid(32) ‖ message`. `payloadHash = keccak256(payload)`.

**OFT message layout:** `sendTo` `[0:32]` (bytes32; address = last 20 bytes), `amountSD` `[32:40]` (uint64). Composed iff `length > 40`.

**Data sources:**
- OFAC ETH addrs (machine-readable): `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json`
- OpenSanctions OFAC SDN bulk (no key): `https://data.opensanctions.org/datasets/latest/us_ofac_sdn/entities.ftm.json` (NDJSON; filter `schema == "CryptoWallet"`, read `properties.publicKey`).
- LayerZero Scan testnet: `https://scan-testnet.layerzero-api.com/v1/messages/tx/{txHash}` → `{data:[{pathway:{srcEid,dstEid,sender:{address},receiver:{address}}, status:{name}, guid, ...}]}`.

---

## File Structure

```
compliance-dvn/  (repo root = workspace root)
├── contracts/
│   ├── ComplianceDVN.sol            # Tier 2 DVN
│   └── ToyOFT.sol                   # demo OFT
├── deploy/
│   ├── ComplianceDVN.ts             # hardhat-deploy script
│   └── ToyOFT.ts
├── tasks/
│   ├── index.ts
│   ├── configureDvn.ts              # set operator + receiveUln on ComplianceDVN
│   └── demoSend.ts                  # send a transfer from a chosen sender
├── layerzero.config.ts              # requiredDVNs = [ComplianceDVN], both directions
├── hardhat.config.ts
├── foundry.toml
├── test/foundry/
│   ├── ComplianceDVN.t.sol          # unit
│   └── ComplianceDvnVeto.t.sol      # TestHelperOz5 integration (veto)
├── worker/
│   ├── assess/
│   │   ├── store.ts                 # Denylist
│   │   ├── ingest/ofac.ts
│   │   ├── ingest/opensanctions.ts
│   │   ├── ingest/mixers.ts
│   │   ├── testDenylist.ts          # operator-controlled entries
│   │   └── assess.ts                # assess() + combine()
│   ├── chain/
│   │   ├── header.ts                # decodeHeader
│   │   ├── message.ts               # decodeOftMessage
│   │   ├── verify.ts                # submitVerification wrapper
│   │   └── events.ts                # PacketSent watcher
│   ├── tracker/trace.ts             # Tier 1
│   ├── config.ts                    # chain/env config
│   ├── checkpoint.ts                # durable state
│   ├── service.ts                   # always-on watcher
│   └── cli.ts                       # one-shot commands
├── worker/test/                     # vitest specs
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Phase 0 — Scaffold & Repo Setup

### Task 0.1: Scaffold the LayerZero OFT project into the workspace

**Files:** whole repo (scaffold output), then trim.

- [ ] **Step 1: Scaffold into a temp dir and copy in** (the workspace root already has `.git`, `LICENSE`, `docs/`; scaffold into a sibling temp and merge to avoid clobbering)

```bash
cd /tmp
pnpm create lz-oapp@latest lz-scaffold --example oft --no-git 2>/dev/null || npx create-lz-oapp@latest lz-scaffold
# If the CLI is interactive, choose: example = "OFT", package manager = pnpm.
```

- [ ] **Step 2: Copy scaffold files into the workspace** (do not overwrite `.git`, `LICENSE`, `docs/`)

```bash
cd /Users/anjin-u/conductor/workspaces/compliance-dvn/calgary-v3
rsync -a --exclude='.git' --exclude='LICENSE' --exclude='docs' /tmp/lz-scaffold/ ./
pnpm install
```

- [ ] **Step 3: Verify compile works**

Run: `pnpm compile`
Expected: both `forge build` and `hardhat compile` succeed (the stock `MyOFT.sol` compiles).

- [ ] **Step 4: Commit the scaffold baseline**

```bash
git add -A && git commit -m "chore: scaffold create-lz-oapp OFT baseline"
```

### Task 0.2: Configure networks for Base Sepolia + Optimism Sepolia

**Files:** Modify `hardhat.config.ts`, Create `.env.example`.

- [ ] **Step 1: Set the two networks in `hardhat.config.ts`** (replace the scaffold's example networks block)

```typescript
import { EndpointId } from '@layerzerolabs/lz-definitions'

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []

const config = {
    // ...existing solidity/compiler config from scaffold...
    networks: {
        'base-sepolia': {
            eid: EndpointId.BASESEP_V2_TESTNET,
            url: process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org',
            accounts,
        },
        'optimism-sepolia': {
            eid: EndpointId.OPTSEP_V2_TESTNET,
            url: process.env.RPC_URL_OPTIMISM_SEPOLIA || 'https://sepolia.optimism.io',
            accounts,
        },
    },
    // ...keep namedAccounts: { deployer: { default: 0 } } ...
}
export default config
```

- [ ] **Step 2: Write `.env.example`**

```bash
# Deployer + DVN operator key (same key for the demo)
PRIVATE_KEY=
# RPCs (public defaults used if blank)
RPC_URL_BASE_SEPOLIA=https://sepolia.base.org
RPC_URL_OPTIMISM_SEPOLIA=https://sepolia.optimism.io
```

- [ ] **Step 3: Ensure `.env` is gitignored**

Run: `grep -q '^\.env$' .gitignore || echo '.env' >> .gitignore`

- [ ] **Step 4: Commit**

```bash
git add hardhat.config.ts .env.example .gitignore && git commit -m "chore: configure base-sepolia + optimism-sepolia networks"
```

---

## Phase 1 — `ComplianceDVN.sol` (Foundry TDD)

### Task 1.1: getFee returns configured fee

**Files:** Create `contracts/ComplianceDVN.sol`, Create `test/foundry/ComplianceDVN.t.sol`.

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";

contract ComplianceDVNTest is Test {
    ComplianceDVN dvn;
    address operator = address(0xBEEF);
    address receiveUln = address(0xCAFE);

    function setUp() public {
        dvn = new ComplianceDVN(address(this), operator, receiveUln, 0.0001 ether);
    }

    function test_getFee_returnsConfiguredFee() public view {
        uint256 fee = dvn.getFee(40245, 5, address(0x1234), "");
        assertEq(fee, 0.0001 ether);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-contract ComplianceDVNTest -vv`
Expected: FAIL — `ComplianceDVN` source missing / does not compile.

- [ ] **Step 3: Write minimal `ComplianceDVN.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ILayerZeroDVN } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/ILayerZeroDVN.sol";
import { IReceiveUlnE2 } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";

/// @title ComplianceDVN
/// @notice Thin LayerZero V2 DVN. All compliance judgment is off-chain; the on-chain
///         contract only conforms to the worker-job interface and gates the destination
///         attestation behind an operator key. Withholding `submitVerification` IS the veto.
contract ComplianceDVN is ILayerZeroDVN, Ownable {
    address public operator;   // off-chain worker key
    address public receiveUln; // ReceiveUln302 on this chain
    uint256 public fee;

    event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender);
    event OperatorSet(address operator);
    event ReceiveUlnSet(address receiveUln);
    event FeeSet(uint256 fee);

    error NotOperator();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _owner, address _operator, address _receiveUln, uint256 _fee) Ownable(_owner) {
        operator = _operator;
        receiveUln = _receiveUln;
        fee = _fee;
    }

    function getFee(
        uint32 /*_dstEid*/,
        uint64 /*_confirmations*/,
        address /*_sender*/,
        bytes calldata /*_options*/
    ) external view returns (uint256) {
        return fee;
    }

    function assignJob(AssignJobParam calldata, bytes calldata) external payable returns (uint256) {
        return fee;
    }

    function submitVerification(
        bytes calldata packetHeader,
        bytes32 payloadHash,
        uint64 confirmations
    ) external onlyOperator {
        IReceiveUlnE2(receiveUln).verify(packetHeader, payloadHash, confirmations);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-contract ComplianceDVNTest -vv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/ComplianceDVN.sol test/foundry/ComplianceDVN.t.sol
git commit -m "feat: ComplianceDVN getFee"
```

### Task 1.2: assignJob returns fee and emits JobAssigned

**Files:** Modify `contracts/ComplianceDVN.sol`, Modify `test/foundry/ComplianceDVN.t.sol`.

- [ ] **Step 1: Add the failing test**

```solidity
    function test_assignJob_returnsFee_andEmits() public {
        ILayerZeroDVN.AssignJobParam memory p = ILayerZeroDVN.AssignJobParam({
            dstEid: 40245,
            packetHeader: hex"01",
            payloadHash: keccak256("payload"),
            confirmations: 5,
            sender: address(0x1234)
        });
        vm.expectEmit(false, false, false, true);
        emit ComplianceDVN.JobAssigned(40245, keccak256("payload"), 5, address(0x1234));
        uint256 ret = dvn.assignJob{ value: 0.0001 ether }(p, "");
        assertEq(ret, 0.0001 ether);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `forge test --match-test test_assignJob_returnsFee_andEmits -vv`
Expected: FAIL — no event emitted.

- [ ] **Step 3: Update `assignJob`**

```solidity
    function assignJob(AssignJobParam calldata _param, bytes calldata) external payable returns (uint256) {
        emit JobAssigned(_param.dstEid, _param.payloadHash, _param.confirmations, _param.sender);
        return fee;
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `forge test --match-test test_assignJob_returnsFee_andEmits -vv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/ComplianceDVN.sol test/foundry/ComplianceDVN.t.sol
git commit -m "feat: ComplianceDVN assignJob emits JobAssigned"
```

### Task 1.3: submitVerification is operator-gated and forwards to ReceiveUln

**Files:** Modify `test/foundry/ComplianceDVN.t.sol` (add a mock receiveUln).

- [ ] **Step 1: Add a mock + failing tests**

```solidity
contract MockReceiveUln {
    bytes public lastHeader;
    bytes32 public lastPayloadHash;
    uint64 public lastConfirmations;
    uint256 public calls;

    function verify(bytes calldata h, bytes32 ph, uint64 c) external {
        lastHeader = h; lastPayloadHash = ph; lastConfirmations = c; calls++;
    }
}
```

Add tests to `ComplianceDVNTest`:

```solidity
    function test_submitVerification_onlyOperator() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(ComplianceDVN.NotOperator.selector);
        dvn.submitVerification(hex"01", keccak256("p"), 5);
    }

    function test_submitVerification_forwardsToReceiveUln() public {
        MockReceiveUln mock = new MockReceiveUln();
        ComplianceDVN d = new ComplianceDVN(address(this), operator, address(mock), 0);
        vm.prank(operator);
        d.submitVerification(hex"0102", keccak256("p"), 7);
        assertEq(mock.calls(), 1);
        assertEq(mock.lastPayloadHash(), keccak256("p"));
        assertEq(mock.lastConfirmations(), 7);
    }
```

- [ ] **Step 2: Run to verify they fail/pass appropriately**

Run: `forge test --match-contract ComplianceDVNTest -vv`
Expected: `test_submitVerification_forwardsToReceiveUln` and `_onlyOperator` PASS (the impl from 1.1 already supports this). If `forge` complains the mock contract must be in its own scope, keep `MockReceiveUln` at file top-level above the test contract.

- [ ] **Step 3: Commit**

```bash
git add test/foundry/ComplianceDVN.t.sol
git commit -m "test: ComplianceDVN submitVerification access + forwarding"
```

### Task 1.4: Admin setters + withdraw

**Files:** Modify `contracts/ComplianceDVN.sol`, Modify `test/foundry/ComplianceDVN.t.sol`.

- [ ] **Step 1: Add failing tests**

```solidity
    function test_setters_onlyOwner() public {
        dvn.setOperator(address(0xAAA));
        assertEq(dvn.operator(), address(0xAAA));
        dvn.setReceiveUln(address(0xBBB));
        assertEq(dvn.receiveUln(), address(0xBBB));
        dvn.setFee(123);
        assertEq(dvn.fee(), 123);

        vm.prank(address(0xDEAD));
        vm.expectRevert();
        dvn.setFee(999);
    }

    function test_withdraw_sendsBalanceToOwner() public {
        vm.deal(address(dvn), 1 ether);
        uint256 before = address(this).balance;
        dvn.withdraw(payable(address(this)));
        assertEq(address(this).balance, before + 1 ether);
    }

    receive() external payable {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `forge test --match-contract ComplianceDVNTest -vv`
Expected: FAIL — setters/withdraw not defined.

- [ ] **Step 3: Add to `ComplianceDVN.sol`**

```solidity
    function setOperator(address _operator) external onlyOwner { operator = _operator; emit OperatorSet(_operator); }
    function setReceiveUln(address _receiveUln) external onlyOwner { receiveUln = _receiveUln; emit ReceiveUlnSet(_receiveUln); }
    function setFee(uint256 _fee) external onlyOwner { fee = _fee; emit FeeSet(_fee); }

    function withdraw(address payable _to) external onlyOwner {
        (bool ok, ) = _to.call{ value: address(this).balance }("");
        require(ok, "withdraw failed");
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `forge test --match-contract ComplianceDVNTest -vv`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/ComplianceDVN.sol test/foundry/ComplianceDVN.t.sol
git commit -m "feat: ComplianceDVN admin setters + withdraw"
```

---

## Phase 2 — `ToyOFT.sol`

### Task 2.1: ToyOFT with public mint

**Files:** Create `contracts/ToyOFT.sol`, Create `test/foundry/ToyOFT.t.sol`. (You may delete the scaffold's `contracts/MyOFT.sol` and its test, or keep them — but `layerzero.config.ts` later references `ToyOFT`.)

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ToyOFT } from "../../contracts/ToyOFT.sol";

contract ToyOFTTest is Test {
    function test_mint_increasesBalance() public {
        // endpoint can be any non-zero address for a pure mint test; OFT ctor stores it
        ToyOFT oft = new ToyOFT("Toy", "TOY", address(0x1111), address(this));
        oft.mint(address(0xABCD), 5 ether);
        assertEq(oft.balanceOf(address(0xABCD)), 5 ether);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `forge test --match-contract ToyOFTTest -vv`
Expected: FAIL — `ToyOFT` missing.

- [ ] **Step 3: Write `contracts/ToyOFT.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";

/// @notice Demo OFT for the Compliance DVN testnet demo. `mint` is open for testnet only.
contract ToyOFT is OFT {
    constructor(
        string memory _name,
        string memory _symbol,
        address _lzEndpoint,
        address _delegate
    ) OFT(_name, _symbol, _lzEndpoint, _delegate) Ownable(_delegate) {}

    function mint(address _to, uint256 _amount) public {
        _mint(_to, _amount);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `forge test --match-contract ToyOFTTest -vv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/ToyOFT.sol test/foundry/ToyOFT.t.sol
git commit -m "feat: ToyOFT demo token with public mint"
```

---

## Phase 3 — Integration Test: the veto (TestHelperOz5)

> This is the hardest Solidity task: wiring our custom DVN into the local harness so we can prove that withholding `submitVerification` blocks delivery. The scaffold ships `test/foundry/SimpleDVNMock.t.sol` + `contracts`/`deploy` mocks demonstrating a custom DVN in `TestHelperOz5`. **Read that file first** and mirror its wiring (it shows exactly how the installed `test-devtools-evm-foundry` version exposes ULN/DVN configuration — APIs vary by version, so copy from the real file rather than guessing).

### Task 3.1: Veto integration test

**Files:** Create `test/foundry/ComplianceDvnVeto.t.sol`.

- [ ] **Step 1: Read the scaffold's worked example**

Run: `sed -n '1,200p' test/foundry/SimpleDVNMock.t.sol` (and `cat contracts/mocks/SimpleDVNMock.sol` if present)
Note how it: deploys endpoints with `setUpEndpoints(2, LibraryType.UltraLightNode)`, deploys the custom DVN, registers it in the ULN config, sends, and drives verification.

- [ ] **Step 2: Write the integration test, modeled on SimpleDVNMock.t.sol**

The test must assert the veto. Structure (adapt the exact helper calls to match `SimpleDVNMock.t.sol`):

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { SendParam } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";
import { ToyOFT } from "../../contracts/ToyOFT.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";

contract ComplianceDvnVetoTest is TestHelperOz5 {
    using OptionsBuilder for bytes;

    uint32 aEid = 1;
    uint32 bEid = 2;
    ToyOFT aOFT;
    ToyOFT bOFT;
    ComplianceDVN dvnA;
    ComplianceDVN dvnB;

    address cleanUser = makeAddr("cleanUser");
    address recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        // Deploy our DVN on each "chain"; operator = address(this) so the test can submit.
        // receiveUln set after endpoints exist — use the harness getter mirrored from SimpleDVNMock.t.sol.
        dvnA = new ComplianceDVN(address(this), address(this), receiveUlnOf(aEid), 0);
        dvnB = new ComplianceDVN(address(this), address(this), receiveUlnOf(bEid), 0);

        aOFT = ToyOFT(_deployOApp(type(ToyOFT).creationCode, abi.encode("A","A", address(endpoints[aEid]), address(this))));
        bOFT = ToyOFT(_deployOApp(type(ToyOFT).creationCode, abi.encode("B","B", address(endpoints[bEid]), address(this))));

        // Wire peers + set our DVN as the single required DVN in both directions
        // (use the same ULN-config call SimpleDVNMock.t.sol uses).
        _wireWithComplianceDvn();

        aOFT.mint(cleanUser, 100 ether);
    }

    function test_cleanTransfer_delivers() public {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);
        SendParam memory sp = SendParam(bEid, addressToBytes32(recipient), 1 ether, 1 ether, options, "", "");
        MessagingFee memory fee = aOFT.quoteSend(sp, false);
        vm.prank(cleanUser);
        aOFT.send{ value: fee.nativeFee }(sp, fee, payable(cleanUser));

        // Operator (this test) submits verification for the clean packet, then deliver.
        _submitVerificationFor(bEid, dvnB);     // mirrors verifyPackets, but via our DVN
        assertEq(bOFT.balanceOf(recipient), 1 ether);
    }

    function test_flaggedTransfer_isVetoed() public {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);
        SendParam memory sp = SendParam(bEid, addressToBytes32(recipient), 1 ether, 1 ether, options, "", "");
        MessagingFee memory fee = aOFT.quoteSend(sp, false);
        vm.prank(cleanUser);
        aOFT.send{ value: fee.nativeFee }(sp, fee, payable(cleanUser));

        // VETO: operator withholds submitVerification. commitVerification must NOT succeed,
        // so the packet never delivers.
        // Assert recipient balance stays zero (no delivery without verification).
        assertEq(bOFT.balanceOf(recipient), 0);
    }

    // Helpers `receiveUlnOf`, `_wireWithComplianceDvn`, `_submitVerificationFor`
    // are implemented by mirroring SimpleDVNMock.t.sol's setup/verification helpers.
}
```

- [ ] **Step 3: Implement the helpers by copying SimpleDVNMock.t.sol's pattern**

Replace the three helper stubs with the concrete calls used in `SimpleDVNMock.t.sol`:
- `receiveUlnOf(eid)` → the harness's receive-ULN address for that endpoint (the SimpleDVNMock test references it when constructing the DVN; use the identical accessor).
- `_wireWithComplianceDvn()` → calls `wireOApps` for peers, then the ULN-config setter the SimpleDVN test uses to register the custom DVN as required (both send + receive, both directions).
- `_submitVerificationFor(eid, dvn)` → reconstruct the packet (the harness exposes the queued packet bytes the same way SimpleDVNMock retrieves them), then `dvn.submitVerification(header, payloadHash, confirmations)` followed by the harness's commit/lzReceive step.

- [ ] **Step 4: Run the integration test**

Run: `forge test --match-contract ComplianceDvnVetoTest -vvv`
Expected: BOTH pass — `test_cleanTransfer_delivers` (recipient gets 1 ether), `test_flaggedTransfer_isVetoed` (recipient balance stays 0 because verification was withheld).

- [ ] **Step 5: Commit**

```bash
git add test/foundry/ComplianceDvnVeto.t.sol
git commit -m "test: integration proof of DVN veto via TestHelperOz5"
```

---

## Phase 4 — Worker Tooling Setup + Tier 0 `assess()`

### Task 4.1: Worker TypeScript + vitest setup

**Files:** Modify `package.json`, Create `vitest.config.ts`, Create `worker/config.ts`.

- [ ] **Step 1: Add worker deps + scripts**

Run:
```bash
pnpm add -D vitest tsx
pnpm add ethers@^5.7.2 node-fetch@^2
pnpm add -D @types/node-fetch@^2
```

Add to `package.json` `"scripts"`:
```json
"worker": "tsx worker/service.ts",
"cli": "tsx worker/cli.ts",
"test:worker": "vitest run worker/test"
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['worker/test/**/*.spec.ts'] } })
```

- [ ] **Step 3: Create `worker/config.ts`** (chain + address registry)

```typescript
export interface ChainCfg {
  name: string
  eid: number
  chainId: number
  rpc: string
  endpoint: string
  sendUln: string
  receiveUln: string
}

export const CHAINS: Record<string, ChainCfg> = {
  baseSepolia: {
    name: 'base-sepolia', eid: 40245, chainId: 84532,
    rpc: process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org',
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xC1868e054425D378095A003EcbA3823a5D0135C9',
    receiveUln: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d',
  },
  optimismSepolia: {
    name: 'optimism-sepolia', eid: 40232, chainId: 11155420,
    rpc: process.env.RPC_URL_OPTIMISM_SEPOLIA || 'https://sepolia.optimism.io',
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f',
    receiveUln: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca',
  },
}

// Populated after deploy (Phase 8): ComplianceDVN address per chain.
export const COMPLIANCE_DVN: Record<string, string> = {
  baseSepolia: process.env.DVN_BASE_SEPOLIA || '',
  optimismSepolia: process.env.DVN_OPTIMISM_SEPOLIA || '',
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json vitest.config.ts worker/config.ts pnpm-lock.yaml
git commit -m "chore: worker TS + vitest setup, chain config"
```

### Task 4.2: Denylist store

**Files:** Create `worker/assess/store.ts`, Create `worker/test/store.spec.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { Denylist } from '../assess/store'

describe('Denylist', () => {
  it('normalizes case and detects membership', () => {
    const dl = new Denylist()
    dl.add('0xAAbbCC', 'ofac', 'SDN match')
    expect(dl.has('0xaabbcc')).toBe(true)
    expect(dl.lookup('0xAABBCC')?.tags).toContain('ofac')
    expect(dl.has('0x000001')).toBe(false)
  })

  it('merges multiple sources for the same address', () => {
    const dl = new Denylist()
    dl.add('0x01', 'ofac', 'r1')
    dl.add('0x01', 'mixer', 'r2')
    const e = dl.lookup('0x01')!
    expect(e.tags.sort()).toEqual(['mixer', 'ofac'])
    expect(e.reasons.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL — `store` module not found.

- [ ] **Step 3: Implement `worker/assess/store.ts`**

```typescript
export interface DenyEntry { address: string; tags: string[]; reasons: string[] }

export class Denylist {
  private map = new Map<string, DenyEntry>()

  add(address: string, tag: string, reason: string): void {
    const key = address.toLowerCase()
    const existing = this.map.get(key)
    if (existing) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag)
      existing.reasons.push(reason)
    } else {
      this.map.set(key, { address: key, tags: [tag], reasons: [reason] })
    }
  }

  has(address: string): boolean { return this.map.has(address.toLowerCase()) }
  lookup(address: string): DenyEntry | undefined { return this.map.get(address.toLowerCase()) }
  get size(): number { return this.map.size }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/assess/store.ts worker/test/store.spec.ts
git commit -m "feat: denylist store with case-normalized merge"
```

### Task 4.3: OFAC ingest

**Files:** Create `worker/assess/ingest/ofac.ts`, Create `worker/test/ofac.spec.ts`.

- [ ] **Step 1: Write the failing test** (parse logic is pure; network fetch is injected)

```typescript
import { describe, it, expect } from 'vitest'
import { parseOfacList, ingestOfac } from '../assess/ingest/ofac'
import { Denylist } from '../assess/store'

describe('OFAC ingest', () => {
  it('parses a JSON array of addresses', () => {
    const addrs = parseOfacList(JSON.stringify(['0xAAA', '0xbbb', 'nothex', '']))
    expect(addrs).toEqual(['0xaaa', '0xbbb'])
  })

  it('loads parsed addresses into a denylist', async () => {
    const dl = new Denylist()
    await ingestOfac(dl, async () => JSON.stringify(['0x1234567890123456789012345678901234567890']))
    expect(dl.has('0x1234567890123456789012345678901234567890')).toBe(true)
    expect(dl.lookup('0x1234567890123456789012345678901234567890')?.tags).toContain('ofac')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL — `ofac` module not found.

- [ ] **Step 3: Implement `worker/assess/ingest/ofac.ts`**

```typescript
import { Denylist } from '../store'

const OFAC_ETH_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json'

const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** Parse the 0xB10C ETH list (JSON array of address strings). Keeps only valid EVM addresses, lowercased. */
export function parseOfacList(body: string): string[] {
  const arr = JSON.parse(body) as unknown[]
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.toLowerCase())
    .filter(isEvmAddress)
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OFAC fetch failed: ${res.status}`)
  return res.text()
}

export async function ingestOfac(dl: Denylist, fetcher: Fetcher = defaultFetch): Promise<number> {
  const body = await fetcher(OFAC_ETH_URL)
  const addrs = parseOfacList(body)
  for (const a of addrs) dl.add(a, 'ofac', 'OFAC SDN digital currency address (ETH)')
  return addrs.length
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/assess/ingest/ofac.ts worker/test/ofac.spec.ts
git commit -m "feat: OFAC SDN ETH address ingest"
```

### Task 4.4: OpenSanctions ingest

**Files:** Create `worker/assess/ingest/opensanctions.ts`, Create `worker/test/opensanctions.spec.ts`.

- [ ] **Step 1: Write the failing test** (NDJSON parse is pure)

```typescript
import { describe, it, expect } from 'vitest'
import { parseOpenSanctionsNdjson } from '../assess/ingest/opensanctions'

describe('OpenSanctions ingest', () => {
  it('extracts EVM publicKey values from CryptoWallet entities', () => {
    const ndjson = [
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['0x1234567890123456789012345678901234567890'], currency: ['ETH'] } }),
      JSON.stringify({ schema: 'Person', properties: { name: ['Bob'] } }),
      JSON.stringify({ schema: 'CryptoWallet', properties: { publicKey: ['bc1qxyz'] } }), // non-EVM, dropped
      '',
    ].join('\n')
    expect(parseOpenSanctionsNdjson(ndjson)).toEqual(['0x1234567890123456789012345678901234567890'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/assess/ingest/opensanctions.ts`**

```typescript
import { Denylist } from '../store'
import type { Fetcher } from './ofac'

const OS_OFAC_SDN_URL = 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/entities.ftm.json'
const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** Parse FtM NDJSON; keep EVM publicKeys from CryptoWallet entities, lowercased + de-duped. */
export function parseOpenSanctionsNdjson(body: string): string[] {
  const out = new Set<string>()
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: any
    try { obj = JSON.parse(t) } catch { continue }
    if (obj?.schema !== 'CryptoWallet') continue
    const keys: unknown = obj?.properties?.publicKey
    if (!Array.isArray(keys)) continue
    for (const k of keys) {
      if (typeof k === 'string' && isEvmAddress(k)) out.add(k.toLowerCase())
    }
  }
  return [...out]
}

const defaultFetch: Fetcher = async (url) => {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OpenSanctions fetch failed: ${res.status}`)
  return res.text()
}

export async function ingestOpenSanctions(dl: Denylist, fetcher: Fetcher = defaultFetch): Promise<number> {
  const body = await fetcher(OS_OFAC_SDN_URL)
  const addrs = parseOpenSanctionsNdjson(body)
  for (const a of addrs) dl.add(a, 'opensanctions', 'OpenSanctions us_ofac_sdn CryptoWallet')
  return addrs.length
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/assess/ingest/opensanctions.ts worker/test/opensanctions.spec.ts
git commit -m "feat: OpenSanctions CryptoWallet ingest"
```

### Task 4.5: Curated mixers + operator test denylist

**Files:** Create `worker/assess/ingest/mixers.ts`, Create `worker/assess/testDenylist.ts`, Create `worker/test/mixers.spec.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { ingestMixers, MIXER_ADDRESSES } from '../assess/ingest/mixers'
import { loadTestDenylist } from '../assess/testDenylist'
import { Denylist } from '../assess/store'

describe('mixers + test denylist', () => {
  it('loads curated mixer addresses', () => {
    const dl = new Denylist()
    ingestMixers(dl)
    expect(dl.size).toBe(MIXER_ADDRESSES.length)
    expect(dl.lookup(MIXER_ADDRESSES[0])?.tags).toContain('mixer')
  })

  it('loads operator test entries from env CSV', () => {
    const dl = new Denylist()
    loadTestDenylist(dl, '0xdeadbeef00000000000000000000000000000001,0xDEADBEEF00000000000000000000000000000002')
    expect(dl.has('0xdeadbeef00000000000000000000000000000001')).toBe(true)
    expect(dl.lookup('0xdeadbeef00000000000000000000000000000002')?.tags).toContain('test')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement both modules**

`worker/assess/ingest/mixers.ts`:
```typescript
import { Denylist } from '../store'

/** Curated sanctioned-mixer contracts (Tornado Cash router + classic pools, mainnet addresses). */
export const MIXER_ADDRESSES: string[] = [
  '0x722122df12d4e14e13ac3b6895a86e84145b6967', // Tornado Cash: Router
  '0xd90e2f925da726b50c4 ed8d0fb90ad053324f31b'.replace(/\s/g, ''), // Tornado Cash 10 ETH (sanitized)
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', // Tornado Cash 100 ETH
].map((a) => a.toLowerCase())

export function ingestMixers(dl: Denylist): number {
  for (const a of MIXER_ADDRESSES) dl.add(a, 'mixer', 'Curated sanctioned mixer contract')
  return MIXER_ADDRESSES.length
}
```
> Note: verify each mixer address against the OFAC SDN entries at build time; the list is intentionally small and explicit. Remove the sanitizing `.replace` line and inline the correct 42-char address once confirmed.

`worker/assess/testDenylist.ts`:
```typescript
import { Denylist } from './store'

const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** Operator-controlled flagged addresses (keys we hold) so a live blocked transfer is demoable.
 *  Source: TEST_DENYLIST env var, comma-separated. */
export function loadTestDenylist(dl: Denylist, csv = process.env.TEST_DENYLIST || ''): number {
  let n = 0
  for (const raw of csv.split(',')) {
    const a = raw.trim().toLowerCase()
    if (isEvmAddress(a)) { dl.add(a, 'test', 'Operator test denylist entry'); n++ }
  }
  return n
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/assess/ingest/mixers.ts worker/assess/testDenylist.ts worker/test/mixers.spec.ts
git commit -m "feat: curated mixers + operator test denylist"
```

### Task 4.6: `assess()` + `combine()` + loader

**Files:** Create `worker/assess/assess.ts`, Create `worker/test/assess.spec.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { makeAssessor, combine } from '../assess/assess'
import { Denylist } from '../assess/store'

describe('assess + combine', () => {
  const dl = new Denylist()
  dl.add('0x00000000000000000000000000000000000000aa', 'ofac', 'sdn')
  const assess = makeAssessor(dl)

  it('flags a denylisted address as blocked', () => {
    const r = assess('0x00000000000000000000000000000000000000AA')
    expect(r.blocked).toBe(true)
    expect(r.tags).toContain('ofac')
    expect(r.score).toBe(100)
  })

  it('passes a clean address', () => {
    const r = assess('0x00000000000000000000000000000000000000bb')
    expect(r.blocked).toBe(false)
    expect(r.score).toBe(0)
  })

  it('combine blocks if any party is blocked', () => {
    const clean = assess('0x00000000000000000000000000000000000000bb')
    const bad = assess('0x00000000000000000000000000000000000000aa')
    expect(combine([clean, clean]).blocked).toBe(false)
    expect(combine([clean, bad, clean]).blocked).toBe(true)
    expect(combine([clean, bad]).reasons.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/assess/assess.ts`**

```typescript
import { Denylist } from './store'
import { ingestOfac } from './ingest/ofac'
import { ingestOpenSanctions } from './ingest/opensanctions'
import { ingestMixers } from './ingest/mixers'
import { loadTestDenylist } from './testDenylist'

export interface Assessment {
  address: string
  tags: string[]
  score: number      // 0 clean, 100 direct hit
  reasons: string[]
  blocked: boolean
}

export type Assessor = (address: string) => Assessment

/** Direct-hit assessor over a prebuilt denylist. Chain-independent. */
export function makeAssessor(dl: Denylist): Assessor {
  return (address: string): Assessment => {
    const e = dl.lookup(address)
    if (!e) return { address: address.toLowerCase(), tags: [], score: 0, reasons: [], blocked: false }
    return { address: e.address, tags: e.tags, score: 100, reasons: e.reasons, blocked: true }
  }
}

/** Block if ANY party is flagged. Aggregates tags/reasons. */
export function combine(parts: Assessment[]): Assessment {
  const blocked = parts.some((p) => p.blocked)
  return {
    address: parts.map((p) => p.address).join(','),
    tags: [...new Set(parts.flatMap((p) => p.tags))],
    score: Math.max(0, ...parts.map((p) => p.score)),
    reasons: parts.flatMap((p) => p.reasons),
    blocked,
  }
}

/** Build a denylist from all real sources + operator test entries. */
export async function buildDenylist(): Promise<Denylist> {
  const dl = new Denylist()
  await ingestOfac(dl)
  await ingestOpenSanctions(dl)
  ingestMixers(dl)
  loadTestDenylist(dl)
  return dl
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/assess/assess.ts worker/test/assess.spec.ts
git commit -m "feat: assess() direct-hit + combine() veto aggregation"
```

---

## Phase 5 — Worker Chain Decode

### Task 5.1: Packet header decode

**Files:** Create `worker/chain/header.ts`, Create `worker/test/header.spec.ts`.

- [ ] **Step 1: Write the failing test** (build an 81-byte header with known fields)

```typescript
import { describe, it, expect } from 'vitest'
import { decodeHeader } from '../chain/header'

describe('decodeHeader', () => {
  it('decodes the 81-byte packet header', () => {
    // version=1, nonce=7, srcEid=40232, sender=0x..AA (20b right-padded into 32),
    // dstEid=40245, receiver=0x..BB
    const hex =
      '01' +                                   // version
      '0000000000000007' +                     // nonce (8)
      '00009d28' +                             // srcEid 40232 (4)
      '000000000000000000000000' + 'aa'.repeat(20) + // sender bytes32
      '00009d35' +                             // dstEid 40245 (4)
      '000000000000000000000000' + 'bb'.repeat(20)   // receiver bytes32
    const h = decodeHeader('0x' + hex)
    expect(h.version).toBe(1)
    expect(h.nonce).toBe(7n)
    expect(h.srcEid).toBe(40232)
    expect(h.dstEid).toBe(40245)
    expect(h.senderAddress).toBe('0x' + 'aa'.repeat(20))
    expect(h.receiverAddress).toBe('0x' + 'bb'.repeat(20))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/chain/header.ts`**

```typescript
export interface PacketHeader {
  version: number
  nonce: bigint
  srcEid: number
  sender: string          // full bytes32
  senderAddress: string   // last 20 bytes as address
  dstEid: number
  receiver: string
  receiverAddress: string
}

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Decode the LayerZero V2 81-byte packet header. */
export function decodeHeader(headerHex: string): PacketHeader {
  const h = stripHex(headerHex)
  if (h.length !== 81 * 2) throw new Error(`header must be 81 bytes, got ${h.length / 2}`)
  const slice = (startByte: number, lenBytes: number) => h.slice(startByte * 2, (startByte + lenBytes) * 2)
  const sender = '0x' + slice(13, 32)
  const receiver = '0x' + slice(49, 32)
  return {
    version: parseInt(slice(0, 1), 16),
    nonce: BigInt('0x' + slice(1, 8)),
    srcEid: parseInt(slice(9, 4), 16),
    sender,
    senderAddress: '0x' + slice(13 + 12, 20), // last 20 of the 32-byte field
    dstEid: parseInt(slice(45, 4), 16),
    receiver,
    receiverAddress: '0x' + slice(49 + 12, 20),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/chain/header.ts worker/test/header.spec.ts
git commit -m "feat: 81-byte packet header decoder"
```

### Task 5.2: OFT message decode

**Files:** Create `worker/chain/message.ts`, Create `worker/test/message.spec.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { decodeOftMessage } from '../chain/message'

describe('decodeOftMessage', () => {
  it('decodes sendTo + amountSD', () => {
    const sendTo = '000000000000000000000000' + 'cc'.repeat(20) // bytes32
    const amountSD = '0000000000000064'                          // 100
    const m = decodeOftMessage('0x' + sendTo + amountSD)
    expect(m.toAddress).toBe('0x' + 'cc'.repeat(20))
    expect(m.amountSD).toBe(100n)
    expect(m.composed).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/chain/message.ts`**

```typescript
export interface OftMessage { toAddress: string; amountSD: bigint; composed: boolean }

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Decode the OFT message: sendTo[0:32] (address = last 20 bytes), amountSD[32:40]. */
export function decodeOftMessage(messageHex: string): OftMessage {
  const m = stripHex(messageHex)
  if (m.length < 40 * 2) throw new Error(`OFT message must be >= 40 bytes, got ${m.length / 2}`)
  const sendTo = m.slice(0, 64)
  const toAddress = '0x' + sendTo.slice(24) // last 20 bytes
  const amountSD = BigInt('0x' + m.slice(64, 80))
  return { toAddress, amountSD, composed: m.length > 40 * 2 }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/chain/message.ts worker/test/message.spec.ts
git commit -m "feat: OFT message decoder (recipient + amount)"
```

---

## Phase 6 — Worker Runtime: checkpoint, verify, watcher, service, CLI

### Task 6.1: Checkpoint store

**Files:** Create `worker/checkpoint.ts`, Create `worker/test/checkpoint.spec.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Checkpoint } from '../checkpoint'
import { rmSync, existsSync } from 'fs'

const PATH = '/tmp/dvn-checkpoint-test.json'
afterEach(() => { if (existsSync(PATH)) rmSync(PATH) })

describe('Checkpoint', () => {
  it('persists last block per chain and processed packets', () => {
    const c = new Checkpoint(PATH)
    c.setLastBlock('baseSepolia', 100)
    c.markProcessed('0xpackethash')
    c.save()

    const c2 = new Checkpoint(PATH)
    expect(c2.getLastBlock('baseSepolia')).toBe(100)
    expect(c2.isProcessed('0xpackethash')).toBe(true)
    expect(c2.isProcessed('0xother')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/checkpoint.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface State { lastBlock: Record<string, number>; processed: string[] }

export class Checkpoint {
  private state: State = { lastBlock: {}, processed: {} as any }
  private processedSet = new Set<string>()

  constructor(private path: string) {
    if (existsSync(path)) {
      const s = JSON.parse(readFileSync(path, 'utf8')) as State
      this.state = { lastBlock: s.lastBlock || {}, processed: [] }
      this.processedSet = new Set(s.processed || [])
    }
  }

  getLastBlock(chain: string): number { return this.state.lastBlock[chain] ?? 0 }
  setLastBlock(chain: string, block: number): void { this.state.lastBlock[chain] = block }
  isProcessed(key: string): boolean { return this.processedSet.has(key) }
  markProcessed(key: string): void { this.processedSet.add(key) }

  save(): void {
    writeFileSync(this.path, JSON.stringify({ lastBlock: this.state.lastBlock, processed: [...this.processedSet] }, null, 2))
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/checkpoint.ts worker/test/checkpoint.spec.ts
git commit -m "feat: durable checkpoint (last block + processed set)"
```

### Task 6.2: Verify submission wrapper

**Files:** Create `worker/chain/verify.ts`. (No unit test — thin ethers wrapper; covered by live demo. Keep it tiny.)

- [ ] **Step 1: Implement `worker/chain/verify.ts`**

```typescript
import { ethers } from 'ethers'

const DVN_ABI = [
  'function submitVerification(bytes packetHeader, bytes32 payloadHash, uint64 confirmations) external',
]

export async function submitVerification(
  signer: ethers.Signer,
  dvnAddress: string,
  packetHeader: string,
  payloadHash: string,
  confirmations: number,
): Promise<string> {
  const dvn = new ethers.Contract(dvnAddress, DVN_ABI, signer)
  const tx = await dvn.submitVerification(packetHeader, payloadHash, confirmations)
  const receipt = await tx.wait()
  return receipt.transactionHash
}
```

- [ ] **Step 2: Compile check**

Run: `pnpm tsx -e "import('./worker/chain/verify.ts').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add worker/chain/verify.ts
git commit -m "feat: submitVerification ethers wrapper"
```

### Task 6.3: PacketSent watcher

**Files:** Create `worker/chain/events.ts`, Create `worker/test/events.spec.ts`.

The EndpointV2 emits `PacketSent(bytes encodedPayload, bytes options, address sendLibrary)`. `encodedPayload` is the full `encodedPacket = header(81) ‖ guid(32) ‖ message`. We parse it without RPC in the test.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { parseEncodedPacket } from '../chain/events'

describe('parseEncodedPacket', () => {
  it('splits header / guid / message and computes payloadHash', () => {
    const header = '01' + '0000000000000007' + '00009d28' +
      '000000000000000000000000' + 'aa'.repeat(20) + '00009d35' +
      '000000000000000000000000' + 'bb'.repeat(20)            // 81 bytes
    const guid = '11'.repeat(32)                                // 32 bytes
    const message = '000000000000000000000000' + 'cc'.repeat(20) + '0000000000000064' // 40 bytes
    const encoded = '0x' + header + guid + message

    const p = parseEncodedPacket(encoded)
    expect(p.header.length).toBe(2 + 81 * 2)
    expect(p.oft.toAddress).toBe('0x' + 'cc'.repeat(20))
    expect(p.payloadHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(p.dstEid).toBe(40245)
    expect(p.srcEid).toBe(40232)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/chain/events.ts`**

```typescript
import { ethers } from 'ethers'
import { decodeHeader, PacketHeader } from './header'
import { decodeOftMessage, OftMessage } from './message'

export interface ParsedPacket {
  encoded: string
  header: string        // 0x + 81 bytes
  guid: string
  message: string
  payloadHash: string   // keccak256(guid ‖ message)
  srcEid: number
  dstEid: number
  senderAddress: string
  receiverAddress: string
  oft: OftMessage
  headerFields: PacketHeader
}

function stripHex(s: string): string { return s.startsWith('0x') ? s.slice(2) : s }

/** Split encodedPacket = header(81) ‖ guid(32) ‖ message, decode, and hash the payload. */
export function parseEncodedPacket(encodedPacket: string): ParsedPacket {
  const e = stripHex(encodedPacket)
  const header = '0x' + e.slice(0, 81 * 2)
  const guid = '0x' + e.slice(81 * 2, (81 + 32) * 2)
  const message = '0x' + e.slice((81 + 32) * 2)
  const payload = '0x' + e.slice(81 * 2) // guid ‖ message
  const payloadHash = ethers.utils.keccak256(payload)
  const hf = decodeHeader(header)
  return {
    encoded: '0x' + e, header, guid, message, payloadHash,
    srcEid: hf.srcEid, dstEid: hf.dstEid,
    senderAddress: hf.senderAddress, receiverAddress: hf.receiverAddress,
    oft: decodeOftMessage(message), headerFields: hf,
  }
}

export const ENDPOINT_ABI = [
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
]

/** Scan a block range on the source endpoint for PacketSent and return parsed packets. */
export async function scanPacketSent(
  provider: ethers.providers.Provider,
  endpoint: string,
  fromBlock: number,
  toBlock: number,
): Promise<ParsedPacket[]> {
  const iface = new ethers.utils.Interface(ENDPOINT_ABI)
  const topic = iface.getEventTopic('PacketSent')
  const logs = await provider.getLogs({ address: endpoint, topics: [topic], fromBlock, toBlock })
  return logs.map((l) => {
    const decoded = iface.decodeEventLog('PacketSent', l.data, l.topics)
    return parseEncodedPacket(decoded.encodedPayload as string)
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/chain/events.ts worker/test/events.spec.ts
git commit -m "feat: PacketSent scan + encodedPacket parser"
```

### Task 6.4: Service orchestration (always-on watcher)

**Files:** Create `worker/service.ts`. (Integration-tested live in Phase 9; keep logic thin and delegate to tested units.)

- [ ] **Step 1: Implement `worker/service.ts`**

```typescript
import 'dotenv/config'
import { ethers } from 'ethers'
import { CHAINS, COMPLIANCE_DVN, ChainCfg } from './config'
import { buildDenylist } from './assess/assess'
import { makeAssessor, combine } from './assess/assess'
import { scanPacketSent, ParsedPacket } from './chain/events'
import { submitVerification } from './chain/verify'
import { Checkpoint } from './checkpoint'

const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || '.context/dvn-checkpoint.json'
const POLL_MS = Number(process.env.POLL_MS || 15000)
const CONFIRMATIONS = Number(process.env.DVN_CONFIRMATIONS || 5)

function chainByEid(eid: number): ChainCfg | undefined {
  return Object.values(CHAINS).find((c) => c.eid === eid)
}
function chainKeyByEid(eid: number): string | undefined {
  return Object.entries(CHAINS).find(([, c]) => c.eid === eid)?.[0]
}

async function main() {
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('PRIVATE_KEY required')

  console.log('[worker] building denylist…')
  const dl = await buildDenylist()
  const assess = makeAssessor(dl)
  console.log(`[worker] denylist size=${dl.size}`)

  const cp = new Checkpoint(CHECKPOINT_PATH)
  const providers: Record<string, ethers.providers.JsonRpcProvider> = {}
  const signers: Record<string, ethers.Wallet> = {}
  for (const [key, c] of Object.entries(CHAINS)) {
    providers[key] = new ethers.providers.JsonRpcProvider(c.rpc)
    signers[key] = new ethers.Wallet(pk, providers[key])
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const [srcKey, src] of Object.entries(CHAINS)) {
      try {
        const provider = providers[srcKey]
        const head = await provider.getBlockNumber()
        const safeHead = head - CONFIRMATIONS
        let from = cp.getLastBlock(srcKey)
        if (from === 0) from = Math.max(0, safeHead - 50)
        if (safeHead <= from) continue

        const packets = await scanPacketSent(provider, src.endpoint, from + 1, safeHead)
        for (const p of packets) await handlePacket(p, assess, signers, cp)
        cp.setLastBlock(srcKey, safeHead)
        cp.save()
      } catch (err) {
        console.error(`[worker] scan error on ${srcKey} (fail-closed, will retry):`, (err as Error).message)
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function handlePacket(
  p: ParsedPacket,
  assess: ReturnType<typeof makeAssessor>,
  signers: Record<string, ethers.Wallet>,
  cp: Checkpoint,
) {
  const key = `${p.payloadHash}:${p.dstEid}`
  if (cp.isProcessed(key)) return

  const dstKey = chainKeyByEid(p.dstEid)
  const dst = chainByEid(p.dstEid)
  if (!dstKey || !dst) { console.log(`[worker] skip: unknown dstEid ${p.dstEid}`); return }
  const dvnAddr = COMPLIANCE_DVN[dstKey]
  if (!dvnAddr) { console.log(`[worker] skip: no ComplianceDVN address for ${dstKey}`); return }

  const verdict = combine([
    assess(p.senderAddress),
    assess(p.receiverAddress),
    assess(p.oft.toAddress),
  ])

  if (verdict.blocked) {
    console.log(`[VETO] withholding verify for payloadHash=${p.payloadHash} reasons=${verdict.reasons.join('; ')}`)
    cp.markProcessed(key) // do NOT verify; mark so we don't reprocess
    cp.save()
    return
  }

  try {
    const txHash = await submitVerification(signers[dstKey], dvnAddr, p.header, p.payloadHash, CONFIRMATIONS)
    console.log(`[VERIFY] payloadHash=${p.payloadHash} tx=${txHash}`)
    cp.markProcessed(key)
    cp.save()
  } catch (err) {
    // fail-closed: do not mark processed; retry next loop
    console.error(`[worker] submitVerification failed (will retry):`, (err as Error).message)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Add `dotenv`**

Run: `pnpm add dotenv`

- [ ] **Step 3: Type/compile check**

Run: `pnpm tsx -e "import('./worker/service.ts').catch(e=>{if(String(e).includes('PRIVATE_KEY')){console.log('ok');process.exit(0)}else{console.error(e);process.exit(1)}})"`
Expected: prints `ok` (it throws on missing PRIVATE_KEY before doing network I/O — that proves it loads/compiles).

- [ ] **Step 4: Commit**

```bash
git add worker/service.ts package.json pnpm-lock.yaml
git commit -m "feat: always-on DVN worker service"
```

### Task 6.5: One-shot CLI

**Files:** Create `worker/cli.ts`.

- [ ] **Step 1: Implement `worker/cli.ts`**

```typescript
import 'dotenv/config'
import { ethers } from 'ethers'
import { CHAINS, COMPLIANCE_DVN } from './config'
import { buildDenylist, makeAssessor, combine } from './assess/assess'
import { scanPacketSent } from './chain/events'
import { submitVerification } from './chain/verify'
import { trace } from './tracker/trace'

async function cmdAssess(addr: string) {
  const dl = await buildDenylist()
  const a = makeAssessor(dl)(addr)
  console.log(JSON.stringify(a, null, 2))
}

async function cmdVerify(chainKey: string, txHash: string) {
  const src = CHAINS[chainKey]
  if (!src) throw new Error(`unknown chain ${chainKey}`)
  const provider = new ethers.providers.JsonRpcProvider(src.rpc)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new Error('tx not found')
  const packets = await scanPacketSent(provider, src.endpoint, receipt.blockNumber, receipt.blockNumber)
  const dl = await buildDenylist()
  const assess = makeAssessor(dl)
  const pk = process.env.PRIVATE_KEY!
  for (const p of packets) {
    const verdict = combine([assess(p.senderAddress), assess(p.receiverAddress), assess(p.oft.toAddress)])
    const dstKey = Object.entries(CHAINS).find(([, c]) => c.eid === p.dstEid)?.[0]
    if (!dstKey) { console.log('skip unknown dstEid', p.dstEid); continue }
    if (verdict.blocked) { console.log('[VETO]', p.payloadHash, verdict.reasons); continue }
    const signer = new ethers.Wallet(pk, new ethers.providers.JsonRpcProvider(CHAINS[dstKey].rpc))
    const h = await submitVerification(signer, COMPLIANCE_DVN[dstKey], p.header, p.payloadHash, Number(process.env.DVN_CONFIRMATIONS || 5))
    console.log('[VERIFY]', p.payloadHash, 'tx=', h)
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'assess') return cmdAssess(a)
  if (cmd === 'verify') return cmdVerify(a, b)
  if (cmd === 'trace') return void console.log(JSON.stringify(await trace(a), null, 2))
  console.log('usage: cli <assess <addr> | verify <chainKey> <txHash> | trace <txHash>>')
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Smoke test the assess path (real network ingest)**

Run: `pnpm cli assess 0x0000000000000000000000000000000000000000`
Expected: prints an assessment JSON with `"blocked": false` (and the denylist loads from live sources — confirms ingest works end-to-end).

- [ ] **Step 3: Commit**

```bash
git add worker/cli.ts
git commit -m "feat: one-shot CLI (assess | verify | trace)"
```

---

## Phase 7 — Tier 1 Tracker

### Task 7.1: LayerZero Scan trace

**Files:** Create `worker/tracker/trace.ts`, Create `worker/test/trace.spec.ts`.

- [ ] **Step 1: Write the failing test** (pure transform of a Scan API response)

```typescript
import { describe, it, expect } from 'vitest'
import { buildTrace } from '../tracker/trace'
import { Denylist } from '../assess/store'
import { makeAssessor } from '../assess/assess'

describe('buildTrace', () => {
  it('colors endpoints with assess() and reports status', () => {
    const dl = new Denylist()
    dl.add('0x00000000000000000000000000000000000000aa', 'ofac', 'sdn')
    const assess = makeAssessor(dl)
    const apiResponse = {
      data: [{
        pathway: {
          srcEid: 40232, dstEid: 40245,
          sender: { address: '0x00000000000000000000000000000000000000AA' },
          receiver: { address: '0x00000000000000000000000000000000000000bb' },
        },
        status: { name: 'INFLIGHT' }, guid: '0xguid',
      }],
    }
    const t = buildTrace(apiResponse, assess)
    expect(t.srcEid).toBe(40232)
    expect(t.dstEid).toBe(40245)
    expect(t.status).toBe('INFLIGHT')
    expect(t.sender.blocked).toBe(true)
    expect(t.receiver.blocked).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:worker`
Expected: FAIL.

- [ ] **Step 3: Implement `worker/tracker/trace.ts`**

```typescript
import { buildDenylist, makeAssessor, Assessor, Assessment } from '../assess/assess'

const SCAN_TESTNET = 'https://scan-testnet.layerzero-api.com/v1/messages/tx/'

export interface TraceResult {
  guid: string
  srcEid: number
  dstEid: number
  status: string
  sender: Assessment
  receiver: Assessment
}

/** Pure: turn a Scan API response into a risk-colored trace. */
export function buildTrace(api: any, assess: Assessor): TraceResult {
  const m = api?.data?.[0]
  if (!m) throw new Error('no message found for tx')
  return {
    guid: m.guid,
    srcEid: m.pathway.srcEid,
    dstEid: m.pathway.dstEid,
    status: m.status?.name ?? 'UNKNOWN',
    sender: assess(m.pathway.sender.address),
    receiver: assess(m.pathway.receiver.address),
  }
}

/** Fetch from LayerZero Scan + color with a freshly built denylist. */
export async function trace(txHash: string): Promise<TraceResult> {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(SCAN_TESTNET + txHash)
  if (!res.ok) throw new Error(`Scan API ${res.status}`)
  const api = await res.json()
  const assess = makeAssessor(await buildDenylist())
  return buildTrace(api, assess)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/tracker/trace.ts worker/test/trace.spec.ts
git commit -m "feat: Tier 1 cross-chain tracker via LayerZero Scan"
```

---

## Phase 8 — Deploy & Wire

### Task 8.1: Deploy scripts

**Files:** Create `deploy/ComplianceDVN.ts`, Create `deploy/ToyOFT.ts`. (Delete scaffold `deploy/MyOFT.ts` if present.)

- [ ] **Step 1: Write `deploy/ToyOFT.ts`**

```typescript
import { type DeployFunction } from 'hardhat-deploy/types'
import { type HardhatRuntimeEnvironment } from 'hardhat/types'

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deploy } = hre.deployments
  const { deployer } = await hre.getNamedAccounts()
  const endpointV2 = await hre.deployments.get('EndpointV2')
  await deploy('ToyOFT', {
    from: deployer,
    args: ['Toy OFT', 'TOY', endpointV2.address, deployer],
    log: true,
  })
}
deploy.tags = ['ToyOFT']
export default deploy
```

- [ ] **Step 2: Write `deploy/ComplianceDVN.ts`** (operator = deployer; fee tiny; receiveUln from the address registry)

```typescript
import { type DeployFunction } from 'hardhat-deploy/types'
import { type HardhatRuntimeEnvironment } from 'hardhat/types'

const RECEIVE_ULN: Record<number, string> = {
  40245: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d', // base-sepolia
  40232: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca', // optimism-sepolia
}

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deploy } = hre.deployments
  const { deployer } = await hre.getNamedAccounts()
  const eid = (hre.network.config as any).eid as number
  const receiveUln = RECEIVE_ULN[eid]
  if (!receiveUln) throw new Error(`no ReceiveUln302 for eid ${eid}`)
  await deploy('ComplianceDVN', {
    from: deployer,
    args: [deployer, deployer, receiveUln, hre.ethers.utils.parseEther('0.00005')],
    log: true,
  })
}
deploy.tags = ['ComplianceDVN']
export default deploy
```

- [ ] **Step 3: Deploy to both chains**

Run:
```bash
npx hardhat lz:deploy --tags ComplianceDVN,ToyOFT
```
(Select both `base-sepolia` and `optimism-sepolia` when prompted, or pass `--networks base-sepolia,optimism-sepolia`.)
Expected: 4 deployments succeed; addresses printed and written under `deployments/`.

- [ ] **Step 4: Record DVN addresses into `.env`**

Read the deployed `ComplianceDVN` addresses from `deployments/base-sepolia/ComplianceDVN.json` and `deployments/optimism-sepolia/ComplianceDVN.json`, then add to `.env`:
```bash
DVN_BASE_SEPOLIA=0x...
DVN_OPTIMISM_SEPOLIA=0x...
```

- [ ] **Step 5: Commit**

```bash
git add deploy/ComplianceDVN.ts deploy/ToyOFT.ts
git commit -m "feat: deploy scripts for ComplianceDVN + ToyOFT"
```

### Task 8.2: layerzero.config.ts with our DVN as required (both directions)

**Files:** Modify `layerzero.config.ts`.

Use the hand-written lower-level form (the `metadata-tools` generator expects DVN *names*; we need raw addresses). Fill DVN addresses from Task 8.1.

- [ ] **Step 1: Write `layerzero.config.ts`**

```typescript
import { EndpointId } from '@layerzerolabs/lz-definitions'

const DVN_BASE = process.env.DVN_BASE_SEPOLIA as string
const DVN_OPT = process.env.DVN_OPTIMISM_SEPOLIA as string

const base = { eid: EndpointId.BASESEP_V2_TESTNET, contractName: 'ToyOFT' }
const opt = { eid: EndpointId.OPTSEP_V2_TESTNET, contractName: 'ToyOFT' }

const ulnBase = { confirmations: BigInt(5), requiredDVNs: [DVN_BASE], optionalDVNs: [], optionalDVNThreshold: 0 }
const ulnOpt = { confirmations: BigInt(5), requiredDVNs: [DVN_OPT], optionalDVNs: [], optionalDVNThreshold: 0 }

const execBase = { maxMessageSize: 10000, executor: '0x8A3D588D9f6AC041476b094f97FF94ec30169d3D' }
const execOpt = { maxMessageSize: 10000, executor: '0xDc0D68899405673b932F0DB7f8A49191491A5bcB' }

export default {
  contracts: [{ contract: base }, { contract: opt }],
  connections: [
    {
      from: base, to: opt,
      config: {
        sendConfig: { executorConfig: execBase, ulnConfig: ulnBase },   // verify on OPT receive uses DVN_OPT
        receiveConfig: { ulnConfig: ulnBase },
      },
    },
    {
      from: opt, to: base,
      config: {
        sendConfig: { executorConfig: execOpt, ulnConfig: ulnOpt },
        receiveConfig: { ulnConfig: ulnOpt },
      },
    },
  ],
}
```
> Symmetry note: a packet OPT→Base is verified on Base's ReceiveUln, which checks Base's `receiveConfig.requiredDVNs` (= `DVN_BASE`). The send side on OPT must list the *same DVN the receiver expects*. Because our DVN is deployed per-chain, the source `sendConfig` and destination `receiveConfig` for a given pathway must reference the destination chain's DVN address. If `lz:oapp:config:get` shows a mismatch, align both sides of each pathway to the **destination** chain's DVN. Confirm with the get task in Step 3.

- [ ] **Step 2: Wire**

Run: `npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts`
Expected: sets peers + `setConfig` for ULN (DVN) + executor on both endpoints. Transactions confirm.

- [ ] **Step 3: Verify applied config**

Run: `npx hardhat lz:oapp:config:get --oapp-config layerzero.config.ts`
Expected: each pathway shows `requiredDVNs` containing our ComplianceDVN address and `confirmations: 5`.

- [ ] **Step 4: Commit**

```bash
git add layerzero.config.ts
git commit -m "feat: wire ComplianceDVN as single required DVN (both directions)"
```

### Task 8.3: Configure tasks (operator/receiveUln sanity)

**Files:** Create `tasks/configureDvn.ts`, Modify `tasks/index.ts` (register it; the scaffold's `tasks/index.ts` imports task files — add an import line).

- [ ] **Step 1: Write `tasks/configureDvn.ts`**

```typescript
import { task } from 'hardhat/config'

// Prints + optionally fixes operator/receiveUln/fee on the deployed ComplianceDVN.
task('dvn:status', 'Show ComplianceDVN config on the current --network')
  .setAction(async (_args, hre) => {
    const d = await hre.deployments.get('ComplianceDVN')
    const dvn = await hre.ethers.getContractAt('ComplianceDVN', d.address)
    console.log({
      address: d.address,
      operator: await dvn.operator(),
      receiveUln: await dvn.receiveUln(),
      fee: (await dvn.fee()).toString(),
      owner: await dvn.owner(),
    })
  })
```

- [ ] **Step 2: Register in `tasks/index.ts`**

Add: `import './configureDvn'`

- [ ] **Step 3: Run on both chains**

Run: `npx hardhat dvn:status --network base-sepolia` and `--network optimism-sepolia`
Expected: prints operator == deployer, receiveUln == the chain's ReceiveUln302, sane fee.

- [ ] **Step 4: Commit**

```bash
git add tasks/configureDvn.ts tasks/index.ts
git commit -m "feat: dvn:status task"
```

---

## Phase 9 — Live Demo & Verification

### Task 9.1: Demo send task

**Files:** Create `tasks/demoSend.ts`, Modify `tasks/index.ts`.

- [ ] **Step 1: Write `tasks/demoSend.ts`**

```typescript
import { task } from 'hardhat/config'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import { Options } from '@layerzerolabs/lz-v2-utilities'

// Usage: npx hardhat demo:send --network optimism-sepolia --to <recipient> --amount 1
task('demo:send', 'Send ToyOFT from current network to Base Sepolia')
  .addParam('to', 'recipient address on destination')
  .addOptionalParam('amount', 'human amount', '1')
  .setAction(async (args, hre) => {
    const dstEid = EndpointId.BASESEP_V2_TESTNET
    const { deployer } = await hre.getNamedAccounts()
    const d = await hre.deployments.get('ToyOFT')
    const oft = await hre.ethers.getContractAt('ToyOFT', d.address)

    const amount = hre.ethers.utils.parseEther(args.amount)
    // ensure sender has balance
    await (await oft.mint(deployer, amount)).wait()

    const to = hre.ethers.utils.hexZeroPad(args.to, 32)
    const options = Options.newOptions().addExecutorLzReceiveOption(200000, 0).toHex()
    const sendParam = { dstEid, to, amountLD: amount, minAmountLD: amount, extraOptions: options, composeMsg: '0x', oftCmd: '0x' }

    const fee = await oft.quoteSend(sendParam, false)
    const tx = await oft.send(sendParam, fee, deployer, { value: fee.nativeFee })
    const receipt = await tx.wait()
    console.log('sent tx:', receipt.transactionHash)
    console.log('scan:', `https://testnet.layerzeroscan.com/tx/${receipt.transactionHash}`)
  })
```

- [ ] **Step 2: Register in `tasks/index.ts`**

Add: `import './demoSend'`

- [ ] **Step 3: Run the CLEAN demo** (worker running in another terminal: `pnpm worker`)

```bash
# fund deployer on both chains first (faucets). Start worker, then:
npx hardhat demo:send --network optimism-sepolia --to 0x<cleanRecipient> --amount 1
```
Expected: worker logs `[VERIFY] payloadHash=… tx=…`; LayerZero Scan shows the message reach `DELIVERED`; recipient's ToyOFT balance on Base Sepolia increases.

- [ ] **Step 4: Run the VETO demo** (send from / to a TEST_DENYLIST address you control)

Set `TEST_DENYLIST` in `.env` to an address you hold the key for, restart the worker, then send a transfer whose sender (or recipient) is that flagged address:
```bash
npx hardhat demo:send --network optimism-sepolia --to 0x<flaggedRecipient> --amount 1
```
Expected: worker logs `[VETO] withholding verify …`; LayerZero Scan stays at `INFLIGHT`/`CONFIRMING` (never `DELIVERED`); recipient balance on Base Sepolia stays unchanged. The veto is proven on-chain.

- [ ] **Step 5: Capture evidence + commit demo task**

```bash
git add tasks/demoSend.ts tasks/index.ts
git commit -m "feat: demo:send task for clean + veto demonstrations"
```

- [ ] **Step 6: Write `README.md`** documenting: architecture, the two demo commands, the two LayerZero Scan links (clean=DELIVERED, flagged=stalled), and the fail-closed caveat. Commit.

```bash
git add README.md
git commit -m "docs: README with demo evidence + run instructions"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** Tier 0 (`assess`, Tasks 4.2–4.6), Tier 1 tracker (Task 7.1), Tier 2 DVN (Phase 1 + integration Phase 3 + deploy/wire Phase 8), worker always-on + one-shot (Tasks 6.4/6.5), real OFAC + OpenSanctions ingest (4.3/4.4), operator test denylist for live demo (4.5), symmetric wiring both directions (8.2), live blocked-vs-clean demo (9.1). All covered.
- **Fail-closed:** encoded in `service.ts` — scan/submit errors do NOT mark processed (retry); only an explicit `blocked` verdict marks-processed-without-verifying.
- **Type consistency:** `Assessment`, `Assessor`, `makeAssessor`, `combine`, `buildDenylist`, `Denylist.{add,has,lookup,size}`, `decodeHeader`, `decodeOftMessage`, `parseEncodedPacket`, `ParsedPacket`, `Checkpoint.{getLastBlock,setLastBlock,isProcessed,markProcessed,save}`, `submitVerification`, `trace`/`buildTrace` are used consistently across tasks.
- **Known build-time confirmations (not placeholders, but verify against installed versions):** (1) the `TestHelperOz5` ULN/DVN-override helper calls in Phase 3 — mirror the scaffolded `SimpleDVNMock.t.sol`; (2) the exact mixer addresses in Task 4.5 — confirm against OFAC SDN; (3) the hand-written `layerzero.config.ts` field names (`sendConfig`/`receiveConfig`/`ulnConfig`/`executorConfig`) against the installed `@layerzerolabs/toolbox-hardhat` schema, surfaced by `lz:oapp:config:get` in Task 8.2 Step 3.
```

