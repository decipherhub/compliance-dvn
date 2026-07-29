// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal stand-in for ReceiveUln302: records what `verify` was called with so tests
///         can assert the DVN forwarded the attestation faithfully.
contract ReceiveUlnMock {
    bytes public lastHeader;
    bytes32 public lastPayloadHash;
    uint64 public lastConfirmations;
    uint256 public calls;

    function verify(bytes calldata _header, bytes32 _payloadHash, uint64 _confirmations) external {
        lastHeader = _header;
        lastPayloadHash = _payloadHash;
        lastConfirmations = _confirmations;
        calls++;
    }
}
