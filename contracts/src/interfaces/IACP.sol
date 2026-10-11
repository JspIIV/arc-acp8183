// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev ERC-8183 optional hook interface
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @dev Minimal read interface to AgenticCommerce used by BondHook
interface IAgenticCommerce {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string  description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }
    function getJob(uint256 jobId) external view returns (Job memory);
    function fund(uint256 jobId, bytes calldata optParams) external;
}

/// @dev CCTP v2 IMessageHandlerV2
interface IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32  finalityThresholdExecuted,
        bytes   calldata messageBody
    ) external returns (bool);

    function handleReceiveUnfinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32  finalityThresholdExecuted,
        bytes   calldata messageBody
    ) external returns (bool);
}
