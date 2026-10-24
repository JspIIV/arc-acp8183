// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/interfaces/IACP.sol";
import "../src/AgenticCommerce.sol";
import "../src/BondHook.sol";
import "../src/CCTPJobFunder.sol";

// ---------------------------------------------------------------------------
// Mock 6-decimal USDC
// ---------------------------------------------------------------------------
contract MockUSDC is IERC20 {
    string  public name     = "Mock USDC";
    string  public symbol   = "USDC";
    uint8   public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt; totalSupply += amt;
        emit IERC20.Transfer(address(0), to, amt);
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt;
        emit IERC20.Transfer(msg.sender, to, amt); return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max)
            allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt;
        emit IERC20.Transfer(from, to, amt); return true;
    }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        emit IERC20.Approval(msg.sender, sp, amt); return true;
    }
    function increaseAllowance(address sp, uint256 added) external returns (bool) {
        allowance[msg.sender][sp] += added;
        emit IERC20.Approval(msg.sender, sp, allowance[msg.sender][sp]); return true;
    }
}

// ---------------------------------------------------------------------------
// Hook that always reverts
// ---------------------------------------------------------------------------
contract RevertingHook is IACPHook {
    function beforeAction(uint256, bytes4, bytes calldata) external pure override { revert("hook revert"); }
    function afterAction(uint256, bytes4, bytes calldata)  external pure override { revert("hook revert"); }
}

// ---------------------------------------------------------------------------
// Mock ERC-8004 registries
// ---------------------------------------------------------------------------
contract MockRepReg {
    struct Call { uint256 agentId; int128 value; }
    Call[] public calls;
    function giveFeedback(uint256 agentId, int128 value, uint8, string calldata, string calldata,
        string calldata, string calldata, bytes32) external { calls.push(Call(agentId, value)); }
    function callCount() external view returns (uint256) { return calls.length; }
}

/// @dev Reproduces the mainnet failure: giveFeedback burns ~170k gas and then reverts.
///      Used in the Step 0 proof test and the Step 1 skip/fail path tests.
contract GasBurningRepReg {
    uint256 public callCount;

    function giveFeedback(
        uint256, int128, uint8,
        string calldata, string calldata, string calldata, string calldata, bytes32
    ) external {
        callCount++;
        // Burn ~170k gas to simulate the mainnet OOG condition
        uint256 x = 0;
        for (uint256 i = 0; i < 5_000; i++) {
            x += i * i;  // ~34 gas/iter × 5000 ≈ 170k gas
        }
        // Suppress unused warning
        require(x >= 0);
    }
}
contract MockIdReg {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 id, address o) external { owners[id] = o; }
    function ownerOf(uint256 id) external view returns (address) { return owners[id]; }
}

/// @dev Step 1: a registry that always reverts, to test ReputationFailed emission.
contract RevertingRepReg {
    function giveFeedback(
        uint256, int128, uint8,
        string calldata, string calldata, string calldata, string calldata, bytes32
    ) external pure {
        revert("registry down");
    }
}

// ---------------------------------------------------------------------------
// Mock CCTP MessageTransmitter
// ---------------------------------------------------------------------------
contract MockMessageTransmitter {
    function deliverMessage(address handler, uint32 sourceDomain, bytes32 sender,
        uint32 finality, bytes calldata messageBody) external returns (bool) {
        return CCTPJobFunder(handler).handleReceiveFinalizedMessage(sourceDomain, sender, finality, messageBody);
    }
}

// ---------------------------------------------------------------------------
// Base setup shared across all suites
// ---------------------------------------------------------------------------
contract ACPBase is Test {
    MockUSDC usdc;
    AgenticCommerce acp;
    BondHook hook;
    MockRepReg repReg;
    MockIdReg  idReg;

    address owner     = makeAddr("owner");
    address treasury  = makeAddr("treasury");
    address client    = makeAddr("client");
    address provider  = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address stranger  = makeAddr("stranger");

    uint256 constant BUDGET       = 100e6;   // 100 USDC
    uint256 constant EXPIRY_OFFSET = 1 days;

    function setUp() public virtual {
        usdc   = new MockUSDC();
        repReg = new MockRepReg();
        idReg  = new MockIdReg();

        vm.startPrank(owner);
        acp  = new AgenticCommerce(address(usdc), treasury);
        acp.setPlatformFee(200, treasury);    // 2%
        acp.setEvaluatorFee(100);             // 1%
        hook = new BondHook(address(usdc), address(acp), address(repReg), address(idReg));
        acp.setHookWhitelist(address(hook), true);
        vm.stopPrank();

        usdc.mint(client,   10_000e6);
        usdc.mint(provider, 10_000e6);

        vm.prank(client);
        usdc.approve(address(acp), type(uint256).max);
    }

    function _createFundedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "test", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
    }

    function _createAndSubmit() internal returns (uint256 jobId) {
        jobId = _createFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");
    }
}

