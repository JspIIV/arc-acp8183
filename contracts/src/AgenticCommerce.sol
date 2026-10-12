// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// AgenticCommerce — faithful ERC-8183 implementation
//
// Spec:  https://eips.ethereum.org/EIPS/eip-8183
// Ref:   0x0747EEf0706327138c69792bF28Cd525089e4583 (Arc Testnet)
//
// Changes vs first draft aligned to the reference implementation:
//   • submit: bytes32 deliverable  (spec §submit)
//   • complete/reject: bytes32 reason  (spec §complete, §reject)
//   • setPlatformFee(feeBP_, treasury_) two-arg  (spec §fees, ref impl)
//   • setBudget: provider-only  (ref impl — client+provider allowed by spec
//     but reference restricts to provider; we match the reference)
//   • Events: JobFunded(jobId, client, amount), JobSubmitted(jobId, provider, deliverable),
//             JobCompleted(jobId, evaluator, reason), JobRejected(jobId, rejector, reason)
//   • Step 3: hooks receive optParams, not msg.data
//   • Step 5: combined fee cap 20%, dead _isEscrowed removed, initialize cleaned up
// ---------------------------------------------------------------------------
contract AgenticCommerce is IAgenticCommerce, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Storage ──────────────────────────────────────────────────────────────
    IERC20  public immutable paymentToken;
    address public           treasury;

    uint256 public platformFeeBps;    // platform fee in basis points
    uint256 public evaluatorFeeBps;   // evaluator fee in basis points

    uint256 public constant BPS_DENOM     = 10_000;
    uint256 public constant MAX_FEE_BPS   = 2_000;  // Step 5: combined cap 20%

    mapping(uint256 => Job) private _jobs;
    uint256 public jobCount;

    mapping(address => bool) public hookWhitelist;

    // ── Errors ───────────────────────────────────────────────────────────────
    error WrongStatus(JobStatus expected, JobStatus actual);
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error ProviderNotSet();
    error ProviderAlreadySet();
    error BudgetZero();
    error BudgetMoved(uint256 expected, uint256 actual);
    error InvalidExpiry();
    error NotExpiredYet();
    error JobExpiredAlready();
    error HookNotWhitelisted(address hook);
    error ZeroAddress();
    error FeesTooHigh();

    // ── Events (ERC-8183 §Events — matched to reference implementation) ──────
    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool allowed);
    event TreasurySet(address treasury);
    event PlatformFeeSet(uint256 bps);
    event EvaluatorFeeSet(uint256 bps);

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address paymentToken_, address treasury_) Ownable(msg.sender) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        paymentToken = IERC20(paymentToken_);
        treasury     = treasury_;
        // address(0) hook is always allowed (no-hook path)
        hookWhitelist[address(0)] = true;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Set platform fee and treasury (ERC-8183 ref: setPlatformFee(feeBP_, treasury_))
    function setPlatformFee(uint256 feeBP_, address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ + evaluatorFeeBps > MAX_FEE_BPS) revert FeesTooHigh();
        platformFeeBps = feeBP_;
        treasury = treasury_;
        emit PlatformFeeSet(feeBP_);
        emit TreasurySet(treasury_);
    }

    function setEvaluatorFee(uint256 bps) external onlyOwner {
        if (bps + platformFeeBps > MAX_FEE_BPS) revert FeesTooHigh();
        evaluatorFeeBps = bps;
        emit EvaluatorFeeSet(bps);
    }

    function setHookWhitelist(address hook, bool allowed) external onlyOwner {
        hookWhitelist[hook] = allowed;
        emit HookWhitelistUpdated(hook, allowed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ── Fee view ─────────────────────────────────────────────────────────────

    /// @notice Preview fee split for a given budget.
    function feeSplit(uint256 budget) external view returns (
        uint256 platformFee, uint256 evaluatorFee, uint256 providerPay
    ) {
        platformFee  = (budget * platformFeeBps)  / BPS_DENOM;
        evaluatorFee = (budget * evaluatorFeeBps) / BPS_DENOM;
        providerPay  = budget - platformFee - evaluatorFee;
    }

    // ── Core lifecycle ───────────────────────────────────────────────────────

    /// @notice Create a new job. provider may be address(0) for later assignment.
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert InvalidExpiry();
        if (!hookWhitelist[hook]) revert HookNotWhitelisted(hook);

        jobId = ++jobCount;
        _jobs[jobId] = Job({
            id:        jobId,
            client:    msg.sender,
            provider:  provider,
            evaluator: evaluator,
            description: description,
            budget:    0,
            expiredAt: expiredAt,
            status:    JobStatus.Open,
            hook:      hook
        });

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    /// @notice Client sets or changes the provider while the job is Open and provider is not yet set.
    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Open);
        if (msg.sender != job.client) revert NotClient();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider == address(0)) revert ZeroAddress();
        job.provider = provider;
        _hookBefore(job.hook, jobId, msg.sig, optParams);
        emit ProviderSet(jobId, provider);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Provider sets the budget (ERC-8183: provider-only per reference impl).
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Open);
        if (msg.sender != job.provider) revert NotProvider();
        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Client funds escrow.
    ///         optParams (optional): if non-empty, abi.decode as uint256 expectedBudget.
    ///         If expectedBudget != job.budget, reverts with BudgetMoved.
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Open);
        if (msg.sender != job.client) revert NotClient();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert BudgetZero();
        if (block.timestamp >= job.expiredAt) revert JobExpiredAlready();

        // BudgetMoved guard: decode expected budget from optParams if provided
        if (optParams.length > 0) {
            uint256 expectedBudget = abi.decode(optParams, (uint256));
            if (expectedBudget != job.budget) revert BudgetMoved(expectedBudget, job.budget);
        }

        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        emit JobFunded(jobId, msg.sender, job.budget);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Provider submits deliverable. deliverable is bytes32 per ERC-8183 spec.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Funded);
        if (msg.sender != job.provider) revert NotProvider();
        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Evaluator completes a Submitted job. reason is bytes32 per ERC-8183 spec.
    /// @dev    GAS WARNING: a hooked job with a registered ERC-8004 agentId costs roughly
    ///         350k gas. Automatic gas estimation can under-estimate this because the
    ///         BondHook calls the ReputationRegistry in an external call whose cost depends
    ///         on registry state. Always send complete() with an explicit gas limit of at
    ///         least 400_000 for hooked jobs to avoid the out-of-gas failure observed on
    ///         mainnet (tx 0xac1482c746ef1548ebfec55ac940257f458ac198c2e0be74e3e9a8918df4cec3).
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Submitted);
        if (msg.sender != job.evaluator) revert NotEvaluator();

        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.status = JobStatus.Completed;

        uint256 budget       = job.budget;
        uint256 platformFee  = (budget * platformFeeBps)  / BPS_DENOM;
        uint256 evaluatorFee = (budget * evaluatorFeeBps) / BPS_DENOM;
        uint256 providerPay  = budget - platformFee - evaluatorFee;

        if (platformFee  > 0) paymentToken.safeTransfer(treasury,       platformFee);
        if (evaluatorFee > 0) {
            paymentToken.safeTransfer(job.evaluator, evaluatorFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evaluatorFee);
        }
        if (providerPay  > 0) {
            paymentToken.safeTransfer(job.provider, providerPay);
            emit PaymentReleased(jobId, job.provider, providerPay);
        }

        emit JobCompleted(jobId, msg.sender, reason);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Reject a job. Evaluator may reject Funded or Submitted; client may reject Open.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);

        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client) revert NotClient();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert NotEvaluator();
        } else {
            revert WrongStatus(JobStatus.Open, job.status);
        }

        _hookBefore(job.hook, jobId, msg.sig, optParams);

        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;

        if (prev == JobStatus.Funded || prev == JobStatus.Submitted) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobRejected(jobId, msg.sender, reason);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Anyone may claim refund after expiredAt on Funded or Submitted jobs.
    ///         MUST NOT call hooks — this is the escape hatch. No extension may block it.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _requireJob(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) {
            revert WrongStatus(JobStatus.Funded, job.status);
        }
        if (block.timestamp < job.expiredAt) revert NotExpiredYet();

        job.status = JobStatus.Expired;
        paymentToken.safeTransfer(job.client, job.budget);
        emit Refunded(jobId, job.client, job.budget);
        emit JobExpired(jobId);
        // NOTE: no hook calls here — intentional per ERC-8183 spec
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _requireJob(uint256 jobId) internal view returns (Job storage job) {
        job = _jobs[jobId];
        require(job.id != 0, "InvalidJob");
    }

    function _requireStatus(Job storage job, JobStatus expected) internal view {
        if (job.status != expected) revert WrongStatus(expected, job.status);
    }

    /// @dev Hook before — passes optParams (Step 3: consistent with afterAction)
    function _hookBefore(address hook, uint256 jobId, bytes4 selector, bytes calldata optParams) internal {
        if (hook != address(0)) {
            IACPHook(hook).beforeAction(jobId, selector, optParams);
        }
    }

    /// @dev Hook after — passes optParams (Step 3: consistent with beforeAction)
    function _hookAfter(address hook, uint256 jobId, bytes4 selector, bytes calldata optParams) internal {
        if (hook != address(0)) {
            IACPHook(hook).afterAction(jobId, selector, optParams);
        }
    }
}
