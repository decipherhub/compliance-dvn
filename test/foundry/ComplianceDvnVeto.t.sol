// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// ---------------------------------------------------------------------------
// ComplianceDVN veto integration proof (Phase 3)
// ---------------------------------------------------------------------------
//
// MECHANISM (and why it is built this way):
//
// `TestHelperOz5.verifyPackets` / `validatePacket` is HARD-WIRED to the
// harness's built-in `DVNMock`: it reads `UlnConfig.requiredDVNs[0]`, casts it
// to `DVNMock`, and calls `dvn.hashCallData(...)` + `dvn.execute(...)` with an
// ECDSA signature from `vm.sign(1, ...)`. Our `ComplianceDVN` does NOT implement
// the `DVNMock` multisig (`hashCallData`/`execute`) interface, so the harness
// cannot drive verification through it. (See TestHelperOz5.sol:588-671.)
//
// Therefore we install our `ComplianceDVN` as the REQUIRED receive-side DVN in
// the ULN config and reproduce, by hand, exactly what `validatePacket` does for
// the ULN path (TestHelperOz5.sol:596-630), but routed through OUR DVN:
//
//   1. extract the inflight packet (header + payloadHash) from the harness queue
//      (getNextInflightPacket -> PacketV1Codec, mirroring validatePacket's
//       `packetHeader = _packetBytes.header()` / `keccak256(_packetBytes.payload())`)
//   2. operator calls `ComplianceDVN.submitVerification(header, payloadHash, conf)`
//      which forwards to `ReceiveUln302.verify(...)` with msg.sender == our DVN
//      (replaces the DVNMock `verify` ExecuteParam at validatePacket:605-617)
//   3. call `ReceiveUln302.commitVerification(header, payloadHash)` which gates on
//      `_checkVerifiable` — it passes ONLY because our required DVN verified
//      (replaces the DVNMock `commitVerification` ExecuteParam at validatePacket:620-630)
//   4. deliver via `endpoint.lzReceive(...)`, mirroring `TestHelperOz5.lzReceive`
//      (TestHelperOz5.sol:537-549).
//
//   - test_cleanTransfer_delivers: operator performs step 2; commit + lzReceive
//     succeed; recipient balance on B increases.
//   - test_flaggedTransfer_isVetoed: operator WITHHOLDS step 2; we assert
//     `commitVerification` REVERTS with LZ_ULN_Verifying (the receive lib refuses
//     to commit an unverified packet) and the recipient balance on B stays 0.
//
// This genuinely exercises send + (verify | withhold): the only difference
// between the two tests is whether the operator calls submitVerification.
// ---------------------------------------------------------------------------

import { Test } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";

import { ToyOFT } from "../../contracts/ToyOFT.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";

import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { IOFT, SendParam, OFTReceipt } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee, MessagingReceipt } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";

import { UlnConfig, SetDefaultUlnConfigParam } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import { IReceiveUlnE2 } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
import { PacketV1Codec } from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import { Origin, ILayerZeroEndpointV2 } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

// Interface for the bits of ReceiveUln302 we drive directly (override the default
// ULN config + commit a verified packet). `setDefaultUlnConfigs` lives on UlnBase.
interface IReceiveUlnConfigurable {
    function setDefaultUlnConfigs(SetDefaultUlnConfigParam[] calldata _params) external;
    function commitVerification(bytes calldata _packetHeader, bytes32 _payloadHash) external;
}

