// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";
import { ILayerZeroDVN } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/ILayerZeroDVN.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract MockReceiveUln {
    bytes public lastHeader;
    bytes32 public lastPayloadHash;
    uint64 public lastConfirmations;
    uint256 public calls;

    function verify(bytes calldata h, bytes32 ph, uint64 c) external {
        lastHeader = h; lastPayloadHash = ph; lastConfirmations = c; calls++;
    }
}

contract ComplianceDVNTest is Test {
    ComplianceDVN dvn;
    address operator = address(0xBEEF);
    address receiveUln = address(0xCAFE);

    function setUp() public {
        // sendUln = this test contract, so the assignJob tests below can call it directly.
        dvn = new ComplianceDVN(address(this), operator, address(this), receiveUln, 0.0001 ether);
    }

    function test_getFee_returnsConfiguredFee() public view {
        uint256 fee = dvn.getFee(40245, 5, address(0x1234), "");
        assertEq(fee, 0.0001 ether);
    }

    function test_submitVerification_onlyOperator() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(ComplianceDVN.NotOperator.selector);
        dvn.submitVerification(hex"01", keccak256("p"), 5, 0, 0, 0, bytes32(0));
    }

    function test_submitVerification_forwardsToReceiveUln_andEmitsVerdict() public {
        MockReceiveUln mock = new MockReceiveUln();
        ComplianceDVN d = new ComplianceDVN(address(this), operator, address(this), address(mock), 0);
        vm.expectEmit(true, false, false, true);
        emit ComplianceDVN.RiskVerdict(keccak256("p"), 0, 12, 5, keccak256("ev"));
        vm.prank(operator);
        d.submitVerification(hex"0102", keccak256("p"), 7, 0, 12, 5, keccak256("ev"));
        assertEq(mock.calls(), 1);
        assertEq(mock.lastPayloadHash(), keccak256("p"));
        assertEq(mock.lastConfirmations(), 7);
    }

    /// A packet that was blocked or held cannot also have been verified — the audit trail must
    /// not be able to contradict itself.
    function test_submitVerification_rejectsNonAllowAction() public {
        MockReceiveUln mock = new MockReceiveUln();
        ComplianceDVN d = new ComplianceDVN(address(this), operator, address(this), address(mock), 0);
        for (uint8 action = 1; action <= 3; action++) {
            vm.prank(operator);
            vm.expectRevert(abi.encodeWithSelector(ComplianceDVN.VerificationRequiresAllow.selector, action));
            d.submitVerification(hex"01", keccak256("p"), 5, action, 0, 0, bytes32(0));
        }
        assertEq(mock.calls(), 0, "no verification may have reached the ULN");
    }

    function test_recordVerdict_emitsForOperator() public {
        vm.expectEmit(true, false, false, true);
        emit ComplianceDVN.RiskVerdict(keccak256("p"), 3, 100, 1, keccak256("ev"));
        vm.prank(operator);
        dvn.recordVerdict(keccak256("p"), 3, 100, 1, keccak256("ev"));
    }

    function test_recordVerdict_onlyOperator() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(ComplianceDVN.NotOperator.selector);
        dvn.recordVerdict(keccak256("p"), 3, 100, 1, bytes32(0));
    }

    /// An allow rides along on submitVerification, so recording one separately would
    /// double-report the same outcome.
    function test_recordVerdict_rejectsAllow() public {
        vm.prank(operator);
        vm.expectRevert(ComplianceDVN.AllowNotSeparatelyRecorded.selector);
        dvn.recordVerdict(keccak256("p"), 0, 0, 0, bytes32(0));
    }

    function test_recordVerdict_rejectsUnknownAction() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComplianceDVN.UnknownAction.selector, uint8(4)));
        dvn.recordVerdict(keccak256("p"), 4, 0, 0, bytes32(0));
    }

    /// These codes are part of the event ABI; an indexer decoding old logs depends on them.
    function test_actionCodes_arePinned() public view {
        assertEq(dvn.ACTION_ALLOW(), 0);
        assertEq(dvn.ACTION_DELAY(), 1);
        assertEq(dvn.ACTION_MANUAL_REVIEW(), 2);
        assertEq(dvn.ACTION_BLOCK(), 3);
    }

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

    function test_approvePacket_emitsForOwner() public {
        vm.expectEmit(true, false, false, true);
        emit ComplianceDVN.PacketApproved(keccak256("p"), address(this));
        dvn.approvePacket(keccak256("p"));
    }

    // Approval is a human override of a risk verdict, so the operator key the worker holds
    // must NOT be able to release the packets that worker chose to withhold.
    function test_approvePacket_rejectsOperator() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        dvn.approvePacket(keccak256("p"));
    }

    function test_approvePacket_rejectsStranger() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xDEAD)));
        dvn.approvePacket(keccak256("p"));
    }

    function test_setters_onlyOwner() public {
        dvn.setOperator(address(0xAAA));
        assertEq(dvn.operator(), address(0xAAA));
        dvn.setSendUln(address(0xCCC));
        assertEq(dvn.sendUln(), address(0xCCC));
        dvn.setReceiveUln(address(0xBBB));
        assertEq(dvn.receiveUln(), address(0xBBB));
        dvn.setFee(123);
        assertEq(dvn.fee(), 123);

        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xDEAD)));
        dvn.setFee(999);
    }

    function test_withdraw_sendsBalanceToOwner() public {
        vm.deal(address(dvn), 1 ether);
        uint256 before = address(this).balance;
        dvn.withdraw(payable(address(this)));
        assertEq(address(this).balance, before + 1 ether);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xDEAD)));
        dvn.withdraw(payable(address(0xDEAD)));
    }

    // SendUln302 calls assignJob with msg.value == 0 (it accrues fees internally), so
    // assignJob MUST succeed without payment — guard against re-introducing a value check.
    function test_assignJob_succeedsWithZeroValue() public {
        ILayerZeroDVN.AssignJobParam memory p = ILayerZeroDVN.AssignJobParam({
            dstEid: 40245,
            packetHeader: hex"01",
            payloadHash: keccak256("payload"),
            confirmations: 5,
            sender: address(0x1234)
        });
        uint256 ret = dvn.assignJob{ value: 0 }(p, "");
        assertEq(ret, 0.0001 ether);
    }

    // The worker treats a JobAssigned payloadHash as "ours to screen" and spends operator gas
    // verifying it, so anyone able to assign jobs could point the worker at foreign packets.
    function test_assignJob_rejectsNonSendLibrary() public {
        ILayerZeroDVN.AssignJobParam memory p = ILayerZeroDVN.AssignJobParam({
            dstEid: 40245,
            packetHeader: hex"01",
            payloadHash: keccak256("payload"),
            confirmations: 5,
            sender: address(0x1234)
        });
        vm.prank(address(0xDEAD));
        vm.expectRevert(ComplianceDVN.NotSendLibrary.selector);
        dvn.assignJob(p, "");
    }

    receive() external payable {}
}
