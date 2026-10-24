// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ERC-8004 ReputationRegistry
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128  value,
        uint8   valueDecimals,
        string  calldata tag1,
        string  calldata tag2,
        string  calldata endpoint,
        string  calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

// ERC-8004 IdentityRegistry
interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

// ---------------------------------------------------------------------------
// BondHook — IACPHook extension for bonding, sub-agent payout, ERC-8004 rep
//
// Changes in this revision:
//   Step 1: releaseExpiredBond(jobId) — escape hatch when a job expires after
//           submit and claimRefund already ran (no hook called by claimRefund).
//   Step 3: beforeAction / afterAction both receive optParams (not msg.data).
//           _extractOptParams removed; submit sub-agent decoded directly.
//   Step 4: sub-agent payout is best-effort — provider cannot block completion
//           by withholding allowance.
// ---------------------------------------------------------------------------
contract BondHook is IACPHook, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20  public immutable usdc;
    IAgenticCommerce public immutable acp;
    IReputationRegistry public immutable reputationRegistry;
    IIdentityRegistry   public immutable identityRegistry;

    uint256 public constant BOND_RATIO_BPS = 5_000;   // 50% of budget
    uint256 public constant BPS_DENOM      = 10_000;

    mapping(address => uint256) public bondBalance;    // total staked
    mapping(address => uint256) public bondLocked;     // locked in live jobs

    mapping(uint256 => uint256) public jobBondLocked;  // jobId → locked amount

    // Pull-payment for slashed bonds (Step 3: push→pull for slash payout)
    // Slashed bond is credited here; client calls withdrawSlash() to receive.
    mapping(address => uint256) private _slashOwed;

    struct SubAgentOrder {
        address subAgent;
        uint256 cost;
    }
    mapping(uint256 => SubAgentOrder) public subAgentOrders;

    mapping(address => uint256) public providerAgentId;

    // ── Errors ──────────────────────────────────────────────────────────────
    error OnlyACP();
    error InsufficientFreeBond(uint256 required, uint256 available);
    error BondLockedInLiveJob();
    error SubAgentIsProvider();
    error SubAgentCostExceedsProviderShare();
    error ZeroAddress();
    error JobNotSettled();       // Step 1: job must be Expired or Rejected
    error NoBondLocked();        // Step 1: nothing to release
    error NothingToWithdraw();   // Step 3: no slash credit

    /// @dev Minimum gas that must remain before attempting a reputation write.
    ///      Below this threshold the call is skipped entirely and ReputationSkipped is emitted.
    ///      Measured on mainnet: giveFeedback costs ~170k; 250k leaves margin.
    uint256 public constant MIN_REPUTATION_GAS   = 250_000;
    /// @dev Minimum gas that must remain before attempting a sub-agent transferFrom.
    uint256 public constant MIN_SUB_AGENT_GAS     = 80_000;

    // ── Events ──────────────────────────────────────────────────────────────
    event BondStaked(address indexed provider, uint256 amount);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event BondLocked(address indexed provider, uint256 jobId, uint256 amount);
    event BondReleased(address indexed provider, uint256 jobId, uint256 amount);
    event BondSlashed(address indexed provider, uint256 jobId, address recipient, uint256 amount);
    // Step 3: slash credited to recipient pull balance
    event BondSlashCredited(address indexed recipient, uint256 indexed jobId, uint256 amount);
    event BondSlashWithdrawn(address indexed recipient, uint256 amount);
    event BondReleasedOnExpiry(address indexed provider, uint256 jobId, uint256 amount);
    event SubAgentPaid(uint256 indexed jobId, address indexed subAgent, uint256 cost);
    event SubAgentPayoutSkipped(uint256 indexed jobId, address indexed subAgent, uint256 cost);
    event AgentIdRegistered(address indexed provider, uint256 agentId);
    // Step 1: reputation observability events
    event ReputationSkipped(address indexed provider, uint256 indexed jobId, string reason);
    event ReputationFailed(address indexed provider, uint256 indexed jobId);

    // ── Function selectors ──────────────────────────────────────────────────
    // submit(uint256,bytes32,bytes)
    bytes4 private constant SEL_SUBMIT   = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    // complete(uint256,bytes32,bytes)
    bytes4 private constant SEL_COMPLETE = bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    // reject(uint256,bytes32,bytes)
    bytes4 private constant SEL_REJECT   = bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    modifier onlyACP() {
        if (msg.sender != address(acp)) revert OnlyACP();
        _;
    }

    constructor(
        address usdc_,
        address acp_,
        address reputationRegistry_,
        address identityRegistry_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || acp_ == address(0)) revert ZeroAddress();
        usdc               = IERC20(usdc_);
        acp                = IAgenticCommerce(acp_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        identityRegistry   = IIdentityRegistry(identityRegistry_);
    }

    // ── Bond management ──────────────────────────────────────────────────────

    function stakeBond(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bondBalance[msg.sender] += amount;
        emit BondStaked(msg.sender, amount);
    }

    function withdrawBond(uint256 amount) external nonReentrant {
        uint256 free = _freeBond(msg.sender);
        if (amount > free) revert BondLockedInLiveJob();
        bondBalance[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Step 3: Pull slashed bond credited to msg.sender.
    ///         Prevents USDC blocklist from bricking slash settlement.
    function withdrawSlash() external nonReentrant {
        uint256 amount = _slashOwed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        _slashOwed[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit BondSlashWithdrawn(msg.sender, amount);
    }

    /// @notice View pending slash balance for an address.
    function slashOwed(address recipient) external view returns (uint256) {
        return _slashOwed[recipient];
    }

    /// @notice Step 1 — release a bond locked against a job that has expired or been rejected.
    ///         callable by anyone; no access control needed.
    ///         Does NOT slash — the provider did the work; the client already got the escrow back.
    function releaseExpiredBond(uint256 jobId) external nonReentrant {
        uint256 locked = jobBondLocked[jobId];
        if (locked == 0) revert NoBondLocked();

        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        // Only release for terminal non-completion states
        if (
            job.status != IAgenticCommerce.JobStatus.Expired &&
            job.status != IAgenticCommerce.JobStatus.Rejected
        ) revert JobNotSettled();

        address provider = job.provider;

        // Release the lock — restore to free bond
        bondLocked[provider]  -= locked;
        jobBondLocked[jobId]   = 0;

        // Clear sub-agent order
        delete subAgentOrders[jobId];

        emit BondReleasedOnExpiry(provider, jobId, locked);
    }

    function registerAgentId(uint256 agentId) external {
        require(identityRegistry.ownerOf(agentId) == msg.sender, "Not agent owner");
        providerAgentId[msg.sender] = agentId;
        emit AgentIdRegistered(msg.sender, agentId);
    }

    // ── IACPHook ─────────────────────────────────────────────────────────────

    /// Step 3: optParams passed directly — no msg.data parsing
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata optParams)
        external
        override
        onlyACP
    {
        if (selector == SEL_SUBMIT) {
            _beforeSubmit(jobId, optParams);
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata optParams)
        external
        override
        nonReentrant
        onlyACP
    {
        if (selector == SEL_COMPLETE) {
            _afterComplete(jobId);
        } else if (selector == SEL_REJECT) {
            _afterReject(jobId);
        }
        // optParams unused in after hooks for now; kept for future extensions
        (optParams);
    }

    // ── Internal hook logic ──────────────────────────────────────────────────

    /// Step 3: decode sub-agent directly from optParams
    function _beforeSubmit(uint256 jobId, bytes calldata optParams) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 required = (job.budget * BOND_RATIO_BPS) / BPS_DENOM;
        uint256 free     = _freeBond(job.provider);
        if (free < required) revert InsufficientFreeBond(required, free);

        if (optParams.length > 0) {
            // optParams format: (address subAgent, uint256 cost, string uri)
            // uri is ignored here — AgenticCommerce.submit reads it for the event.
            (address subAgent, uint256 cost,) = abi.decode(optParams, (address, uint256, string));
            if (subAgent == job.provider) revert SubAgentIsProvider();

            // M-3: cap sub-agent cost against provider's NET share (budget minus fees),
            // not raw budget. Prevents provider from committing to pay a sub-agent
            // more than they will actually receive from the ACP escrow.
            (,, uint256 providerNetShare) = acp.feeSplit(job.budget);
            if (cost >= providerNetShare) revert SubAgentCostExceedsProviderShare();

            subAgentOrders[jobId] = SubAgentOrder({ subAgent: subAgent, cost: cost });
        }

        bondLocked[job.provider] += required;
        jobBondLocked[jobId]      = required;
        emit BondLocked(job.provider, jobId, required);
    }

    function _afterComplete(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 locked = jobBondLocked[jobId];

        // Release bond
        bondLocked[job.provider] -= locked;
        jobBondLocked[jobId]      = 0;
        emit BondReleased(job.provider, jobId, locked);

        // Step 2: sub-agent payout is best-effort — gas guard ensures skip is always recorded
        SubAgentOrder memory order = subAgentOrders[jobId];
        if (order.subAgent != address(0) && order.cost > 0) {
            if (gasleft() < MIN_SUB_AGENT_GAS) {
                emit SubAgentPayoutSkipped(jobId, order.subAgent, order.cost);
            } else {
                uint256 allowance = usdc.allowance(job.provider, address(this));
                if (allowance >= order.cost) {
                    try usdc.transferFrom(job.provider, order.subAgent, order.cost) returns (bool ok) {
                        if (ok) {
                            emit SubAgentPaid(jobId, order.subAgent, order.cost);
                        } else {
                            emit SubAgentPayoutSkipped(jobId, order.subAgent, order.cost);
                        }
                    } catch {
                        emit SubAgentPayoutSkipped(jobId, order.subAgent, order.cost);
                    }
                } else {
                    emit SubAgentPayoutSkipped(jobId, order.subAgent, order.cost);
                }
            }
            delete subAgentOrders[jobId];
        }

        // Positive reputation (best-effort, with gas guard — Step 1)
        _recordReputation(job.provider, jobId, int128(1));
    }

    function _afterReject(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 locked = jobBondLocked[jobId];
        if (locked == 0) return;

        bondBalance[job.provider] -= locked;
        bondLocked[job.provider]  -= locked;
        jobBondLocked[jobId]       = 0;

        // Step 3: push → pull. Credit slash to client's _slashOwed instead of
        // direct safeTransfer. This prevents a blocklisted client from making
        // _afterReject (and therefore reject()) revert forever.
        _slashOwed[job.client] += locked;
        emit BondSlashed(job.provider, jobId, job.client, locked);
        emit BondSlashCredited(job.client, jobId, locked);

        _recordReputation(job.provider, jobId, int128(-1));
        delete subAgentOrders[jobId];
    }

    // ── Reputation ───────────────────────────────────────────────────────────

    /// @dev Step 1: reputation write with gas guard + observability events.
    ///      If gasleft() < MIN_REPUTATION_GAS, skip the call and emit ReputationSkipped
    ///      so the failure is visible on-chain. This prevents burning ~170k gas on a
    ///      registry call that cannot succeed (mainnet tx 0xac1482c7…).
    ///      Settlement never reverts because of reputation — the guard and catch are both
    ///      present so failure is always observable but never fatal.
    function _recordReputation(address provider, uint256 jobId, int128 score) internal {
        uint256 agentId = providerAgentId[provider];
        if (agentId == 0 || address(reputationRegistry) == address(0)) return;

        // Step 1: guard — skip if not enough gas to run the registry call
        if (gasleft() < MIN_REPUTATION_GAS) {
            emit ReputationSkipped(provider, jobId, "insufficient gas");
            return;
        }

        try reputationRegistry.giveFeedback(
            agentId, score, 0,
            "erc8183",
            score > 0 ? "complete" : "reject",
            "", "",
            bytes32(jobId)
        ) {
            // success — no extra event needed; the registry emits its own
        } catch {
            // Step 1: catch emits ReputationFailed instead of swallowing silently
            emit ReputationFailed(provider, jobId);
        }
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function freeBond(address provider) external view returns (uint256) {
        return _freeBond(provider);
    }

    function _freeBond(address provider) internal view returns (uint256) {
        return bondBalance[provider] - bondLocked[provider];
    }
}
