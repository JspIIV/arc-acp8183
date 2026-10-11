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

    // ── Events ──────────────────────────────────────────────────────────────
    event BondStaked(address indexed provider, uint256 amount);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event BondLocked(address indexed provider, uint256 jobId, uint256 amount);
    event BondReleased(address indexed provider, uint256 jobId, uint256 amount);
    event BondSlashed(address indexed provider, uint256 jobId, address recipient, uint256 amount);
    event BondReleasedOnExpiry(address indexed provider, uint256 jobId, uint256 amount); // Step 1
    event SubAgentPaid(uint256 indexed jobId, address indexed subAgent, uint256 cost);
    event SubAgentPayoutSkipped(uint256 indexed jobId, address indexed subAgent, uint256 cost); // Step 4
    event AgentIdRegistered(address indexed provider, uint256 agentId);

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
            (address subAgent, uint256 cost) = abi.decode(optParams, (address, uint256));
            if (subAgent == job.provider) revert SubAgentIsProvider();
            if (cost >= job.budget) revert SubAgentCostExceedsProviderShare();
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

        // Step 4: sub-agent payout is best-effort — never blocks completion
        SubAgentOrder memory order = subAgentOrders[jobId];
        if (order.subAgent != address(0) && order.cost > 0) {
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
            delete subAgentOrders[jobId];
        }

        // Positive reputation (best-effort)
        _recordReputation(job.provider, jobId, int128(1));
    }

    function _afterReject(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 locked = jobBondLocked[jobId];
        if (locked == 0) return;

        bondBalance[job.provider] -= locked;
        bondLocked[job.provider]  -= locked;
        jobBondLocked[jobId]       = 0;

        usdc.safeTransfer(job.client, locked);
        emit BondSlashed(job.provider, jobId, job.client, locked);

        _recordReputation(job.provider, jobId, int128(-1));
        delete subAgentOrders[jobId];
    }

    // ── Reputation ───────────────────────────────────────────────────────────

    function _recordReputation(address provider, uint256 jobId, int128 score) internal {
        uint256 agentId = providerAgentId[provider];
        if (agentId == 0 || address(reputationRegistry) == address(0)) return;
        try reputationRegistry.giveFeedback(
            agentId, score, 0,
            "erc8183",
            score > 0 ? "complete" : "reject",
            "", "",
            bytes32(jobId)
        ) {} catch {}
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function freeBond(address provider) external view returns (uint256) {
        return _freeBond(provider);
    }

    function _freeBond(address provider) internal view returns (uint256) {
        return bondBalance[provider] - bondLocked[provider];
    }
}