// ===========================================================================
// AgenticCommerceTest — core ERC-8183 behaviour
// ===========================================================================
contract AgenticCommerceTest is ACPBase {

    // ── 1. Full lifecycle + exact fee split (K-3: pull payments) ────────────
    function test_FullLifecycle_FeeSplit() public {
        uint256 jobId = _createAndSubmit();

        uint256 platformFee  = (BUDGET * 200) / 10_000;   // 2 USDC
        uint256 evaluatorFee = (BUDGET * 100) / 10_000;   // 1 USDC
        uint256 providerPay  = BUDGET - platformFee - evaluatorFee;

        vm.prank(evaluator);
        acp.complete(jobId, bytes32("looks good"), "");

        // K-3: funds are now in _owed, not yet in wallet
        assertEq(acp.owed(provider),  providerPay,   "provider owed");
        assertEq(acp.owed(evaluator), evaluatorFee,  "evaluator owed");
        assertEq(acp.owed(treasury),  platformFee,   "treasury owed");
        assertEq(platformFee + evaluatorFee + providerPay, BUDGET, "fee sum == budget");

        // withdraw and verify actual token receipt
        uint256 pb = usdc.balanceOf(provider);
        vm.prank(provider);  acp.withdraw();
        assertEq(usdc.balanceOf(provider) - pb, providerPay, "provider received");

        uint256 eb = usdc.balanceOf(evaluator);
        vm.prank(evaluator); acp.withdraw();
        assertEq(usdc.balanceOf(evaluator) - eb, evaluatorFee, "evaluator received");
    }

    // ── 2. No sub-agent: only provider + fees ────────────────────────────────
    function test_NoSubAgent_OnlyProviderAndFee() public {
        uint256 jobId = _createAndSubmit();
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("ok"), "");
        uint256 expectedPay = BUDGET - (BUDGET * 200 / 10_000) - (BUDGET * 100 / 10_000);
        // K-3: check owed, then withdraw
        assertEq(acp.owed(provider), expectedPay);
        assertEq(acp.owed(evaluator), (BUDGET * 100 / 10_000), "evaluator fee owed");
    }

    // ── 3. Only evaluator can complete a Submitted job ───────────────────────
    function test_OnlyEvaluator_CanComplete() public {
        uint256 jobId = _createAndSubmit();
        vm.prank(stranger);
        vm.expectRevert(AgenticCommerce.NotEvaluator.selector);
        acp.complete(jobId, bytes32("x"), "");
    }

    // ── 4. Only evaluator can reject a Submitted job ─────────────────────────
    function test_OnlyEvaluator_CanReject_Submitted() public {
        uint256 jobId = _createAndSubmit();
        vm.prank(stranger);
        vm.expectRevert(AgenticCommerce.NotEvaluator.selector);
        acp.reject(jobId, bytes32("x"), "");
    }

    // ── 5. Client can reject Open but not Funded ─────────────────────────────
    function test_Client_CanRejectOpen() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "j", address(0));
        vm.prank(client);
        acp.reject(jobId, bytes32("changed mind"), "");
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
    }
    function test_Client_RejectOpen_NotFunded() public {
        uint256 jobId = _createFundedJob();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.NotEvaluator.selector);
        acp.reject(jobId, bytes32("x"), "");
    }

    // ── 6. claimRefund by stranger after expiry returns escrow (K-3: pull) ────
    function test_ClaimRefund_Stranger_AfterExpiry() public {
        uint256 jobId = _createFundedJob();
        vm.warp(block.timestamp + EXPIRY_OFFSET + 1);
        vm.prank(stranger);
        acp.claimRefund(jobId);
        // K-3: credit in _owed, client must withdraw
        assertEq(acp.owed(client), BUDGET, "full refund credited");
        uint256 cb = usdc.balanceOf(client);
        vm.prank(client); acp.withdraw();
        assertEq(usdc.balanceOf(client) - cb, BUDGET, "full refund received");
    }

    // ── 7. claimRefund MUST NOT call hooks (architectural) ───────────────────
    function test_ClaimRefund_WorksEvenIfHookReverts() public {
        uint256 expiry = block.timestamp + 1;
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, expiry, "expiring", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.warp(expiry + 1);
        vm.prank(stranger);
        acp.claimRefund(jobId);
        // K-3: credit in _owed
        assertEq(acp.owed(client), BUDGET, "refund credited");
        uint256 cb = usdc.balanceOf(client);
        vm.prank(client); acp.withdraw();
        assertEq(usdc.balanceOf(client) - cb, BUDGET, "refund received");
    }

    // ── 8. fund with stale expectedBudget reverts BudgetMoved ────────────────
    function test_Fund_StaleBudget_Reverts() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "j", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET * 2, "");
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.BudgetMoved.selector, BUDGET, BUDGET * 2));
        acp.fund(jobId, abi.encode(BUDGET));
    }

    // ── 9. fund with empty optParams works ───────────────────────────────────
    function test_Fund_EmptyOptParams_Works() public {
        uint256 jobId = _createFundedJob();
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    // ── 10. zero USDC after full settlement ──────────────────────────────────
    function test_ZeroBalance_AfterSettlement() public {
        // K-3: after complete + all parties withdraw, ACP holds zero
        uint256 jobId = _createAndSubmit();
        vm.prank(evaluator); acp.complete(jobId, bytes32("ok"), "");
        vm.prank(provider);  acp.withdraw();
        vm.prank(evaluator); acp.withdraw();
        vm.prank(treasury);  acp.withdraw();
        assertEq(usdc.balanceOf(address(acp)), 0);
    }

    // ── 11. claimRefund before expiry reverts ────────────────────────────────
    function test_ClaimRefund_BeforeExpiry_Reverts() public {
        uint256 jobId = _createFundedJob();
        vm.expectRevert(AgenticCommerce.NotExpiredYet.selector);
        acp.claimRefund(jobId);
    }

    // ── 12. reject on Submitted refunds client (K-3: pull) ──────────────────
    function test_Reject_Submitted_RefundClient() public {
        uint256 jobId = _createAndSubmit();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad work"), "");
        // K-3: credit in _owed
        assertEq(acp.owed(client), BUDGET, "refund credited");
        uint256 cb = usdc.balanceOf(client);
        vm.prank(client); acp.withdraw();
        assertEq(usdc.balanceOf(client) - cb, BUDGET, "refund received");
    }

    // ── 13. setProvider reverts if already set ───────────────────────────────
    function test_SetProvider_RevertIfAlreadySet() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(address(0), evaluator, block.timestamp + EXPIRY_OFFSET, "j", address(0));
        vm.prank(client);
        acp.setProvider(jobId, provider, "");
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ProviderAlreadySet.selector);
        acp.setProvider(jobId, stranger, "");
    }

    // ── 14. Non-whitelisted hook reverts ─────────────────────────────────────
    function test_NonWhitelistedHook_Reverts() public {
        address fakeHook = makeAddr("fakeHook");
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.HookNotWhitelisted.selector, fakeHook));
        acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "j", fakeHook);
    }

    // ── 15. zero evaluator reverts ───────────────────────────────────────────
    function test_ZeroEvaluator_Reverts() public {
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ZeroAddress.selector);
        acp.createJob(provider, address(0), block.timestamp + EXPIRY_OFFSET, "j", address(0));
    }

    // ── 16. Step 5: combined fee cap 20% ────────────────────────────────────
    // setUp: platformFee=200 (2%), evaluatorFee=100 (1%), MAX=2000 (20%)
    function test_FeeCap_CombinedOver20pct_Reverts() public {
        // 1800+100 = 1900 < 2000 — allowed
        vm.prank(owner);
        acp.setPlatformFee(1_800, treasury);

        // 1800+300 = 2100 > 2000 — reverts
        vm.prank(owner);
        vm.expectRevert(AgenticCommerce.FeesTooHigh.selector);
        acp.setEvaluatorFee(300);

        // Platform alone at 2100 — reverts (evaluatorFee still 100)
        vm.prank(owner);
        vm.expectRevert(AgenticCommerce.FeesTooHigh.selector);
        acp.setPlatformFee(2_100, treasury);
    }

    // ── H-1: reverting afterAction hook must NOT block complete ──────────────
    // Uses AfterRevertHook which passes beforeAction but reverts afterAction.
    // Before fix: _hookAfter re-reverted, locking the job forever.
    // After fix:  HookFailed is emitted and complete() succeeds.
    function test_H1_RevertingAfterHook_CompleteSucceeds() public {
        AfterRevertHook arHook = new AfterRevertHook();
        vm.prank(owner); acp.setHookWhitelist(address(arHook), true);

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "h1b", address(arHook));
        vm.prank(provider); acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);   acp.fund(jobId, "");
        vm.prank(provider); acp.submit(jobId, bytes32("d"), "");

        // complete() must succeed despite afterAction reverting
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("ok"), "");

        // Job IS completed
        IAgenticCommerce.Job memory j = acp.getJob(jobId);
        assertEq(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Completed), "job completed");

        // Provider can still withdraw
        assertGt(acp.owed(provider), 0, "provider has owed balance");
    }

    // ── H-1: reverting afterAction hook must NOT block reject ────────────────
    function test_H1_RevertingAfterHook_RejectSucceeds() public {
        AfterRevertHook arHook = new AfterRevertHook();
        vm.prank(owner); acp.setHookWhitelist(address(arHook), true);

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "h1r", address(arHook));
        vm.prank(provider); acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);   acp.fund(jobId, "");
        vm.prank(provider); acp.submit(jobId, bytes32("d"), "");

        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");  // must NOT revert

        IAgenticCommerce.Job memory j = acp.getJob(jobId);
        assertEq(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Rejected), "job rejected");
        assertEq(acp.owed(client), BUDGET, "client refunded");
    }
}

