// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// CCTPJobFunderV2: fund an ERC-8183 job from another chain with CCTP V2.
//
// WHY THIS REPLACES CCTPJobFunder (v1)
//   v1 assumed the CCTP core would call back into this contract after minting.
//   It does not: CCTP V2 carries `hookData` but never executes it. v1 also read
//   the hook data from the wrong offset. Circle's technical guide documents the
//   real layout, which is what this contract implements.
//
// FLOW
//   Source chain : initiateJobFunding() burns USDC through TokenMessengerV2 with
//                  mintRecipient = destinationCaller = the registered counterpart
//                  funder on the destination chain, and hookData = (jobId,
//                  expectedBudget, destinationClient).
//   Destination  : anyone relays (message, attestation) to redeemAndFund(). Only
//                  this contract may call MessageTransmitterV2.receiveMessage for
//                  the message (destinationCaller), so redeem + fund happen
//                  atomically. Every field is validated against owner-registered
//                  remotes BEFORE the message is redeemed.
//
// MONEY SAFETY
//   - The amount credited is the measured USDC balance delta, never the number in
//     the message. Fast-transfer fees (feeExecuted) are therefore handled.
//   - ACP pulls exactly job.budget. Anything else (fee shortfall, surplus, failed
//     funding) is credited to pendingRecovery[destinationClient], pulled with
//     recoverFunds(). No path pushes USDC to a third party.
//   - destinationClient is chosen explicitly by the sender and bound into the
//     attested message. It must be an address you control on the destination.
//
// MESSAGE LAYOUT (Circle CCTP technical guide)
//   Header : version 0 | sourceDomain 4 | destinationDomain 8 | nonce 12 |
//            sender 44 | recipient 76 | destinationCaller 108 |
//            minFinalityThreshold 140 | finalityThresholdExecuted 144 | body 148
//   Burn body (BurnMessageV2) : version 0 | burnToken 4 | mintRecipient 36 |
//            amount 68 | messageSender 100 | maxFee 132 | feeExecuted 164 |
//            expirationBlock 196 | hookData 228
// ---------------------------------------------------------------------------

interface ITokenMessengerV2Min {
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

interface IMessageTransmitterV2Min {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}

contract CCTPJobFunderV2 is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Layout constants ─────────────────────────────────────────────────────
    uint256 private constant HEADER_LEN        = 148;
    uint256 private constant BODY_HOOK_OFFSET  = 228;
    uint256 private constant HOOK_DATA_LEN     = 96;   // abi.encode(uint256, uint256, address)
    uint256 private constant MIN_MESSAGE_LEN   = HEADER_LEN + BODY_HOOK_OFFSET + HOOK_DATA_LEN;
    uint256 private constant MIN_FUND_GAS      = 500_000;

    // ── Immutables ───────────────────────────────────────────────────────────
    IERC20  public immutable usdc;
    /// @dev address(0) on source-only deployments (no ACP on that chain).
    IAgenticCommerce public immutable acp;
    address public immutable tokenMessengerV2;
    address public immutable messageTransmitterV2;

    // ── Remotes: counterpart on another CCTP domain ──────────────────────────
    struct Remote {
        bytes32 tokenMessenger;  // TokenMessengerV2 on that domain (header.sender of burn messages)
        bytes32 funder;          // CCTPJobFunderV2 on that domain (burn body messageSender / our mintRecipient)
    }
    mapping(uint32 => Remote) public remotes;

    /// @notice Stops NEW burns toward a domain without affecting redemption of burns already
    ///         in flight. Prefer this over clearing a remote: clearing a remote makes every
    ///         outstanding message from that domain unredeemable.
    mapping(uint32 => bool) public sendDisabled;

    // ── Recovery accounting ──────────────────────────────────────────────────
    mapping(address => uint256) public pendingRecovery;
    uint256 public totalPending;

    // ── Errors ───────────────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error NoAcpOnThisChain();
    error RemoteNotSet(uint32 domain);
    error MessageTooShort();
    error WrongRecipient();
    error WrongDestinationCaller();
    error WrongMintRecipient();
    error UntrustedMessenger(uint32 sourceDomain, bytes32 sender);
    error UntrustedBurner(uint32 sourceDomain, bytes32 messageSender);
    error BadHookData();
    error RedeemFailed();
    error NothingMinted();
    error NothingToRecover();
    error InsufficientGas();
    error InsufficientRecovery();
    error SendDisabled(uint32 domain);
    error RenounceDisabled();

