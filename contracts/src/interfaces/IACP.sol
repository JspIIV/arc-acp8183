// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ---------------------------------------------------------------------------
// ERC-8183 shared types and interfaces
// ---------------------------------------------------------------------------

interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata optParams) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata optParams) external;
}

interface IAgenticCommerce {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        uint256   id;
        address   client;
        address   provider;
        address   evaluator;
        string    description;
        uint256   budget;
        uint256   expiredAt;
        JobStatus status;
        address   hook;
    }

    function getJob(uint256 jobId) external view returns (Job memory);

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string  calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external;
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
}

// CCTP v2 MessageTransmitter interface (IMessageHandlerV2)
interface IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32  finality,
        bytes   calldata messageBody
    ) external returns (bool success);

    function handleReceiveUnfinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32  finality,
        bytes   calldata messageBody
    ) external returns (bool success);
}
