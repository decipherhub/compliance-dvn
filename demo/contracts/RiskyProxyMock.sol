// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title RiskyProxyMock
/// @notice A testnet decoy that looks like an upgradeable proxy controlled by a flagged address,
///         for exercising the risk engine's `contract_admin_risk` check.
/// @dev The engine reads the two EIP-1967 slots directly (see `assess/providers/contract.ts`):
///      an implementation slot that is set means the code behind this address can change, and the
///      admin slot names whoever can change it. It then looks that admin up in the risk store —
///      a flagged admin is the signal, because today's clean code says nothing about tomorrow's
///      if a sanctioned party can swap it out.
///
///      The slots are written straight to storage rather than by deploying a real proxy: what is
///      being demonstrated is the engine's reading of them, and a forwarding proxy would add a
///      delegatecall path with nothing to delegate to.
contract RiskyProxyMock {
    /// @dev keccak256("eip1967.proxy.implementation") - 1
    bytes32 private constant SLOT_IMPLEMENTATION =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    /// @dev keccak256("eip1967.proxy.admin") - 1
    bytes32 private constant SLOT_ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    /// @param _admin The address to present as able to upgrade this contract. Point it at an
    ///        address the operator has flagged (e.g. one in TEST_DENYLIST) for the check to fire.
    /// @param _implementation Any non-zero address; its only job is to make the proxy slot set.
    constructor(address _admin, address _implementation) {
        require(_admin != address(0), "zero admin");
        require(_implementation != address(0), "zero implementation");
        assembly {
            sstore(SLOT_ADMIN, _admin)
            sstore(SLOT_IMPLEMENTATION, _implementation)
        }
    }

    /// @notice The admin as stored in the EIP-1967 slot, for anyone reading it the easy way.
    function admin() external view returns (address a) {
        assembly {
            a := sload(SLOT_ADMIN)
        }
    }

    /// @notice The implementation as stored in the EIP-1967 slot.
    function implementation() external view returns (address i) {
        assembly {
            i := sload(SLOT_IMPLEMENTATION)
        }
    }
}
