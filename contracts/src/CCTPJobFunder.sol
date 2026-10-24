// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// CCTP v2 interfaces
// ---------------------------------------------------------------------------

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32  destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32  minFinalityThreshold,
        bytes   calldata hookData
    ) external;
}

// ---------------------------------------------------------------------------
// CCTPJobFunder
//
// K-1 fix: calls acp.fundOnBehalfOf(jobId, client, ...) instead of acp.fund().
//          The job's recorded client is the real user; CCTPJobFunder is never
//          the client. This requires ACP to have CCTPJobFunder in trustedFunder.
//
// K-2 fix: trustedRemote allowlist — (sourceDomain, sender) pairs that are
//          permitted to trigger funding. Unrecognised sources go straight to
//          pendingRecovery without attempting to fund any job.
// ---------------------------------------------------------------------------
contract CCTPJobFunder is IMessageHandlerV2, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20  public immutable usdc;
    IAgenticCommerce public immutable acp;

    address public immutable tokenMessengerV2;
    address public immutable localMessageTransmitter;

    // K-2: (sourceDomain => (sender => trusted))
    mapping(uint32 => mapping(bytes32 => bool)) public trustedRemote;

    // Pending recoveries: client => amount
    mapping(address => uint256) public pendingRecovery;

    // ── Errors ──────────────────────────────────────────────────────────────
    error OnlyMessageTransmitter();
    error UntrustedRemote(uint32 sourceDomain, bytes32 sender);
    error ZeroAddress();
    error ZeroAmount();

    // ── Events ──────────────────────────────────────────────────────────────
    event JobFundingInitiated(uint256 indexed jobId, address indexed client, uint256 amount, uint32 destinationDomain);
    event JobFundingReceived(uint256 indexed jobId, address indexed client, uint256 amount, bool success);
    event FundsRecovered(address indexed client, uint256 amount);
    event DirectFunding(uint256 indexed jobId, address indexed client, uint256 amount);
    event TrustedRemoteSet(uint32 indexed sourceDomain, bytes32 indexed sender, bool trusted);

    constructor(
        address usdc_,
        address acp_,
        address tokenMessengerV2_,
        address localMessageTransmitter_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || acp_ == address(0)) revert ZeroAddress();
        if (tokenMessengerV2_ == address(0) || localMessageTransmitter_ == address(0)) revert ZeroAddress();
        usdc                    = IERC20(usdc_);
        acp                     = IAgenticCommerce(acp_);
        tokenMessengerV2        = tokenMessengerV2_;
        localMessageTransmitter = localMessageTransmitter_;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice K-2: register a (sourceDomain, senderBytes32) pair as trusted.
    ///         sender should be the remote CCTPJobFunder cast to bytes32.
    function setTrustedRemote(uint32 sourceDomain, bytes32 sender, bool trusted) external onlyOwner {
        trustedRemote[sourceDomain][sender] = trusted;
        emit TrustedRemoteSet(sourceDomain, sender, trusted);
    }

    // ── Source-chain: initiate cross-chain job funding ───────────────────────

    function initiateJobFunding(
        uint256 jobId,
        uint256 expectedBudget,
        uint256 amount,
        uint32  destinationDomain,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32  minFinalityThreshold
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.safeIncreaseAllowance(tokenMessengerV2, amount);

        // hookData encodes: (client, jobId, expectedBudget)
        bytes memory hookData = abi.encode(msg.sender, jobId, expectedBudget);
        bytes32 mintRecipient = bytes32(uint256(uint160(address(this))));

        ITokenMessengerV2(tokenMessengerV2).depositForBurnWithHook(
            amount,
            destinationDomain,
            mintRecipient,
            address(usdc),
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );

        emit JobFundingInitiated(jobId, msg.sender, amount, destinationDomain);
    }

    // ── Arc destination: receive CCTP v2 minted USDC ────────────────────────

    function handleReceiveFinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32  /*finalityThresholdExecuted*/,
        bytes   calldata messageBody
    ) external override nonReentrant returns (bool) {
        if (msg.sender != localMessageTransmitter) revert OnlyMessageTransmitter();

        // K-2: reject messages from unknown sources immediately
        if (!trustedRemote[sourceDomain][sender]) {
            revert UntrustedRemote(sourceDomain, sender);
        }

        uint256 mintedAmount = uint256(bytes32(messageBody[68:100]));
        bytes memory hookData = _extractHookData(messageBody);
        (address client, uint256 jobId, uint256 expectedBudget) =
            abi.decode(hookData, (address, uint256, uint256));

        // Approve ACP to pull minted USDC
        usdc.safeIncreaseAllowance(address(acp), mintedAmount);

        // K-1: fund on behalf of the real client
        bool success;
        try acp.fundOnBehalfOf(jobId, client, abi.encode(expectedBudget)) {
            success = true;
        } catch {
            usdc.safeDecreaseAllowance(address(acp), mintedAmount);
            pendingRecovery[client] += mintedAmount;
            success = false;
        }

        emit JobFundingReceived(jobId, client, mintedAmount, success);
        return true;
    }

    function handleReceiveUnfinalizedMessage(
        uint32  sourceDomain,
        bytes32 sender,
        uint32,
        bytes calldata messageBody
    ) external override returns (bool) {
        if (msg.sender != localMessageTransmitter) revert OnlyMessageTransmitter();

        // K-2: reject unknown sources
        if (!trustedRemote[sourceDomain][sender]) {
            revert UntrustedRemote(sourceDomain, sender);
        }

        bytes memory hookData = _extractHookData(messageBody);
        (address client, , ) = abi.decode(hookData, (address, uint256, uint256));
        uint256 mintedAmount = uint256(bytes32(messageBody[68:100]));
        pendingRecovery[client] += mintedAmount;
        return true;
    }

    // ── Recovery ─────────────────────────────────────────────────────────────

    function recoverFunds() external nonReentrant {
        uint256 amount = pendingRecovery[msg.sender];
        require(amount > 0, "nothing to recover");
        pendingRecovery[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit FundsRecovered(msg.sender, amount);
    }

    // ── Arc-local convenience ─────────────────────────────────────────────────

    /// @notice Fund a job directly on Arc (no CCTP needed).
    ///         K-1: uses fundOnBehalfOf — this contract must be in ACP trustedFunder.
    function fundJobDirect(
        uint256 jobId,
        uint256 expectedBudget,
        uint256 amount
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.safeIncreaseAllowance(address(acp), amount);
        try acp.fundOnBehalfOf(jobId, msg.sender, abi.encode(expectedBudget)) {
            emit DirectFunding(jobId, msg.sender, amount);
        } catch {
            usdc.safeDecreaseAllowance(address(acp), amount);
            pendingRecovery[msg.sender] += amount;
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @dev BurnMessageV2 layout: [0:4] version, [4:36] burnToken, [36:68] mintRecipient,
    ///      [68:100] amount, [100:132] messageSender, [132:164] maxFee, [164:] hookData
    function _extractHookData(bytes calldata messageBody) internal pure returns (bytes memory) {
        require(messageBody.length > 164, "msg too short");
        return abi.decode(messageBody[164:], (bytes));
    }
}
