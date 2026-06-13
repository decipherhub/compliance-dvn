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
        require(_operator != address(0), "zero operator");
        require(_receiveUln != address(0), "zero receiveUln");
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

    function assignJob(AssignJobParam calldata _param, bytes calldata) external payable returns (uint256) {
        // NOTE: SendUln302 calls assignJob WITHOUT forwarding value (msg.value == 0); the
        // messagelib accrues each worker's fee internally and workers withdraw separately
        // (see SendUlnBase._assignJobs). So we must NOT require msg.value >= fee here — doing
        // so reverts every real send. We simply record the job and return our fee quote.
        emit JobAssigned(_param.dstEid, _param.payloadHash, _param.confirmations, _param.sender);
        return fee;
    }

    function submitVerification(
        bytes calldata packetHeader,
        bytes32 payloadHash,
        uint64 confirmations
    ) external onlyOperator {
        IReceiveUlnE2(receiveUln).verify(packetHeader, payloadHash, confirmations);
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "zero operator");
        operator = _operator;
        emit OperatorSet(_operator);
    }

    function setReceiveUln(address _receiveUln) external onlyOwner {
        require(_receiveUln != address(0), "zero receiveUln");
        receiveUln = _receiveUln;
        emit ReceiveUlnSet(_receiveUln);
    }

    function setFee(uint256 _fee) external onlyOwner {
        fee = _fee;
        emit FeeSet(_fee);
    }

    function withdraw(address payable _to) external onlyOwner {
        (bool ok, ) = _to.call{ value: address(this).balance }("");
        require(ok, "withdraw failed");
    }
}
