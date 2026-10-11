// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ERC-8004 ReputationRegistry — real ABI from deployed registries
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

// ERC-8004 IdentityRegistry — ownerOf to look up agentId from address
interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

// ---------------------------------------------------------------------------
// BondHook — implements IACPHook
// Providers pre-stake USDC collateral. On submit, 50% of budget is locked.
// On complete: bond released, positive feedback.
// On reject:  bond sent to client, negative feedback.
// Supports sub-agent payout encoded in submit optParams.
// ---------------------------------------------------------------------------
contract BondHook is IACPHook, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20  public immutable usdc;
    IAgenticCommerce public immutable acp;
    IReputationRegistry public immutable reputationRegistry;
    IIdentityRegistry   public immutable identityRegistry;

    // BOND_RATIO: 50% of job budget must be locked (5000 / 10000)
    uint256 public constant BOND_RATIO_BPS = 5_000;
    uint256 public constant BPS_DENOM      = 10_000;

    // Free bond per provider (total staked minus locked)
    mapping(address => uint256) public bondBalance;    // total staked
    mapping(address => uint256) public bondLocked;     // locked in live jobs

    // jobId => locked bond amount
    mapping(uint256 => uint256) public jobBondLocked;
    // jobId => sub-agent payout info
    struct SubAgentOrder {
        address subAgent;
        uint256 cost;
    }
    mapping(uint256 => SubAgentOrder) public subAgentOrders;

    // AgentId lookup: provider address => ERC-8004 agentId (0 = not registered)
    mapping(address => uint256) public providerAgentId;

    // ── Errors ──────────────────────────────────────────────────────────────
    error OnlyACP();
    error InsufficientFreeBond(uint256 required, uint256 available);
    error BondLockedInLiveJob();
    error SubAgentIsProvider();
    error SubAgentCostExceedsProviderShare();
    error MissingSubAgentAllowance(address provider, uint256 required);
    error ZeroAddress();

    // ── Events ──────────────────────────────────────────────────────────────
    event BondStaked(address indexed provider, uint256 amount);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event BondLocked(address indexed provider, uint256 jobId, uint256 amount);
    event BondReleased(address indexed provider, uint256 jobId, uint256 amount);
    event BondSlashed(address indexed provider, uint256 jobId, address recipient, uint256 amount);
    event SubAgentPaid(uint256 indexed jobId, address indexed subAgent, uint256 cost);
    event AgentIdRegistered(address indexed provider, uint256 agentId);

    // ── Function selectors (from AgenticCommerce) ────────────────────────────
    bytes4 private constant SEL_SUBMIT   = bytes4(keccak256("submit(uint256,bytes,bytes)"));
    bytes4 private constant SEL_COMPLETE = bytes4(keccak256("complete(uint256,string,bytes)"));
    bytes4 private constant SEL_REJECT   = bytes4(keccak256("reject(uint256,string,bytes)"));

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

    /// @notice Provider stakes USDC as collateral.
    function stakeBond(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bondBalance[msg.sender] += amount;
        emit BondStaked(msg.sender, amount);
    }

    /// @notice Provider withdraws free bond.
    ///         Never releases bond locked against a live job.
    function withdrawBond(uint256 amount) external nonReentrant {
        uint256 free = _freeBond(msg.sender);
        if (amount > free) revert BondLockedInLiveJob();
        bondBalance[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Register your ERC-8004 agentId so reputation can be recorded.
    function registerAgentId(uint256 agentId) external {
        // Verify caller owns this agent token
        require(identityRegistry.ownerOf(agentId) == msg.sender, "Not agent owner");
        providerAgentId[msg.sender] = agentId;
        emit AgentIdRegistered(msg.sender, agentId);
    }

    // ── IACPHook ─────────────────────────────────────────────────────────────

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external
        override
        onlyACP
    {
        if (selector == SEL_SUBMIT) {
            _beforeSubmit(jobId, data);
        }
        // No before-action needed for complete/reject
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external
        override
        nonReentrant
        onlyACP
    {
        if (selector == SEL_COMPLETE) {
            _afterComplete(jobId, data);
        } else if (selector == SEL_REJECT) {
            _afterReject(jobId);
        }
    }

    // ── Internal hook logic ──────────────────────────────────────────────────

    function _beforeSubmit(uint256 jobId, bytes calldata callData) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 required = (job.budget * BOND_RATIO_BPS) / BPS_DENOM;
        uint256 free     = _freeBond(job.provider);
        if (free < required) revert InsufficientFreeBond(required, free);

        // Parse sub-agent order from optParams (last param of submit calldata)
        // submit(uint256 jobId, bytes deliverable, bytes optParams) → decode optParams
        // We receive the full calldata of the submit() call. Extract optParams:
        // selector(4) + jobId(32) + deliverable_offset(32) + optParams_offset(32)
        // + deliverable_length(32) + deliverable_data + optParams_length(32) + optParams_data
        // Simpler: decode from the end using abi.decode on stripped data.
        bytes memory optParams = _extractOptParams(callData);
        if (optParams.length > 0) {
            (address subAgent, uint256 cost) = abi.decode(optParams, (address, uint256));
            if (subAgent == job.provider) revert SubAgentIsProvider();
            // Validate cost doesn't exceed provider share
            // We don't know fee split here, so just ensure cost < budget
            // The real check happens at complete time
            subAgentOrders[jobId] = SubAgentOrder({ subAgent: subAgent, cost: cost });
        }

        // Lock bond
        bondLocked[job.provider]  += required;
        jobBondLocked[jobId]       = required;
        emit BondLocked(job.provider, jobId, required);
    }

    function _afterComplete(uint256 jobId, bytes calldata /*callData*/) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 locked = jobBondLocked[jobId];

        // Release bond
        bondLocked[job.provider] -= locked;
        jobBondLocked[jobId]      = 0;
        emit BondReleased(job.provider, jobId, locked);

        // Sub-agent payout
        SubAgentOrder memory order = subAgentOrders[jobId];
        if (order.subAgent != address(0) && order.cost > 0) {
            // cost must not exceed provider payout (budget minus fees is opaque here)
            // Enforce: cost < budget (conservative; ACP already paid provider)
            if (order.cost >= job.budget) revert SubAgentCostExceedsProviderShare();
            // Pull cost from provider (provider must have approved BondHook)
            uint256 allowance = usdc.allowance(job.provider, address(this));
            if (allowance < order.cost) revert MissingSubAgentAllowance(job.provider, order.cost);
            usdc.safeTransferFrom(job.provider, order.subAgent, order.cost);
            emit SubAgentPaid(jobId, order.subAgent, order.cost);
            delete subAgentOrders[jobId];
        }

        // Positive reputation
        _recordReputation(job.provider, jobId, int128(1));
    }

    function _afterReject(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        uint256 locked = jobBondLocked[jobId];
        if (locked == 0) return; // no bond was locked (job was Open when rejected)

        bondBalance[job.provider] -= locked;
        bondLocked[job.provider]  -= locked;
        jobBondLocked[jobId]       = 0;

        // Send slashed bond to client
        usdc.safeTransfer(job.client, locked);
        emit BondSlashed(job.provider, jobId, job.client, locked);

        // Negative reputation
        _recordReputation(job.provider, jobId, int128(-1));

        delete subAgentOrders[jobId];
    }

    // ── Reputation helper ────────────────────────────────────────────────────

    function _recordReputation(address provider, uint256 jobId, int128 score) internal {
        uint256 agentId = providerAgentId[provider];
        if (agentId == 0 || address(reputationRegistry) == address(0)) return;
        // giveFeedback with correct ERC-8004 ReputationRegistry ABI
        try reputationRegistry.giveFeedback(
            agentId,
            score,
            0,                   // valueDecimals
            "erc8183",           // tag1
            score > 0 ? "complete" : "reject",  // tag2
            "",                  // endpoint
            "",                  // feedbackURI
            bytes32(jobId)       // feedbackHash = jobId for auditability
        ) {} catch {} // best-effort; do not block settle on rep failure
    }

    // ── Pure helpers ─────────────────────────────────────────────────────────

    function _freeBond(address provider) internal view returns (uint256) {
        return bondBalance[provider] - bondLocked[provider];
    }

    /// @dev Extract optParams from submit() calldata.
    ///      submit(uint256, bytes, bytes) ABI:
    ///      [0:4]   selector
    ///      [4:36]  jobId
    ///      [36:68] offset_deliverable
    ///      [68:100] offset_optParams
    ///      Dynamic data follows. We decode the whole tail and return optParams.
    function _extractOptParams(bytes calldata data) internal pure returns (bytes memory) {
        if (data.length <= 4) return "";
        // Skip selector (4 bytes) then decode the three params
        (, , bytes memory optParams) = abi.decode(data[4:], (uint256, bytes, bytes));
        return optParams;
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function freeBond(address provider) external view returns (uint256) {
        return _freeBond(provider);
    }
}
