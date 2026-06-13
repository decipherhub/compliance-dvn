// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ToyOFT } from "../../contracts/ToyOFT.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";

contract ToyOFTTest is TestHelperOz5 {
    ToyOFT oft;

    function setUp() public override {
        super.setUp();
        setUpEndpoints(1, LibraryType.UltraLightNode);

        oft = ToyOFT(
            _deployOApp(
                type(ToyOFT).creationCode,
                abi.encode("Toy", "TOY", address(endpoints[1]), address(this))
            )
        );
    }

    function test_mint_increasesBalance() public {
        oft.mint(address(0xABCD), 5 ether);
        assertEq(oft.balanceOf(address(0xABCD)), 5 ether);
    }
}
