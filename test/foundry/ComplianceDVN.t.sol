// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";
import { ILayerZeroDVN } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/ILayerZeroDVN.sol";

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
        dvn = new ComplianceDVN(address(this), operator, receiveUln, 0.0001 ether);
    }

    function test_getFee_returnsConfiguredFee() public view {
        uint256 fee = dvn.getFee(40245, 5, address(0x1234), "");
        assertEq(fee, 0.0001 ether);
    }

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
}
