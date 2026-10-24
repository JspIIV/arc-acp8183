// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IACP.sol";

// ---------------------------------------------------------------------------
// AgenticCommerce — ERC-8183 implementation
//
// K-1: fundOnBehalfOf(jobId, client, optParams) — trusted funders (CCTPJobFunder)
//      can fund a job on behalf of a client without needing to be the job.client.
// K-3: Push → Pull payouts. complete/reject/claimRefund credit _owed[addr].
//      Recipients call withdraw() to pull their funds.
//      This prevents a blocklisted client/provider/evaluator from bricking settlement.
// ---------------------------------------------------------------------------
contract AgenticCommerce is IAgenticCommerce, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Storage ──────────────────────────────────────────────────────────────
    IERC20  public immutable paymentToken;
    address public           treasury;

    uint256 public platformFeeBps;
    uint256 public evaluatorFeeBps;

    uint256 public constant BPS_DENOM   = 10_000;
    uint256 public constant MAX_FEE_BPS = 2_000;  // combined cap 20%

    mapping(uint256 => Job) private _jobs;
    uint256 public jobCount;

    mapping(address => bool) public hookWhitelist;

    // K-1: trusted funders that may call fundOnBehalfOf
    mapping(address => bool) public trustedFunder;

    // K-3: pull-payment balances
    mapping(address => uint256) private _owed;

    // ── Errors ───────────────────────────────────────────────────────────────
    error WrongStatus(JobStatus expected, JobStatus actual);
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error NotTrustedFunder();
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
    error NothingToWithdraw();
    error EmergencySettleOnlyOwner();

    // ── Events ───────────────────────────────────────────────────────────────
    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    /// @notice uri is the content-addressed location of the deliverable (e.g. ipfs://CID).
    ///         Empty string when the provider did not encode a URI in optParams.
    ///         Integrity: keccak256(content) MUST equal deliverable.
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable, string uri);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    /// @notice K-3: funds credited to recipient; call withdraw() to receive them.
    event PaymentCredited(uint256 indexed jobId, address indexed recipient, uint256 amount);
    event EvaluatorFeeCredited(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event RefundCredited(uint256 indexed jobId, address indexed client, uint256 amount);
    // Legacy aliases kept for indexer compatibility
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool allowed);
    event TrustedFunderSet(address indexed funder, bool trusted);
    event TreasurySet(address treasury);
    event PlatformFeeSet(uint256 bps);
    event EvaluatorFeeSet(uint256 bps);
    event Withdrawn(address indexed recipient, uint256 amount);
    // H-1: hook failure observability
    event HookFailed(uint256 indexed jobId, address indexed hook, bytes4 selector, bytes reason);

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address paymentToken_, address treasury_) Ownable(msg.sender) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        paymentToken = IERC20(paymentToken_);
        treasury     = treasury_;
        hookWhitelist[address(0)] = true;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

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

    /// @notice K-1: register / deregister a trusted funder contract.
    function setTrustedFunder(address funder, bool trusted) external onlyOwner {
        if (funder == address(0)) revert ZeroAddress();
        trustedFunder[funder] = trusted;
        emit TrustedFunderSet(funder, trusted);
    }

    // ── Fee view ─────────────────────────────────────────────────────────────

    function feeSplit(uint256 budget) external view returns (
        uint256 platformFee, uint256 evaluatorFee, uint256 providerPay
    ) {
        platformFee  = (budget * platformFeeBps)  / BPS_DENOM;
        evaluatorFee = (budget * evaluatorFeeBps) / BPS_DENOM;
        providerPay  = budget - platformFee - evaluatorFee;
    }

    // ── K-3: pull payment ────────────────────────────────────────────────────

    /// @notice Pull funds credited to msg.sender.
    function withdraw() external nonReentrant {
        uint256 amount = _owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        _owed[msg.sender] = 0;
        paymentToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice View pending balance.
    function owed(address recipient) external view returns (uint256) {
        return _owed[recipient];
    }

    // ── Core lifecycle ───────────────────────────────────────────────────────

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

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Open);
        if (msg.sender != job.provider) revert NotProvider();
        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @notice Client funds escrow directly.
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        _fundFor(jobId, msg.sender, optParams);
    }

    /// @notice K-1: trusted funder funds escrow on behalf of client.
    ///         Only whitelisted addresses (CCTPJobFunder) may call this.
    function fundOnBehalfOf(uint256 jobId, address client, bytes calldata optParams) external nonReentrant {
        if (!trustedFunder[msg.sender]) revert NotTrustedFunder();
        _fundFor(jobId, client, optParams);
    }

    function _fundFor(uint256 jobId, address payer, bytes calldata optParams) internal {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Open);
        if (payer != job.client) revert NotClient();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert BudgetZero();
        if (block.timestamp >= job.expiredAt) revert JobExpiredAlready();

        if (optParams.length > 0) {
            uint256 expectedBudget = abi.decode(optParams, (uint256));
            if (expectedBudget != job.budget) revert BudgetMoved(expectedBudget, job.budget);
        }

        _hookBefore(job.hook, jobId, IAgenticCommerce.fund.selector, optParams);
        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        emit JobFunded(jobId, payer, job.budget);
        _hookAfter(job.hook, jobId, IAgenticCommerce.fund.selector, optParams);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = _requireJob(jobId);
        _requireStatus(job, JobStatus.Funded);
        if (msg.sender != job.provider) revert NotProvider();
        _hookBefore(job.hook, jobId, msg.sig, optParams);
        job.status = JobStatus.Submitted;

        string memory uri = "";
        if (optParams.length > 0) {
            try this._decodeSubmitURI(optParams) returns (string memory u) {
                uri = u;
            } catch {}
        }
        emit JobSubmitted(jobId, msg.sender, deliverable, uri);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

    /// @dev GAS WARNING: a hooked job with a registered ERC-8004 agentId costs roughly
    ///      350k gas. Automatic estimation can under-estimate. Send complete() with an
    ///      explicit gas limit of at least 400_000 for hooked jobs.
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

        // K-3: credit instead of push-transfer
        if (platformFee  > 0) {
            _owed[treasury]       += platformFee;
        }
        if (evaluatorFee > 0) {
            _owed[job.evaluator]  += evaluatorFee;
            emit EvaluatorFeeCredited(jobId, job.evaluator, evaluatorFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evaluatorFee); // legacy
        }
        if (providerPay  > 0) {
            _owed[job.provider]   += providerPay;
            emit PaymentCredited(jobId, job.provider, providerPay);
            emit PaymentReleased(jobId, job.provider, providerPay); // legacy
        }

        emit JobCompleted(jobId, msg.sender, reason);
        _hookAfter(job.hook, jobId, msg.sig, optParams);
    }

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
            // K-3: credit instead of push-transfer
            _owed[job.client] += job.budget;
            emit RefundCredited(jobId, job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget); // legacy
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
        // K-3: credit instead of push-transfer
        _owed[job.client] += job.budget;
        emit RefundCredited(jobId, job.client, job.budget);
        emit Refunded(jobId, job.client, job.budget); // legacy
        emit JobExpired(jobId);
        // NOTE: no hook calls here — intentional per ERC-8183 spec
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _decodeSubmitURI(bytes calldata optParams) external pure returns (string memory uri) {
        (, , uri) = abi.decode(optParams, (address, uint256, string));
    }

    function _requireJob(uint256 jobId) internal view returns (Job storage job) {
        job = _jobs[jobId];
        require(job.id != 0, "InvalidJob");
    }

    function _requireStatus(Job storage job, JobStatus expected) internal view {
        if (job.status != expected) revert WrongStatus(expected, job.status);
    }

    /// @notice H-1: hook calls are wrapped in try/catch.
    ///         A reverting hook emits HookFailed but never blocks the lifecycle.
    ///         The lifecycle state has already been committed before _hookAfter is called,
    ///         so a hook failure in afterAction cannot corrupt the job state.
    function _hookBefore(address hook, uint256 jobId, bytes4 selector, bytes calldata optParams) internal {
        if (hook == address(0)) return;
        try IACPHook(hook).beforeAction(jobId, selector, optParams) {
            // success
        } catch (bytes memory reason) {
            emit HookFailed(jobId, hook, selector, reason);
            // before-hooks that revert should only skip non-critical logic.
            // For submit/complete/reject the before-hook may perform bond locking
            // (BondHook._beforeSubmit). In that case the revert IS intentional
            // (e.g. InsufficientFreeBond) and we must bubble it up so the
            // lifecycle function also reverts. We therefore re-revert:
            assembly { revert(add(reason, 32), mload(reason)) }
        }
    }

    function _hookAfter(address hook, uint256 jobId, bytes4 selector, bytes calldata optParams) internal {
        if (hook == address(0)) return;
        try IACPHook(hook).afterAction(jobId, selector, optParams) {
            // success
        } catch (bytes memory reason) {
            // H-1: after-hooks that revert must NOT block settlement.
            // State is already committed (status = Completed/Rejected/etc.)
            // so we swallow the revert and emit an observable event.
            emit HookFailed(jobId, hook, selector, reason);
        }
    }
}
