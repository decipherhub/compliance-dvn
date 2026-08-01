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
    address public sendUln;    // SendUln302 on this chain — the only address allowed to assign jobs
    address public receiveUln; // ReceiveUln302 on this chain
    uint256 public fee;

    event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender);
    event OperatorSet(address operator);
    event SendUlnSet(address sendUln);
    event ReceiveUlnSet(address receiveUln);
    event FeeSet(uint256 fee);

    /// @notice A held packet cleared for verification by the owner. Deliberately owner-only:
    ///         the worker holds only the operator key, so it cannot approve its own holds.
    event PacketApproved(bytes32 indexed payloadHash, address approver);

    /// @notice The risk decision behind a packet's outcome.
    /// @param payloadHash the packet this verdict is about
    /// @param action ACTION_* below
    /// @param score 0-100 risk score the action was derived from
    /// @param reasonMask bitmask of reason codes; bit assignments are append-only and
    ///        documented in the worker's `assess/verdict.ts`
    /// @param evidenceHash keccak256 of the canonical evidence document held off-chain
    event RiskVerdict(
        bytes32 indexed payloadHash,
        uint8 action,
        uint16 score,
        uint256 reasonMask,
        bytes32 evidenceHash
    );

    /// @dev Action codes. These are part of the event ABI: an indexer decoding old logs relies
    ///      on them, so the numbering is permanent. Kept in sync with the worker's ACTION_CODES.
    uint8 public constant ACTION_ALLOW = 0;
    uint8 public constant ACTION_DELAY = 1;
    uint8 public constant ACTION_MANUAL_REVIEW = 2;
    uint8 public constant ACTION_BLOCK = 3;

    error NotOperator();
    error NotSendLibrary();
    error UnknownAction(uint8 action);
    /// @dev Submitting a verification asserts the packet was allowed; any other action would be
    ///      a self-contradicting record.
    error VerificationRequiresAllow(uint8 action);
    /// @dev An allow rides along on `submitVerification`, so recording one separately would
    ///      double-report the same outcome.
    error AllowNotSeparatelyRecorded();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        address _owner,
        address _operator,
        address _sendUln,
        address _receiveUln,
        uint256 _fee
    ) Ownable(_owner) {
        require(_operator != address(0), "zero operator");
        require(_sendUln != address(0), "zero sendUln");
        require(_receiveUln != address(0), "zero receiveUln");
        operator = _operator;
        sendUln = _sendUln;
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
        // Only the send library assigns jobs. The worker treats a JobAssigned payloadHash as
        // "this packet is ours to screen" and spends operator gas verifying it, so an open
        // assignJob would let anyone point the worker at packets no one asked it to verify.
        if (msg.sender != sendUln) revert NotSendLibrary();
        // NOTE: SendUln302 calls assignJob WITHOUT forwarding value (msg.value == 0); the
        // messagelib accrues each worker's fee internally and workers withdraw separately
        // (see SendUlnBase._assignJobs). So we must NOT require msg.value >= fee here — doing
        // so reverts every real send. We simply record the job and return our fee quote.
        emit JobAssigned(_param.dstEid, _param.payloadHash, _param.confirmations, _param.sender);
        return fee;
    }

    /// @notice Attest a packet and record the risk verdict that permitted it, in one call.
    /// @dev The verdict rides along at no extra transaction cost, so an allowed packet always
    ///      carries an auditable reason for having been allowed. `action` must be ACTION_ALLOW:
    ///      a packet that was blocked or held cannot also have been verified. An owner-approved
    ///      release is reported as ACTION_ALLOW too — a human allowed it — with the reason mask
    ///      still carrying why it had been held.
    function submitVerification(
        bytes calldata packetHeader,
        bytes32 payloadHash,
        uint64 confirmations,
        uint8 action,
        uint16 score,
        uint256 reasonMask,
        bytes32 evidenceHash
    ) external onlyOperator {
        if (action != ACTION_ALLOW) revert VerificationRequiresAllow(action);
        IReceiveUlnE2(receiveUln).verify(packetHeader, payloadHash, confirmations);
        emit RiskVerdict(payloadHash, action, score, reasonMask, evidenceHash);
    }

    /// @notice Record a verdict for a packet that was NOT verified.
    /// @dev Withholding the attestation is what actually stops the packet; this only leaves the
    ///      audit trail. It is therefore best-effort by design — the worker treats a failure
    ///      here as a lost record, never as a failure to enforce.
    function recordVerdict(
        bytes32 payloadHash,
        uint8 action,
        uint16 score,
        uint256 reasonMask,
        bytes32 evidenceHash
    ) external onlyOperator {
        if (action > ACTION_BLOCK) revert UnknownAction(action);
        if (action == ACTION_ALLOW) revert AllowNotSeparatelyRecorded();
        emit RiskVerdict(payloadHash, action, score, reasonMask, evidenceHash);
    }

    /// @notice Clear a packet the worker withheld for manual review.
    /// @dev Emits only; no storage. The worker observes `PacketApproved` and releases the
    ///      packet from its local deferred queue. Approval is a human override of a risk
    ///      verdict, so it is separated from the operator key by design — a compromised or
    ///      buggy worker cannot approve the packets it chose to hold.
    function approvePacket(bytes32 payloadHash) external onlyOwner {
        emit PacketApproved(payloadHash, msg.sender);
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "zero operator");
        operator = _operator;
        emit OperatorSet(_operator);
    }

    function setSendUln(address _sendUln) external onlyOwner {
        require(_sendUln != address(0), "zero sendUln");
        sendUln = _sendUln;
        emit SendUlnSet(_sendUln);
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