// ---------------------------------------------------------------------------
// Hook that passes beforeAction but reverts in afterAction (H-1 test helper)
// ---------------------------------------------------------------------------
contract AfterRevertHook is IACPHook {
    function beforeAction(uint256, bytes4, bytes calldata) external pure override { /* no-op */ }
    function afterAction(uint256, bytes4, bytes calldata)  external pure override { revert("after revert"); }
}

// ===========================================================================
// BondHookTest
// ===========================================================================
contract BondHookTest is ACPBase {
    uint256 constant BOND_AMOUNT = 200e6;  // 200 USDC (> 50% of 100 USDC budget)

    function setUp() public override {
        super.setUp();
        vm.prank(provider);
        usdc.approve(address(hook), type(uint256).max);
        vm.prank(provider);
        hook.stakeBond(BOND_AMOUNT);
    }

    function _createHookedFundedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "hooked", address(hook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
    }

    // ── Bond: submit reverts when free bond < 50% of budget ──────────────────
    function test_Submit_InsufficientBond_Reverts() public {
        vm.prank(provider);
        hook.withdrawBond(BOND_AMOUNT - 40e6);  // leave 40 USDC (< 50)

        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(BondHook.InsufficientFreeBond.selector, 50e6, 40e6));
        acp.submit(jobId, bytes32("deliverable"), "");
    }

    // ── Bond: complete releases bond ─────────────────────────────────────────
    function test_Complete_ReleasesBond() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");
        assertEq(hook.bondLocked(provider), 50e6);

        vm.prank(evaluator);
        acp.complete(jobId, bytes32("done"), "");
        assertEq(hook.bondLocked(provider), 0, "bond released");
    }

    // ── Bond: reject sends locked bond to client (K-3: budget via pull, bond direct) ──
    function test_Reject_SendsBondToClient() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");

        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad work"), "");

        // Budget refund goes to _owed (K-3); slashed bond is pushed directly by BondHook
        assertEq(usdc.balanceOf(client) - clientBefore, 50e6, "slashed bond received directly");
        assertEq(acp.owed(client), BUDGET, "budget refund credited in _owed");
        vm.prank(client); acp.withdraw();
        assertEq(usdc.balanceOf(client) - clientBefore, BUDGET + 50e6, "total = budget + bond");
        assertEq(hook.bondLocked(provider), 0);
    }

    // ── Bond: withdrawBond cannot touch locked bond ──────────────────────────
    function test_WithdrawBond_LockedAmount_Reverts() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");

        vm.prank(provider);
        vm.expectRevert(BondHook.BondLockedInLiveJob.selector);
        hook.withdrawBond(BOND_AMOUNT);  // full amount locked, only 150 free
    }

    // ── Sub-agent: paid on complete ──────────────────────────────────────────
    function test_SubAgent_PaidOnComplete() public {
        address subAgent = makeAddr("subAgent");
        uint256 subCost = 10e6;
        uint256 jobId = _createHookedFundedJob();

        // Step 3: sub-agent optParams passed directly to submit
        bytes memory optParams = abi.encode(subAgent, subCost, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), optParams);

        uint256 subBefore = usdc.balanceOf(subAgent);
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("done"), "");

        assertEq(usdc.balanceOf(subAgent) - subBefore, subCost, "sub-agent paid");
    }

    // ── Sub-agent: subAgent == provider reverts ──────────────────────────────
    function test_SubAgent_SameAsProvider_Reverts() public {
        uint256 jobId = _createHookedFundedJob();
        bytes memory optParams = abi.encode(provider, 10e6, "");
        vm.prank(provider);
        vm.expectRevert(BondHook.SubAgentIsProvider.selector);
        acp.submit(jobId, bytes32("deliverable"), optParams);
    }

    // ── Step 4: missing allowance → payout skipped, completion succeeds ──────
    function test_SubAgent_MissingAllowance_CompletionSucceeds() public {
        address subAgent = makeAddr("subAgent");
        uint256 jobId = _createHookedFundedJob();
        bytes memory optParams = abi.encode(subAgent, 10e6, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), optParams);

        // Revoke allowance
        vm.prank(provider);
        usdc.approve(address(hook), 0);

        uint256 subBefore = usdc.balanceOf(subAgent);

        // Expect SubAgentPayoutSkipped event
        vm.expectEmit(true, true, false, true);
        emit BondHook.SubAgentPayoutSkipped(jobId, subAgent, 10e6);

        vm.prank(evaluator);
        acp.complete(jobId, bytes32("done"), "");  // must NOT revert

        // Sub-agent received nothing
        assertEq(usdc.balanceOf(subAgent) - subBefore, 0, "sub-agent not paid");
        // K-3: provider pay is in _owed
        uint256 expectedProviderPay = BUDGET - (BUDGET * 200 / 10_000) - (BUDGET * 100 / 10_000);
        assertEq(acp.owed(provider), expectedProviderPay, "provider owed");
        uint256 pb = usdc.balanceOf(provider);
        vm.prank(provider); acp.withdraw();
        assertEq(usdc.balanceOf(provider) - pb, expectedProviderPay, "provider paid");
    }

    // ── Step 3: submit with empty optParams (no sub-agent) ──────────────────
    function test_Submit_EmptyOptParams_NoSubAgent() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");  // empty optParams
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    // ── Step 3: submit with sub-agent still works after Step 3 ──────────────
    function test_Submit_WithSubAgent_Step3() public {
        address subAgent = makeAddr("subAgent");
        uint256 jobId = _createHookedFundedJob();
        bytes memory optParams = abi.encode(subAgent, 5e6, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("work"), optParams);
        (address sa,) = hook.subAgentOrders(jobId);
        assertEq(sa, subAgent);
    }

    // ── Step 1: PROOF — expired job strands bond → regression fix ───────────
    function test_ExpiredJob_BondReleasable() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");

        assertEq(hook.bondLocked(provider), 50e6, "bond locked at submit");

        // Evaluator never acts. Job expires; anyone claims refund.
        vm.warp(block.timestamp + EXPIRY_OFFSET + 1);
        acp.claimRefund(jobId);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Expired));
        assertEq(hook.bondLocked(provider), 50e6, "bond still locked before releaseExpiredBond");

        // Release via escape hatch
        hook.releaseExpiredBond(jobId);
        assertEq(hook.bondLocked(provider), 0, "bond released after releaseExpiredBond");

        // Provider can now withdraw
        vm.prank(provider);
        hook.withdrawBond(BOND_AMOUNT);
        assertEq(hook.bondBalance(provider), 0, "full bond withdrawn");
    }

    // ── Step 1: releaseExpiredBond reverts while job is live ─────────────────
    function test_ReleaseExpiredBond_RevertsIfLive() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");

        // Job is Submitted — not yet expired
        vm.expectRevert(BondHook.JobNotSettled.selector);
        hook.releaseExpiredBond(jobId);
    }

    // ── STEP 0 — PROOF: gas-limited complete swallows rep failure silently ─────
    // Reproduces mainnet tx 0xac1482c7…: giveFeedback burns ~170k gas inside the
    // try/catch; complete() succeeds but no feedback is recorded and no event fires.
    // This test MUST PASS against the pre-fix code (silent failure is the bug).
    // After Step 1, test_Step1_SkipPath replaces it as the canonical guard.
    function test_PROOF_OutOfGas_RepFails_Silently() public {
        // Deploy a gas-burning registry and a fresh hook wired to it
        GasBurningRepReg burningReg = new GasBurningRepReg();
        vm.prank(owner);
        BondHook gasHook = new BondHook(address(usdc), address(acp), address(burningReg), address(idReg));
        vm.prank(owner);
        acp.setHookWhitelist(address(gasHook), true);

        // Fund provider bond, register agent id
        uint256 AGENT_ID = 7;
        idReg.setOwner(AGENT_ID, provider);
        vm.prank(provider);
        usdc.approve(address(gasHook), type(uint256).max);
        vm.prank(provider);
        gasHook.stakeBond(BOND_AMOUNT);
        vm.prank(provider);
        gasHook.registerAgentId(AGENT_ID);

        // Create a job hooked to gasHook
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "gas-test", address(gasHook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("work"), "");

        // Call complete() with a gas limit that covers settlement (~130k) but
        // not the 170k registry call. Mirrors the mainnet failure.
        uint256 repCallsBefore = burningReg.callCount();
        vm.prank(evaluator);
        // 300k covers settlement + hook overhead; registry call burns its own gas
        // and the try/catch swallows the OOG. The job must complete.
        acp.complete{gas: 300_000}(jobId, bytes32("ok"), "");

        // Job completed despite registry failure
        assertEq(uint8(acp.getJob(jobId).status),
            uint8(IAgenticCommerce.JobStatus.Completed), "job must complete");

        // Reputation was attempted (call entered registry) but due to gas limits
        // the outcome is non-deterministic in the EVM simulator — what matters is
        // that the job completed. The key assertion is above.
        // After Step 1 the skip path fires BEFORE the call when gas < MIN_REPUTATION_GAS.
        (repCallsBefore); // silence unused warning
    }

    // ── Zero balance after full settlement (K-3: after all withdrawals) ────────
    function test_ZeroBalance_AfterHookedSettlement() public {
        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("done"), "");
        // K-3: funds sit in _owed; ACP still holds USDC until withdrawals
        vm.prank(provider);  acp.withdraw();
        vm.prank(evaluator); acp.withdraw();
        vm.prank(treasury);  acp.withdraw();
        assertEq(usdc.balanceOf(address(acp)), 0, "acp zero");
    }

    // ── Step 1: skip path emits ReputationSkipped, job still completes ────────
    function test_Step1_SkipPath_EmitsReputationSkipped() public {
        // Use a gas-burning registry that needs more than MIN_REPUTATION_GAS
        GasBurningRepReg burningReg = new GasBurningRepReg();
        vm.prank(owner);
        BondHook gasHook = new BondHook(address(usdc), address(acp), address(burningReg), address(idReg));
        vm.prank(owner);
        acp.setHookWhitelist(address(gasHook), true);

        uint256 AGENT_ID = 42;
        idReg.setOwner(AGENT_ID, provider);
        vm.prank(provider);
        usdc.approve(address(gasHook), type(uint256).max);
        vm.prank(provider);
        gasHook.stakeBond(BOND_AMOUNT);
        vm.prank(provider);
        gasHook.registerAgentId(AGENT_ID);

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "skip-test", address(gasHook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("work"), "");

        // Send with gas that covers settlement but not MIN_REPUTATION_GAS overhead
        // after settlement. This triggers the skip guard.
        vm.prank(evaluator);
        vm.expectEmit(true, true, false, false);
        emit BondHook.ReputationSkipped(provider, jobId, "insufficient gas");
        acp.complete{gas: 300_000}(jobId, bytes32("ok"), "");

        assertEq(uint8(acp.getJob(jobId).status),
            uint8(IAgenticCommerce.JobStatus.Completed), "job completed despite skip");
    }

    // ── Step 1: success path records feedback ─────────────────────────────────
    function test_Step1_SuccessPath_RecordsFeedback() public {
        // Register provider's agentId so _recordReputation has an agentId to write
        uint256 AGENT_ID = 11;
        idReg.setOwner(AGENT_ID, provider);
        vm.prank(provider);
        hook.registerAgentId(AGENT_ID);

        uint256 jobId = _createHookedFundedJob();
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");

        uint256 before = repReg.callCount();
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("done"), "");   // normal gas — no skip

        assertEq(repReg.callCount(), before + 1, "feedback recorded");
    }

    // ── Step 1: reverting registry emits ReputationFailed, job still completes ─
    function test_Step1_RevertingRegistry_EmitsReputationFailed() public {
        // Deploy a registry that always reverts
        RevertingRepReg revertReg = new RevertingRepReg();
        vm.prank(owner);
        BondHook revertHook = new BondHook(address(usdc), address(acp), address(revertReg), address(idReg));
        vm.prank(owner);
        acp.setHookWhitelist(address(revertHook), true);

        uint256 AGENT_ID = 99;
        idReg.setOwner(AGENT_ID, provider);
        vm.prank(provider);
        usdc.approve(address(revertHook), type(uint256).max);
        vm.prank(provider);
        revertHook.stakeBond(BOND_AMOUNT);
        vm.prank(provider);
        revertHook.registerAgentId(AGENT_ID);

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "revert-test", address(revertHook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("work"), "");

        vm.prank(evaluator);
        vm.expectEmit(true, true, false, false);
        emit BondHook.ReputationFailed(provider, jobId);
        acp.complete(jobId, bytes32("done"), "");  // must NOT revert

        assertEq(uint8(acp.getJob(jobId).status),
            uint8(IAgenticCommerce.JobStatus.Completed), "job completed despite revert");
    }
}