    // ── Events ───────────────────────────────────────────────────────────────
    event RemoteSet(uint32 indexed domain, bytes32 tokenMessenger, bytes32 funder);
    event JobFundingInitiated(uint256 indexed jobId, address indexed sender, address indexed destinationClient, uint256 amount, uint32 destinationDomain);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 budget, uint256 minted);
    event FundingFailed(uint256 indexed jobId, address indexed client, uint256 minted);
    event RecoveryCredited(address indexed client, uint256 amount);
    event FundsRecovered(address indexed client, uint256 amount);
    event StrayRescued(address indexed to, uint256 amount);
    event SendDisabledSet(uint32 indexed domain, bool disabled);
    event RecoveryFunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(
        address usdc_,
        address acp_,
        address tokenMessengerV2_,
        address messageTransmitterV2_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || tokenMessengerV2_ == address(0) || messageTransmitterV2_ == address(0)) {
            revert ZeroAddress();
        }
        usdc                 = IERC20(usdc_);
        acp                  = IAgenticCommerce(acp_);
        tokenMessengerV2     = tokenMessengerV2_;
        messageTransmitterV2 = messageTransmitterV2_;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Register the counterpart for a CCTP domain. A zero `funder` disables the domain.
    function setRemote(uint32 domain, bytes32 tokenMessenger, bytes32 funder) external onlyOwner {
        remotes[domain] = Remote(tokenMessenger, funder);
        emit RemoteSet(domain, tokenMessenger, funder);
    }

    function setSendDisabled(uint32 domain, bool disabled) external onlyOwner {
        sendDisabled[domain] = disabled;
        emit SendDisabledSet(domain, disabled);
    }

    /// @dev Renouncing would freeze remote configuration for good and could strand messages
    ///      that are already in flight, so it is disabled.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Move USDC that nobody can claim (for example a stray mint to this address)
    ///         to `to`. Never touches balances owed through pendingRecovery.
    function rescueStray(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = usdc.balanceOf(address(this));
        uint256 stray = bal > totalPending ? bal - totalPending : 0;
        if (stray == 0) revert NothingToRecover();
        usdc.safeTransfer(to, stray);
        emit StrayRescued(to, stray);
    }

    // ── Source chain ─────────────────────────────────────────────────────────

    /// @param jobId             Job on the destination chain's ACP.
    /// @param expectedBudget    Budget the sender expects; ACP reverts the funding if it moved.
    /// @param amount            USDC to burn. Must cover the budget plus any fast-transfer fee.
    /// @param destinationDomain CCTP domain of the chain that hosts the ACP.
    /// @param destinationClient The job's client on the destination chain. Also the recovery
    ///                          account if funding fails. Must be an address you control there.
    function initiateJobFunding(
        uint256 jobId,
        uint256 expectedBudget,
        uint256 amount,
        uint32  destinationDomain,
        address destinationClient,
        uint256 maxFee,
        uint32  minFinalityThreshold
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (destinationClient == address(0)) revert ZeroAddress();
        if (sendDisabled[destinationDomain]) revert SendDisabled(destinationDomain);
        bytes32 remoteFunder = remotes[destinationDomain].funder;
        if (remoteFunder == bytes32(0)) revert RemoteNotSet(destinationDomain);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _burn(
            amount, destinationDomain, remoteFunder, maxFee, minFinalityThreshold,
            abi.encode(jobId, expectedBudget, destinationClient)
        );
        emit JobFundingInitiated(jobId, msg.sender, destinationClient, amount, destinationDomain);
    }

    /// @dev mintRecipient and destinationCaller are both the remote funder: tokens can only
    ///      be minted to it, and only it can redeem the message, so redeem + fund is atomic.
    function _burn(
        uint256 amount,
        uint32  destinationDomain,
        bytes32 remoteFunder,
        uint256 maxFee,
        uint32  minFinalityThreshold,
        bytes memory hookData
    ) private {
        usdc.forceApprove(tokenMessengerV2, amount);
        ITokenMessengerV2Min(tokenMessengerV2).depositForBurnWithHook(
            amount, destinationDomain, remoteFunder, address(usdc), remoteFunder,
            maxFee, minFinalityThreshold, hookData
        );
        usdc.forceApprove(tokenMessengerV2, 0);
    }

    // ── Destination chain ────────────────────────────────────────────────────

    /// @notice Permissionless relay entry point. Validates the message against the registered
    ///         remote, redeems it, and funds the job with what was actually minted.
    function redeemAndFund(bytes calldata message, bytes calldata attestation) external nonReentrant {
        if (address(acp) == address(0)) revert NoAcpOnThisChain();
        if (message.length < MIN_MESSAGE_LEN) revert MessageTooShort();

        (uint256 jobId, uint256 expectedBudget, address client) = _validate(message);

        // Redeem: the mint lands here in the same transaction.
        uint256 balBefore = usdc.balanceOf(address(this));
        if (!IMessageTransmitterV2Min(messageTransmitterV2).receiveMessage(message, attestation)) {
            revert RedeemFailed();
        }
        uint256 minted = usdc.balanceOf(address(this)) - balBefore;
        if (minted == 0) revert NothingMinted();

        // Fund: ACP pulls exactly job.budget, everything else is recoverable.
        uint256 spent = _fund(jobId, expectedBudget, client, minted);
        if (spent > 0) emit JobFunded(jobId, client, spent, minted);

        uint256 leftover = minted - spent;
        if (leftover > 0) {
            pendingRecovery[client] += leftover;
            totalPending += leftover;
            emit RecoveryCredited(client, leftover);
        }
    }

    /// @dev Every check is against fields covered by the attestation. Runs BEFORE redeeming.
    function _validate(bytes calldata message)
        private
        view
        returns (uint256 jobId, uint256 expectedBudget, address client)
    {
        uint32 sourceDomain = uint32(bytes4(message[4:8]));
        Remote memory remote = remotes[sourceDomain];
        if (remote.funder == bytes32(0)) revert RemoteNotSet(sourceDomain);

        bytes32 headerSender = bytes32(message[44:76]);
        if (headerSender != remote.tokenMessenger) revert UntrustedMessenger(sourceDomain, headerSender);
        if (bytes32(message[76:108]) != _toBytes32(tokenMessengerV2)) revert WrongRecipient();
        if (bytes32(message[108:140]) != _toBytes32(address(this))) revert WrongDestinationCaller();

        bytes calldata body = message[HEADER_LEN:];
        if (bytes32(body[36:68]) != _toBytes32(address(this))) revert WrongMintRecipient();
        bytes32 burner = bytes32(body[100:132]);
        if (burner != remote.funder) revert UntrustedBurner(sourceDomain, burner);

        bytes calldata hookData = body[BODY_HOOK_OFFSET:];
        if (hookData.length != HOOK_DATA_LEN) revert BadHookData();
        (jobId, expectedBudget, client) = abi.decode(hookData, (uint256, uint256, address));
        if (client == address(0)) revert BadHookData();
    }

    /// @dev Returns the USDC that ACP actually pulled (0 when funding was skipped or failed).
    function _fund(uint256 jobId, uint256 expectedBudget, address client, uint256 minted)
        private
        returns (uint256 spent)
    {
        uint256 budget = acp.getJob(jobId).budget;
        if (budget == 0 || budget > minted) {
            emit FundingFailed(jobId, client, minted);
            return 0;
        }

        // A relayer controls the gas limit. Without this guard they could starve the
        // funding call, push the funds into recovery and grief the client. Reverting
        // here also undoes the redeem, so the message can simply be relayed again.
        if (gasleft() < MIN_FUND_GAS) revert InsufficientGas();

        uint256 balPreFund = usdc.balanceOf(address(this));
        usdc.forceApprove(address(acp), budget);
        try acp.fundOnBehalfOf(jobId, client, abi.encode(expectedBudget)) {
            // pulled amount is measured below
        } catch {
            emit FundingFailed(jobId, client, minted);
        }
        usdc.forceApprove(address(acp), 0);
        spent = balPreFund - usdc.balanceOf(address(this));
    }

    // ── Recovery (pull) ──────────────────────────────────────────────────────

    /// @notice Use your own recovered balance to fund a job after a failed or starved funding
    ///         attempt (wrong budget, relayer gas, job not ready yet). Reverts if funding fails.
    function fundFromRecovery(uint256 jobId, uint256 expectedBudget) external nonReentrant {
        if (address(acp) == address(0)) revert NoAcpOnThisChain();
        uint256 budget = acp.getJob(jobId).budget;
        if (budget == 0 || budget > pendingRecovery[msg.sender]) revert InsufficientRecovery();

        uint256 balPre = usdc.balanceOf(address(this));
        usdc.forceApprove(address(acp), budget);
        acp.fundOnBehalfOf(jobId, msg.sender, abi.encode(expectedBudget));
        usdc.forceApprove(address(acp), 0);

        uint256 spent = balPre - usdc.balanceOf(address(this));
        pendingRecovery[msg.sender] -= spent;
        totalPending -= spent;
        emit RecoveryFunded(jobId, msg.sender, spent);
    }

    function recoverFunds() external nonReentrant {
        uint256 amount = pendingRecovery[msg.sender];
        if (amount == 0) revert NothingToRecover();
        pendingRecovery[msg.sender] = 0;
        totalPending -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit FundsRecovered(msg.sender, amount);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _toBytes32(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
