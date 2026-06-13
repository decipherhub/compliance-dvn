// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ComplianceDVN } from "../../contracts/ComplianceDVN.sol";

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

    receive() external payable {}
}
