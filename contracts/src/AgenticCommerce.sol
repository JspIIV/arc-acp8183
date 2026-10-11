// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// AgenticCommerce — faithful ERC-8183 implementation
// Target: Arc Mainnet (chain 5042)
// USDC: 0x3600000000000000000000000000000000000000 (6 decimals)
// ---------------------------------------------------------------------------
contract AgenticCommerce is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── State machine ────────────────────────────────────────────────────────
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    // ── Job data ─────────────────────────────────────────────────────────────
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string  description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;          // address(0) = no hook
    }

    // ── Fee config ────────────────────────────────────────────────────────────
    IERC20  public immutable paymentToken;
    address public treasury;

    uint256 public platformFeeBps;    // e.g. 200 = 2 %
    uint256 public evaluatorFeeBps;   // e.g. 100 = 1 %
    uint256 public constant BPS_DENOM = 10_000;

    // hook whitelist — address(0) key = "no hook" is always allowed
    mapping(address => bool) public hookWhitelist;

    // ── Storage ───────────────────────────────────────────────────────────────
    uint256 private _jobCounter;
    mapping(uint256 => Job) private _jobs;

    // ── Errors ────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error InvalidExpiry();
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error WrongStatus(JobStatus expected, JobStatus actual);
    error ProviderNotSet();
    error BudgetZero();
    error BudgetMoved(uint256 expected, uint256 actual);
    error HookNotWhitelisted(address hook);
    error FeesTooHigh();
    error JobExpiredAlready();
    error NotExpiredYet();
    error ProviderAlreadySet();

    // ── Events ─────────────────────────────────────────────────────────────────
    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, bytes deliverable);
    event JobCompleted(uint256 indexed jobId, string reason);
    event JobRejected(uint256 indexed jobId, string reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool allowed);
    event PlatformFeeSet(uint256 bps);
    event EvaluatorFeeSet(uint256 bps);
    event TreasurySet(address treasury);

    // ── Constructor ──────────────────────────────────────────────────────────
    /// @param paymentToken_   ERC-20 used for all escrow (USDC on Arc Mainnet)
    /// @param treasury_       Receives platform fees; also the initial owner
    constructor(address paymentToken_, address treasury_) Ownable(msg.sender) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        paymentToken = IERC20(paymentToken_);
        treasury     = treasury_;
        // address(0) = "no hook" is implicitly whitelisted
        hookWhitelist[address(0)] = true;
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function initialize(address paymentToken_, address treasury_) external pure {
        // Kept for interface compatibility with ERC-1967 proxy deployments.
        // This non-proxy version uses the constructor; callers should not call this.
        revert("use constructor");
        (paymentToken_, treasury_); // suppress warnings
    }

    function setPlatformFee(uint256 bps) external onlyOwner {
        if (bps + evaluatorFeeBps > BPS_DENOM) revert FeesTooHigh();
        platformFeeBps = bps;
        emit PlatformFeeSet(bps);
    }

    function setEvaluatorFee(uint256 bps) external onlyOwner {
        if (bps + platformFeeBps > BPS_DENOM) revert FeesTooHigh();
        evaluatorFeeBps = bps;
        emit EvaluatorFeeSet(bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setHookWhitelist(address hook, bool allowed) external onlyOwner {
        hookWhitelist[hook] = allowed;
        emit HookWhitelistUpdated(hook, allowed);
    }

    // ── Core: createJob ──────────────────────────────────────────────────────
    /// @dev ERC-8183 §createJob
    ///      provider MAY be address(0); evaluator MUST be non-zero;
    ///      expiredAt MUST be in the future; hook MUST be whitelisted or zero.
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

        jobId = ++_jobCounter;
        _jobs[jobId] = Job({
            id:          jobId,
            client:      msg.sender,
            provider:    provider,
            evaluator:   evaluator,
            description: description,
            budget:      0,
            expiredAt:   expiredAt,
            status:      JobStatus.Open,
            hook:        hook
        });

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    // ── Core: setProvider ────────────────────────────────────────────────────
    /// @dev ERC-8183 §setProvider  — client only; job must be Open with provider==0
    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external {
        Job storage job = _requireJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        _requireStatus(job, JobStatus.Open);
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider == address(0)) revert ZeroAddress();

        _hookBefore(job, AgenticCommerce.setProvider.selector, msg.data);
        job.provider = provider;
        emit ProviderSet(jobId, provider);
        _hookAfter(job, AgenticCommerce.setProvider.selector, optParams);
    }

    // ── Core: setBudget ──────────────────────────────────────────────────────
    /// @dev ERC-8183 §setBudget  — client or provider; job must be Open
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage job = _requireJob(jobId);
        if (msg.sender != job.client && msg.sender != job.provider) revert NotClient();
        _requireStatus(job, JobStatus.Open);

        _hookBefore(job, AgenticCommerce.setBudget.selector, msg.data);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
        _hookAfter(job, AgenticCommerce.setBudget.selector, optParams);
    }

    // ── Core: fund ───────────────────────────────────────────────────────────
    /// @dev ERC-8183 §fund
    ///      optParams: if non-empty, abi.decode as uint256 expectedBudget —
    ///      reverts with BudgetMoved when it doesn't match (front-run guard).
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        _requireStatus(job, JobStatus.Open);
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert BudgetZero();
        if (block.timestamp >= job.expiredAt) revert JobExpiredAlready();

        // Optional front-run guard
        if (optParams.length > 0) {
            uint256 expectedBudget = abi.decode(optParams, (uint256));
            if (expectedBudget != job.budget) revert BudgetMoved(expectedBudget, job.budget);
        }

        _hookBefore(job, AgenticCommerce.fund.selector, msg.data);
        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        emit JobFunded(jobId, job.budget);
        _hookAfter(job, AgenticCommerce.fund.selector, optParams);
    }

    // ── Core: submit ─────────────────────────────────────────────────────────
    /// @dev ERC-8183 §submit — provider only; job must be Funded
    function submit(uint256 jobId, bytes calldata deliverable, bytes calldata optParams) external {
        Job storage job = _requireJob(jobId);
        if (msg.sender != job.provider) revert NotProvider();
        _requireStatus(job, JobStatus.Funded);

        _hookBefore(job, AgenticCommerce.submit.selector, msg.data);
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, deliverable);
        _hookAfter(job, AgenticCommerce.submit.selector, optParams);
    }

    // ── Core: complete ───────────────────────────────────────────────────────
    /// @dev ERC-8183 §complete — evaluator only; job must be Submitted
    function complete(uint256 jobId, string calldata reason, bytes calldata optParams)
        external
        nonReentrant
    {
        Job storage job = _requireJob(jobId);
        if (msg.sender != job.evaluator) revert NotEvaluator();
        _requireStatus(job, JobStatus.Submitted);

        _hookBefore(job, AgenticCommerce.complete.selector, msg.data);
        job.status = JobStatus.Completed;

        (uint256 platformFee, uint256 evaluatorFee, uint256 providerPay) = _splitBudget(job.budget);
        if (platformFee > 0) paymentToken.safeTransfer(treasury, platformFee);
        if (evaluatorFee > 0) paymentToken.safeTransfer(job.evaluator, evaluatorFee);
        paymentToken.safeTransfer(job.provider, providerPay);

        emit EvaluatorFeePaid(jobId, job.evaluator, evaluatorFee);
        emit PaymentReleased(jobId, job.provider, providerPay);
        emit JobCompleted(jobId, reason);
        _hookAfter(job, AgenticCommerce.complete.selector, optParams);
    }

    // ── Core: reject ─────────────────────────────────────────────────────────
    /// @dev ERC-8183 §reject
    ///      — client may reject when Open
    ///      — evaluator may reject when Funded or Submitted
    function reject(uint256 jobId, string calldata reason, bytes calldata optParams)
        external
        nonReentrant
    {
        Job storage job = _requireJob(jobId);

        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client) revert NotClient();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert NotEvaluator();
        } else {
            revert WrongStatus(JobStatus.Open, job.status);
        }

        // Capture whether funds are escrowed BEFORE we change status
        bool hadEscrow = (job.status == JobStatus.Funded || job.status == JobStatus.Submitted);

        _hookBefore(job, AgenticCommerce.reject.selector, msg.data);
        job.status = JobStatus.Rejected;

        // Refund escrow if budget was locked
        if (hadEscrow && job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobRejected(jobId, reason);
        _hookAfter(job, AgenticCommerce.reject.selector, optParams);
    }

    // ── Core: claimRefund ────────────────────────────────────────────────────
    /// @dev ERC-8183 §claimRefund — anyone; job must be Funded or Submitted; expiredAt must have passed.
    ///      DELIBERATELY does NOT call hooks — this is the irrevocable escape hatch.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _requireJob(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) {
            revert WrongStatus(JobStatus.Funded, job.status);
        }
        if (block.timestamp < job.expiredAt) revert NotExpiredYet();

        job.status = JobStatus.Expired;
        uint256 escrow = job.budget;
        paymentToken.safeTransfer(job.client, escrow);
        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, escrow);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function getJob(uint256 jobId) external view returns (Job memory) {
        return _requireJob(jobId);
    }

    function jobCount() external view returns (uint256) {
        return _jobCounter;
    }

    function feeSplit(uint256 budget)
        external
        view
        returns (uint256 platformFee, uint256 evaluatorFee, uint256 providerPay)
    {
        return _splitBudget(budget);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────
    function _requireJob(uint256 jobId) internal view returns (Job storage job) {
        job = _jobs[jobId];
        require(job.id != 0, "unknown job");
    }

    function _requireStatus(Job storage job, JobStatus expected) internal view {
        if (job.status != expected) revert WrongStatus(expected, job.status);
    }

    /// Returns true when the budget is currently held in escrow
    function _isEscrowed(Job storage job) internal view returns (bool) {
        JobStatus s = job.status;
        // After reject is called the status is already Rejected here,
        // but we need to know whether funds were escrowed before the call.
        // We track this via the original status passed to reject(), so we
        // always refund when called from reject on Funded/Submitted.
        // For direct _isEscrowed checks (outside reject) we use status.
        return s == JobStatus.Funded || s == JobStatus.Submitted || s == JobStatus.Rejected;
    }

    function _splitBudget(uint256 budget)
        internal
        view
        returns (uint256 platformFee, uint256 evaluatorFee, uint256 providerPay)
    {
        platformFee  = (budget * platformFeeBps)  / BPS_DENOM;
        evaluatorFee = (budget * evaluatorFeeBps) / BPS_DENOM;
        providerPay  = budget - platformFee - evaluatorFee;
    }

    function _hookBefore(Job storage job, bytes4 selector, bytes calldata data) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).beforeAction(job.id, selector, data);
        }
    }

    function _hookAfter(Job storage job, bytes4 selector, bytes calldata data) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).afterAction(job.id, selector, data);
        }
    }
}
