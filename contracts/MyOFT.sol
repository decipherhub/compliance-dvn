// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";

contract MyOFT is OFT {
    constructor(
        string memory _name,
        string memory _symbol,
        address _lzEndpoint,
        address _delegate
    ) OFT(_name, _symbol, _lzEndpoint, _delegate) Ownable(_delegate) {}

    /// @notice Open mint, TESTNET ONLY — same as ToyOFT, so the demo tasks work against either.
    /// @dev Deliberately unguarded: the demo mints to itself before each send, and a testnet OFT
    ///      with no way to obtain tokens cannot be used to exercise the DVN at all. Do NOT ship
    ///      this to a network where the token has value.
    ///      `virtual` because MyOFTMock declares the same function for the hardhat tests.
    function mint(address _to, uint256 _amount) public virtual {
        _mint(_to, _amount);
    }
}
