// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// CCTP v2 interfaces — real signatures from evm-cctp-contracts
// ---------------------------------------------------------------------------

/// @dev Source-chain interface: burn USDC with hook data
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
// Source-chain flow (any CCTP-supported chain → Arc):
//   1. Client approves CCTPJobFunder on the source chain for `amount` USDC.
//   2. Client calls initiateJobFunding(jobId, expectedBudget, amount, ...).
//      This burns USDC and encodes (client, jobId, expectedBudget) in hookData.
//   3. CCTP relayer mints USDC on Arc and calls handleReceiveFinalizedMessage.
//   4. This contract receives the mint, calls acp.fund(jobId, expectedBudget).
//   5. If funding fails for any reason, USDC stays in this contract and the
//      client can recover it via recoverFunds().
//
// Arc-only flow (USDC already on Arc):
//   Call fundJobDirect(jobId, expectedBudget, amount) — no CCTP needed.
// ---------------------------------------------------------------------------
contract CCTPJobFunder is IMessageHandlerV2, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20  public immutable usdc;
    IAgenticCommerce public immutable acp;

    /// @dev CCTP v2 TokenMessengerV2 on the SOURCE chain (injected; used in source-side calls)
    address public immutable tokenMessengerV2;

    /// @dev CCTP v2 MessageTransmitterV2 on Arc (only this address may call handleReceive*)
    address public immutable localMessageTransmitter;

    // Pending recoveries: client => amount not yet forwarded to ACP
    mapping(address => uint256) public pendingRecovery;

    // ── Errors ──────────────────────────────────────────────────────────────
    error OnlyMessageTransmitter();
    error ZeroAddress();
    error ZeroAmount();

    // ── Events ──────────────────────────────────────────────────────────────
    event JobFundingInitiated(uint256 indexed jobId, address indexed client, uint256 amount, uint32 destinationDomain);
    event JobFundingReceived(uint256 indexed jobId, address indexed client, uint256 amount, bool success);
    event FundsRecovered(address indexed client, uint256 amount);
    event DirectFunding(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(
        address usdc_,
        address acp_,
        address tokenMessengerV2_,
        address localMessageTransmitter_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || acp_ == address(0)) revert ZeroAddress();
        if (tokenMessengerV2_ == address(0) || localMessageTransmitter_ == address(0)) revert ZeroAddress();
        usdc                   = IERC20(usdc_);
        acp                    = IAgenticCommerce(acp_);
        tokenMessengerV2       = tokenMessengerV2_;
        localMessageTransmitter = localMessageTransmitter_;
    }

    // ── Source-chain: initiate cross-chain job funding ───────────────────────

    /// @notice Called on the SOURCE chain by the client to burn USDC and fund
    ///         a job on Arc.
    /// @param jobId            The job to fund on Arc.
    /// @param expectedBudget   Budget expected (front-run guard, matches ACP optParams).
    /// @param amount           USDC to burn (must equal expectedBudget for exact funding).
    /// @param destinationDomain Arc CCTP domain ID.
    /// @param destinationCaller bytes32(0) = any relayer can deliver.
    /// @param maxFee           CCTP relay fee cap (deducted from amount on destination).
    /// @param minFinalityThreshold 1000 = fast (≈10s); 2000 = finalized.
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
        // Pull USDC from client
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        // Approve TokenMessengerV2 to spend
        usdc.safeIncreaseAllowance(tokenMessengerV2, amount);

        // hookData encodes: (client, jobId, expectedBudget)
        bytes memory hookData = abi.encode(msg.sender, jobId, expectedBudget);

        // mintRecipient = this contract on Arc (as bytes32)
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

    /// @dev Called by the local MessageTransmitterV2 on Arc after USDC is minted.
    ///      messageBody is the BurnMessageV2 body; hookData was appended by the sender.
    ///      We decode (client, jobId, expectedBudget) from the hookData portion.
    ///
    ///      CCTP v2 BurnMessageV2 body layout (bytes):
    ///        version(4) + burnToken(32) + mintRecipient(32) + amount(32) +
    ///        messageSender(32) + maxFee(32) + hookData(dynamic)
    ///      Offset to hookData starts at byte 164.
    function handleReceiveFinalizedMessage(
        uint32  /*sourceDomain*/,
        bytes32 /*sender*/,
        uint32  /*finalityThresholdExecuted*/,
        bytes   calldata messageBody
    ) external override nonReentrant returns (bool) {
        if (msg.sender != localMessageTransmitter) revert OnlyMessageTransmitter();

        // Decode mint amount from BurnMessageV2 body (offset 68, 32 bytes)
        uint256 mintedAmount = uint256(bytes32(messageBody[68:100]));

        // Decode hookData from offset 164 onward (ABI-encoded bytes)
        bytes memory hookData = _extractHookData(messageBody);

        (address client, uint256 jobId, uint256 expectedBudget) =
            abi.decode(hookData, (address, uint256, uint256));

        // Approve ACP to pull the minted USDC
        usdc.safeIncreaseAllowance(address(acp), mintedAmount);

        // Attempt to fund the job; if it fails, credit client for recovery
        bool success;
        try acp.fund(jobId, abi.encode(expectedBudget)) {
            success = true;
        } catch {
            // Revoke the allowance we just granted (ACP didn't take it)
            usdc.safeDecreaseAllowance(address(acp), mintedAmount);
            // Credit the client for recovery
            pendingRecovery[client] += mintedAmount;
            success = false;
        }

        emit JobFundingReceived(jobId, client, mintedAmount, success);
        return true;
    }

    /// @dev IMessageHandlerV2: unfinalized messages — not used; always return true.
    function handleReceiveUnfinalizedMessage(
        uint32, bytes32, uint32, bytes calldata messageBody
    ) external override returns (bool) {
        if (msg.sender != localMessageTransmitter) revert OnlyMessageTransmitter();
        // Decode and credit for recovery — unfinalized path not intended for funding
        bytes memory hookData = _extractHookData(messageBody);
        (address client, , ) = abi.decode(hookData, (address, uint256, uint256));
        uint256 mintedAmount = uint256(bytes32(messageBody[68:100]));
        pendingRecovery[client] += mintedAmount;
        return true;
    }

    // ── Recovery ─────────────────────────────────────────────────────────────

    /// @notice Client recovers USDC that could not be forwarded to ACP.
    function recoverFunds() external nonReentrant {
        uint256 amount = pendingRecovery[msg.sender];
        require(amount > 0, "nothing to recover");
        pendingRecovery[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit FundsRecovered(msg.sender, amount);
    }

    // ── Arc-local convenience ─────────────────────────────────────────────────

    /// @notice Fund a job directly on Arc (no CCTP needed).
    ///         Useful for building the frontend funding flow on Arc itself.
    function fundJobDirect(
        uint256 jobId,
        uint256 expectedBudget,
        uint256 amount
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.safeIncreaseAllowance(address(acp), amount);
        try acp.fund(jobId, abi.encode(expectedBudget)) {
            emit DirectFunding(jobId, msg.sender, amount);
        } catch {
            usdc.safeDecreaseAllowance(address(acp), amount);
            pendingRecovery[msg.sender] += amount;
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @dev BurnMessageV2 layout:
    ///      [0:4]    version
    ///      [4:36]   burnToken
    ///      [36:68]  mintRecipient
    ///      [68:100] amount
    ///      [100:132] messageSender
    ///      [132:164] maxFee
    ///      [164:]   hookData (ABI-encoded bytes: length word + data)
    function _extractHookData(bytes calldata messageBody) internal pure returns (bytes memory) {
        require(messageBody.length > 164, "msg too short");
        // hookData is a raw ABI-encoded bytes value starting at offset 164
        return abi.decode(messageBody[164:], (bytes));
    }
}