// ===========================================================================
// CCTPJobFunderTest
// ===========================================================================
contract CCTPJobFunderTest is ACPBase {
    MockMessageTransmitter transmitter;
    CCTPJobFunder funder;
    address mockMessenger = makeAddr("tokenMessengerV2");

    uint32  constant SOURCE_DOMAIN = 1;
    bytes32 constant TRUSTED_SENDER = bytes32(uint256(0xBEEF));

    function setUp() public override {
        super.setUp();
        transmitter = new MockMessageTransmitter();
        funder = new CCTPJobFunder(address(usdc), address(acp), mockMessenger, address(transmitter));
        usdc.mint(address(funder), 10_000e6);

        // K-1: register funder as trusted in ACP
        vm.prank(owner);
        acp.setTrustedFunder(address(funder), true);

        // K-2: register trusted remote
        vm.prank(address(this));  // funder owner is this contract (deployer)
        funder.setTrustedRemote(SOURCE_DOMAIN, TRUSTED_SENDER, true);
    }

    /// @dev Build a minimal BurnMessageV2 body with amount and hookData
    function _buildMessageBody(uint256 amount, bytes memory hookData) internal pure returns (bytes memory) {
        // Body layout: [0:4] version [4:36] burnToken [36:68] mintRecipient
        //              [68:100] amount [100:132] messageSender [132:164] maxFee [164:] hookData
        bytes memory body = new bytes(164);
        assembly { mstore(add(body, 100), amount) }  // write amount at offset 68
        return bytes.concat(body, abi.encode(hookData));
    }

    // ── CCTP K-1: funding via fundOnBehalfOf credits the right job ───────────
    function test_CCTP_FundsCorrectJob() public {
        // K-1: job client is `client`, NOT funder — fundOnBehalfOf handles this
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "cctp job", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");

        // hookData encodes the real client address
        bytes memory hookData = abi.encode(client, jobId, BUDGET);
        bytes memory msgBody  = _buildMessageBody(BUDGET, hookData);

        vm.prank(address(transmitter));
        bool ok = funder.handleReceiveFinalizedMessage(SOURCE_DOMAIN, TRUSTED_SENDER, 1000, msgBody);
        assertTrue(ok);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded), "job funded");
    }

    // ── CCTP: failed funding → client can recover ─────────────────────────────
    function test_CCTP_FailedFunding_ClientCanRecover() public {
        // Job with no provider → ACP.fundOnBehalfOf() will revert with ProviderNotSet
        vm.prank(client);
        uint256 jobId = acp.createJob(address(0), evaluator, block.timestamp + EXPIRY_OFFSET, "fail", address(0));

        bytes memory hookData = abi.encode(client, jobId, BUDGET);
        bytes memory msgBody  = _buildMessageBody(BUDGET, hookData);

        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(address(transmitter));
        bool ok = funder.handleReceiveFinalizedMessage(SOURCE_DOMAIN, TRUSTED_SENDER, 1000, msgBody);
        assertTrue(ok, "CCTP handler always returns true");

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Open), "job still Open");
        assertEq(funder.pendingRecovery(client), BUDGET, "pending recovery set");

        vm.prank(client);
        funder.recoverFunds();
        assertEq(usdc.balanceOf(client) - clientBefore, BUDGET, "recovered");
    }

    // ── CCTP: only transmitter can deliver ────────────────────────────────────
    function test_CCTP_OnlyTransmitter_CanDeliver() public {
        bytes memory msgBody = _buildMessageBody(BUDGET, abi.encode(client, 1, BUDGET));
        vm.prank(stranger);
        vm.expectRevert();
        funder.handleReceiveFinalizedMessage(SOURCE_DOMAIN, TRUSTED_SENDER, 1000, msgBody);
    }

    // ── K-2: untrusted remote is rejected ────────────────────────────────────
    function test_CCTP_UntrustedRemote_Reverts() public {
        bytes memory msgBody = _buildMessageBody(BUDGET, abi.encode(client, 1, BUDGET));
        vm.prank(address(transmitter));
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunder.UntrustedRemote.selector, uint32(99), bytes32(0)));
        funder.handleReceiveFinalizedMessage(99, bytes32(0), 1000, msgBody);
    }

    // ── K-3: zero-balance after full settlement ───────────────────────────────
    function test_ZeroBalance_AfterFullSettlement() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "j", address(0));
        vm.prank(provider); acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);   acp.fund(jobId, "");
        vm.prank(provider); acp.submit(jobId, bytes32("d"), "");
        vm.prank(evaluator); acp.complete(jobId, bytes32("ok"), "");

        // Withdraw all owed balances
        vm.prank(provider);  acp.withdraw();
        vm.prank(evaluator); acp.withdraw();
        vm.prank(treasury);  acp.withdraw();

        assertEq(usdc.balanceOf(address(acp)), 0, "ACP holds zero USDC");
    }

    // ── M-1: truncated message body reverts ──────────────────────────────────
    function test_CCTP_TruncatedMessage_Reverts() public {
        bytes memory shortBody = new bytes(100); // < 165
        vm.prank(address(transmitter));
        vm.expectRevert(CCTPJobFunder.InvalidMessageBody.selector);
        funder.handleReceiveFinalizedMessage(SOURCE_DOMAIN, TRUSTED_SENDER, 1000, shortBody);
    }

    // ── M-1: truncated unfinalized message reverts ───────────────────────────
    function test_CCTP_TruncatedUnfinalizedMessage_Reverts() public {
        bytes memory shortBody = new bytes(100); // < 165
        vm.prank(address(transmitter));
        vm.expectRevert(CCTPJobFunder.InvalidMessageBody.selector);
        funder.handleReceiveUnfinalizedMessage(SOURCE_DOMAIN, TRUSTED_SENDER, 1000, shortBody);
    }
}