contract ComplianceDvnVetoTest is TestHelperOz5 {
    using OptionsBuilder for bytes;
    using PacketV1Codec for bytes;

    uint32 private aEid = 1;
    uint32 private bEid = 2;

    ToyOFT private aOFT;
    ToyOFT private bOFT;

    ComplianceDVN private dvnB;

    address private userA = makeAddr("userA");
    address private userB = makeAddr("userB");
    uint256 private initialBalance = 100 ether;

    // The harness default ULN config uses 100 confirmations.
    uint64 private constant CONFIRMATIONS = 100;

    function setUp() public virtual override {
        vm.deal(userA, 1000 ether);
        vm.deal(address(this), 1000 ether);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        // Receive lib for eid B, captured from the harness internal setup.
        // Gating is receive-side only, so we only need a DVN on B.
        address recvUlnB = endpointSetup.receiveLibs[1]; // eid 2

        // Deploy the ComplianceDVN for endpoint B. operator = this test, fee = 0
        // (the harness does not forward msg.value to assignJob).
        dvnB = new ComplianceDVN(address(this), address(this), recvUlnB, 0);

        // Install ComplianceDVN as the REQUIRED receive-side DVN for the A->B
        // pathway (delivery gating happens on the receive side, eid B, srcEid A).
        // This overrides the harness default that pointed at the built-in DVNMock.
        _setRequiredReceiveDVN(recvUlnB, aEid, address(dvnB));

        // Deploy the OFTs.
        aOFT = ToyOFT(
            _deployOApp(type(ToyOFT).creationCode, abi.encode("aOFT", "AOFT", address(endpoints[aEid]), address(this)))
        );
        bOFT = ToyOFT(
            _deployOApp(type(ToyOFT).creationCode, abi.encode("bOFT", "BOFT", address(endpoints[bEid]), address(this)))
        );

        address[] memory ofts = new address[](2);
        ofts[0] = address(aOFT);
        ofts[1] = address(bOFT);
        this.wireOApps(ofts);

        aOFT.mint(userA, initialBalance);
    }

    /// @dev Override the default receive ULN config so OUR ComplianceDVN is the
    ///      single required DVN for messages arriving from `_srcEid`.
    function _setRequiredReceiveDVN(address _receiveUln, uint32 _srcEid, address _dvn) internal {
        address[] memory required = new address[](1);
        required[0] = _dvn;
        address[] memory optional = new address[](0);

        UlnConfig memory cfg = UlnConfig({
            confirmations: CONFIRMATIONS,
            requiredDVNCount: 1,
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            requiredDVNs: required,
            optionalDVNs: optional
        });

        SetDefaultUlnConfigParam[] memory params = new SetDefaultUlnConfigParam[](1);
        params[0] = SetDefaultUlnConfigParam(_srcEid, cfg);
        // address(this) is the delegate/owner of the harness libs.
        IReceiveUlnConfigurable(_receiveUln).setDefaultUlnConfigs(params);
    }

    // ----- packet plumbing helpers ------------------------------------------

    /// @dev calldata-context view of the codec slices for a queued packet.
    function _headerOf(bytes calldata _packet) external pure returns (bytes memory) {
        return _packet.header();
    }

    function _payloadHashOf(bytes calldata _packet) external pure returns (bytes32) {
        return keccak256(_packet.payload());
    }

    function _sendAtoB(uint256 _amount) internal returns (bytes memory packet) {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);
        SendParam memory sendParam = SendParam(
            bEid,
            addressToBytes32(userB),
            _amount,
            _amount,
            options,
            "",
            ""
        );
        MessagingFee memory fee = aOFT.quoteSend(sendParam, false);

        vm.prank(userA);
        aOFT.send{ value: fee.nativeFee }(sendParam, fee, payable(userA));

        // Pull the inflight packet that the harness queued for bOFT on eid B.
        packet = getNextInflightPacket(uint16(bEid), addressToBytes32(address(bOFT)));
        require(packet.length > 0, "no inflight packet queued");
    }

    /// @dev Mirrors TestHelperOz5.lzReceive (537-549) for a single packet.
    function _deliver(bytes memory _packet) internal {
        ILayerZeroEndpointV2 endpoint = ILayerZeroEndpointV2(endpoints[bEid]);
        Origin memory origin = Origin(this._srcEidOf(_packet), this._senderOf(_packet), this._nonceOf(_packet));
        endpoint.lzReceive{ gas: 1_000_000 }(
            origin,
            this._receiverB20Of(_packet),
            this._guidOf(_packet),
            this._messageOf(_packet),
            bytes("")
        );
    }

    function _srcEidOf(bytes calldata _p) external pure returns (uint32) { return _p.srcEid(); }
    function _senderOf(bytes calldata _p) external pure returns (bytes32) { return _p.sender(); }
    function _nonceOf(bytes calldata _p) external pure returns (uint64) { return _p.nonce(); }
    function _receiverB20Of(bytes calldata _p) external pure returns (address) { return _p.receiverB20(); }
    function _guidOf(bytes calldata _p) external pure returns (bytes32) { return _p.guid(); }
    function _messageOf(bytes calldata _p) external pure returns (bytes calldata) { return _p.message(); }

    // ----- tests ------------------------------------------------------------

    function test_cleanTransfer_delivers() public {
        uint256 amount = 1 ether;
        assertEq(bOFT.balanceOf(userB), 0, "precondition: B balance 0");

        bytes memory packet = _sendAtoB(amount);
        bytes memory header = this._headerOf(packet);
        bytes32 payloadHash = this._payloadHashOf(packet);

        // Operator (this test) routes verification THROUGH our ComplianceDVN.
        dvnB.submitVerification(header, payloadHash, CONFIRMATIONS);

        // Now the required DVN has verified -> commit succeeds.
        IReceiveUlnConfigurable(address(dvnB.receiveUln())).commitVerification(header, payloadHash);

        // Deliver to the destination OApp.
        _deliver(packet);

        assertEq(bOFT.balanceOf(userB), amount, "clean transfer must deliver");
        assertEq(aOFT.balanceOf(userA), initialBalance - amount, "source debited");
    }

    function test_flaggedTransfer_isVetoed() public {
        uint256 amount = 1 ether;
        assertEq(bOFT.balanceOf(userB), 0, "precondition: B balance 0");

        bytes memory packet = _sendAtoB(amount);
        bytes memory header = this._headerOf(packet);
        bytes32 payloadHash = this._payloadHashOf(packet);

        // Operator WITHHOLDS submitVerification. The required DVN never verifies,
        // so commitVerification must revert (LZ_ULN_Verifying) and nothing can be
        // delivered to the endpoint.
        address receiveUln = address(dvnB.receiveUln());
        // Pin the SPECIFIC revert so an incidental failure can't masquerade as a
        // veto. LZ_ULN_Verifying is declared on ReceiveUlnBase (the receive lib
        // refuses to commit a packet whose required DVN has not verified).
        vm.expectRevert(abi.encodeWithSignature("LZ_ULN_Verifying()"));
        IReceiveUlnConfigurable(receiveUln).commitVerification(header, payloadHash);

        // Recipient balance stays 0: the veto blocked delivery.
        assertEq(bOFT.balanceOf(userB), 0, "withheld verification must block delivery");
        // Source funds remain debited/escrowed on A (send already burned them);
        // the point of the veto is that B never credits.
    }
}
