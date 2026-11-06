// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./AgenticCommerce.t.sol";

// ===========================================================================
// Dispute window: provider can challenge an evaluator's rejection; a second
// evaluator (arbiter) from an owner-vetted registry makes the final call.
// ===========================================================================
contract DisputeTest is ACPBase {
    address arbiter  = makeAddr("arbiter");
    address arbiter2 = makeAddr("arbiter2");

    uint64  constant WINDOW   = 1 days;
    uint64  constant DEADLINE = 2 days;
    uint256 constant DEPOSIT  = 5e6;

    // Budget 100e6, fees: platform 2% (2e6), evaluator 1% (1e6), provider 97e6.
    uint256 constant PLATFORM_FEE  = 2e6;
    uint256 constant EVALUATOR_FEE = 1e6;
    uint256 constant PROVIDER_PAY  = 97e6;

    function setUp() public override {
        super.setUp();
        // Long expiry so the dispute flow fits before the job expires.
        vm.startPrank(owner);
        acp.setDisputeConfig(WINDOW, DEADLINE, DEPOSIT);
        acp.addArbiter(arbiter);
        vm.stopPrank();

        vm.prank(provider);
        usdc.approve(address(acp), type(uint256).max);
    }

    function _submittedJob(uint256 expiryOffset) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + expiryOffset, "dispute", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");
    }

    function _proposed() internal returns (uint256 jobId) {
        jobId = _submittedJob(30 days);
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
    }

    function _challenged() internal returns (uint256 jobId) {
        jobId = _proposed();
        vm.prank(provider);
        acp.challengeRejection(jobId);
    }

    // ── Disabled by default / config ─────────────────────────────────────────

    function test_Disabled_RejectSettlesImmediately() public {
        vm.prank(owner);
        acp.setDisputeConfig(0, 0, 0);
        uint256 jobId = _submittedJob(30 days);
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(acp.owed(client), BUDGET);
    }

    function test_Config_OnlyOwner_AndBounds() public {
        vm.prank(stranger);
        vm.expectRevert();
        acp.setDisputeConfig(1 days, 1 days, 0);

        vm.startPrank(owner);
        vm.expectRevert(AgenticCommerce.InvalidDisputeConfig.selector);
        acp.setDisputeConfig(8 days, 1 days, 0);
        vm.expectRevert(AgenticCommerce.InvalidDisputeConfig.selector);
        acp.setDisputeConfig(1 days, 15 days, 0);
        vm.expectRevert(AgenticCommerce.InvalidDisputeConfig.selector);
        acp.setDisputeConfig(1 days, 0, 0);
        vm.stopPrank();
    }

    function test_Arbiter_AddRemove() public {
        vm.startPrank(owner);
        vm.expectRevert(AgenticCommerce.ArbiterAlreadyRegistered.selector);
        acp.addArbiter(arbiter);
        acp.addArbiter(arbiter2);
        assertEq(acp.arbiters().length, 2);
        acp.removeArbiter(arbiter);
        assertEq(acp.arbiters().length, 1);
        assertFalse(acp.isArbiter(arbiter));
        vm.expectRevert(AgenticCommerce.ArbiterNotRegistered.selector);
        acp.removeArbiter(arbiter);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert();
        acp.addArbiter(stranger);
    }

    // ── Proposal ─────────────────────────────────────────────────────────────

    function test_Reject_OnlyProposes_FundsStayEscrowed() public {
        uint256 jobId = _proposed();
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(acp.owed(client), 0, "no refund yet");
        AgenticCommerce.Dispute memory d = acp.getDispute(jobId);
        assertEq(uint8(d.state), uint8(AgenticCommerce.DisputeState.Proposed));
        assertEq(d.arbiter, address(0), "arbiter is not known when the evaluator proposes");
        assertEq(d.challengeEndsAt, uint64(block.timestamp) + WINDOW);
    }

    // ── Review fixes ─────────────────────────────────────────────────────────

    function test_DisableDisputes_AfterChallenge_EvaluatorCannotBypass() public {
        uint256 jobId = _challenged();
        vm.prank(owner);
        acp.setDisputeConfig(0, 0, 0);

        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.DisputePending.selector, jobId));
        acp.reject(jobId, bytes32("sneaky"), "");

        // Deposit is still recoverable through the arbiter.
        vm.prank(arbiter);
        acp.resolveDispute(jobId, false, bytes32("ok"));
        assertEq(acp.owed(provider), PROVIDER_PAY + DEPOSIT);
    }

    function test_DisableDisputes_WhileProposed_StillFinalizable() public {
        uint256 jobId = _proposed();
        vm.prank(owner);
        acp.setDisputeConfig(0, 0, 0);
        vm.warp(block.timestamp + WINDOW);
        acp.finalizeRejection(jobId);
        assertEq(acp.owed(client), BUDGET);
    }

    function test_Challenge_NoEligibleArbiterLeft_Reverts() public {
        uint256 jobId = _proposed();
        vm.prank(owner);
        acp.removeArbiter(arbiter);
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.NoEligibleArbiter.selector);
        acp.challengeRejection(jobId);
        // Rejection still finalizes: no fund lock.
        vm.warp(block.timestamp + WINDOW);
        acp.finalizeRejection(jobId);
        assertEq(acp.owed(client), BUDGET);
    }

    function test_Challenge_AssignsArbiter_NeverAParty() public {
        vm.startPrank(owner);
        acp.addArbiter(evaluator);
        acp.addArbiter(client);
        acp.addArbiter(provider);
        acp.addArbiter(arbiter2);
        vm.stopPrank();
        for (uint256 i; i < 8; ++i) {
            uint256 jobId = _proposed();
            vm.roll(block.number + 1 + i);
            vm.prank(provider);
            acp.challengeRejection(jobId);
            address a = acp.getDispute(jobId).arbiter;
            assertTrue(a == arbiter || a == arbiter2, "arbiter must not be a party");
        }
    }

    function test_Reject_Twice_WhilePending_Reverts() public {
        uint256 jobId = _proposed();
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.DisputePending.selector, jobId));
        acp.reject(jobId, bytes32("again"), "");
    }

    function test_NoEligibleArbiter_RejectsImmediately() public {
        // Registry only contains the evaluator itself, who is a party to the job.
        vm.startPrank(owner);
        acp.removeArbiter(arbiter);
        acp.addArbiter(evaluator);
        vm.stopPrank();

        uint256 jobId = _submittedJob(30 days);
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(acp.owed(client), BUDGET);
    }

    function test_Reject_FundedJob_NotDisputable() public {
        // Evaluator rejecting before any submission has nothing to dispute.
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + 30 days, "x", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("no show"), "");
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    // ── Unchallenged: finalize ───────────────────────────────────────────────

    function test_Finalize_BeforeWindow_Reverts() public {
        uint256 jobId = _proposed();
        vm.expectRevert(AgenticCommerce.ChallengeWindowOpen.selector);
        acp.finalizeRejection(jobId);
    }

    function test_Finalize_AfterWindow_AnyoneCan_RefundsClient() public {
        uint256 jobId = _proposed();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        acp.finalizeRejection(jobId);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(acp.owed(client), BUDGET);
        assertEq(acp.owed(provider), 0);
    }

    function test_Finalize_NoProposal_Reverts() public {
        uint256 jobId = _submittedJob(30 days);
        vm.expectRevert(AgenticCommerce.NoRejectionProposed.selector);
        acp.finalizeRejection(jobId);
    }

    // ── Challenge ────────────────────────────────────────────────────────────

    function test_Challenge_TakesDeposit() public {
        uint256 before = usdc.balanceOf(provider);
        uint256 jobId = _challenged();
        assertEq(before - usdc.balanceOf(provider), DEPOSIT);
        AgenticCommerce.Dispute memory d = acp.getDispute(jobId);
        assertEq(uint8(d.state), uint8(AgenticCommerce.DisputeState.Challenged));
        assertEq(d.deposit, DEPOSIT);
        assertEq(d.rulingDeadline, uint64(block.timestamp) + DEADLINE);
    }

    function test_Challenge_OnlyProvider() public {
        uint256 jobId = _proposed();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.NotProvider.selector);
        acp.challengeRejection(jobId);
    }

    function test_Challenge_AfterWindow_Reverts() public {
        uint256 jobId = _proposed();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.ChallengeWindowClosed.selector);
        acp.challengeRejection(jobId);
    }

    function test_Challenge_Twice_Reverts() public {
        uint256 jobId = _challenged();
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.NoRejectionProposed.selector);
        acp.challengeRejection(jobId);
    }

    function test_Finalize_AfterChallenge_Reverts() public {
        uint256 jobId = _challenged();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(AgenticCommerce.NoRejectionProposed.selector);
        acp.finalizeRejection(jobId);
    }

    // ── Arbiter rules ────────────────────────────────────────────────────────

    function test_Resolve_Uphold_ClientRefunded_ArbiterGetsDeposit() public {
        uint256 jobId = _challenged();
        vm.prank(arbiter);
        acp.resolveDispute(jobId, true, bytes32("upheld"));

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(acp.owed(client), BUDGET, "client refunded");
        assertEq(acp.owed(arbiter), DEPOSIT, "arbiter earns forfeited deposit");
        assertEq(acp.owed(provider), 0, "provider loses");
    }

    function test_Resolve_Overturn_ProviderPaid_DepositReturned() public {
        uint256 jobId = _challenged();
        vm.prank(arbiter);
        acp.resolveDispute(jobId, false, bytes32("overturned"));

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(acp.owed(provider), PROVIDER_PAY + DEPOSIT, "pay + deposit back");
        assertEq(acp.owed(arbiter), EVALUATOR_FEE, "arbiter earns evaluator fee");
        assertEq(acp.owed(evaluator), 0, "wrong evaluator earns no fee");
        assertEq(acp.owed(treasury), PLATFORM_FEE);
        assertEq(acp.owed(client), 0);
        // Conservation: everything credited equals budget + deposit.
        uint256 total = acp.owed(provider) + acp.owed(arbiter) + acp.owed(treasury) + acp.owed(client) + acp.owed(evaluator);
        assertEq(total, BUDGET + DEPOSIT);
        assertEq(usdc.balanceOf(address(acp)), BUDGET + DEPOSIT, "escrow covers all credits");
    }

    function test_Resolve_NotArbiter_Reverts() public {
        uint256 jobId = _challenged();
        vm.prank(evaluator);
        vm.expectRevert(AgenticCommerce.NotArbiter.selector);
        acp.resolveDispute(jobId, true, bytes32("x"));
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.NotArbiter.selector);
        acp.resolveDispute(jobId, false, bytes32("x"));
    }

    function test_Resolve_AfterDeadline_Reverts() public {
        uint256 jobId = _challenged();
        vm.warp(block.timestamp + DEADLINE + 1);
        vm.prank(arbiter);
        vm.expectRevert(AgenticCommerce.ArbiterDeadlinePassed.selector);
        acp.resolveDispute(jobId, true, bytes32("late"));
    }

    function test_Resolve_Twice_Reverts() public {
        uint256 jobId = _challenged();
        vm.prank(arbiter);
        acp.resolveDispute(jobId, true, bytes32("a"));
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.WrongStatus.selector, IAgenticCommerce.JobStatus.Submitted, IAgenticCommerce.JobStatus.Rejected));
        acp.resolveDispute(jobId, false, bytes32("b"));
    }

    function test_RemovedArbiter_StillCanRuleAssignedDispute() public {
        uint256 jobId = _challenged();
        vm.prank(owner);
        acp.removeArbiter(arbiter);
        vm.prank(arbiter);
        acp.resolveDispute(jobId, false, bytes32("ok"));
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    // ── Arbiter no-show ──────────────────────────────────────────────────────

    function test_ArbiterTimeout_RejectionStands_DepositReturned() public {
        uint256 jobId = _challenged();
        vm.expectRevert(AgenticCommerce.ArbiterDeadlineNotPassed.selector);
        acp.settleArbiterTimeout(jobId);

        vm.warp(block.timestamp + DEADLINE + 1);
        vm.prank(stranger);
        acp.settleArbiterTimeout(jobId);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(acp.owed(client), BUDGET);
        assertEq(acp.owed(provider), DEPOSIT, "deposit returned");
    }

    // ── Evaluator interactions ───────────────────────────────────────────────

    function test_Complete_WhileChallenged_Reverts() public {
        uint256 jobId = _challenged();
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.DisputeActive.selector, jobId));
        acp.complete(jobId, bytes32("changed mind"), "");
    }

    function test_Complete_WhileProposed_EvaluatorChangesMind() public {
        uint256 jobId = _proposed();
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("changed mind"), "");
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(acp.owed(provider), PROVIDER_PAY);
        assertEq(acp.owed(evaluator), EVALUATOR_FEE);
        // Dispute is closed: cannot be finalized or challenged afterwards.
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerce.WrongStatus.selector, IAgenticCommerce.JobStatus.Submitted, IAgenticCommerce.JobStatus.Completed));
        acp.finalizeRejection(jobId);
    }

    // ── Escape hatch: expiry always refunds ──────────────────────────────────

    function test_ClaimRefund_WhileChallenged_ReturnsDeposit() public {
        uint256 jobId = _challenged();
        vm.warp(block.timestamp + 31 days);
        vm.prank(stranger);
        acp.claimRefund(jobId);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Expired));
        assertEq(acp.owed(client), BUDGET);
        assertEq(acp.owed(provider), DEPOSIT, "deposit not stuck");
        assertEq(uint8(acp.getDispute(jobId).state), uint8(AgenticCommerce.DisputeState.Resolved));
        assertEq(usdc.balanceOf(address(acp)), BUDGET + DEPOSIT);

        // Arbiter can no longer rule on a closed job.
        vm.prank(arbiter);
        vm.expectRevert();
        acp.resolveDispute(jobId, true, bytes32("late"));
    }

    function test_ClaimRefund_WhileProposed_Works() public {
        uint256 jobId = _proposed();
        vm.warp(block.timestamp + 31 days);
        acp.claimRefund(jobId);
        assertEq(acp.owed(client), BUDGET);
    }

    // ── Full money flow: everyone can withdraw, nothing stranded ─────────────

    function test_Overturn_AllPartiesWithdraw_EscrowEmpty() public {
        uint256 jobId = _challenged();
        vm.prank(arbiter);
        acp.resolveDispute(jobId, false, bytes32("overturned"));

        address[4] memory who = [provider, arbiter, treasury, client];
        for (uint256 i; i < who.length; ++i) {
            if (acp.owed(who[i]) > 0) {
                vm.prank(who[i]);
                acp.withdraw();
            }
        }
        assertEq(usdc.balanceOf(address(acp)), 0, "escrow fully distributed");
    }

    // ── Fuzz: money is conserved on both outcomes ────────────────────────────

    function testFuzz_Resolve_Conservation(bool uphold, uint96 deposit) public {
        uint256 dep = bound(uint256(deposit), 0, 1_000e6);
        vm.prank(owner);
        acp.setDisputeConfig(WINDOW, DEADLINE, dep);

        uint256 jobId = _proposed();
        vm.prank(provider);
        acp.challengeRejection(jobId);
        vm.prank(arbiter);
        acp.resolveDispute(jobId, uphold, bytes32("r"));

        uint256 total = acp.owed(provider) + acp.owed(arbiter) + acp.owed(treasury) + acp.owed(client) + acp.owed(evaluator);
        assertEq(total, BUDGET + dep);
        assertEq(usdc.balanceOf(address(acp)), BUDGET + dep);
    }
}

// ===========================================================================
// Dispute window together with the bond hook: bond is slashed or released only
// when the outcome is final.
// ===========================================================================
contract DisputeBondTest is ACPBase {
    address arbiter = makeAddr("arbiter");
    uint64  constant WINDOW   = 1 days;
    uint64  constant DEADLINE = 2 days;
    uint256 constant DEPOSIT  = 5e6;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        acp.setDisputeConfig(WINDOW, DEADLINE, DEPOSIT);
        acp.addArbiter(arbiter);
        vm.stopPrank();

        vm.startPrank(provider);
        usdc.approve(address(hook), type(uint256).max);
        usdc.approve(address(acp), type(uint256).max);
        hook.stakeBond(200e6);
        vm.stopPrank();
    }

    function _hookedSubmittedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + 30 days, "hooked", address(hook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, bytes32("deliverable"), "");
    }

    function test_Proposed_BondStaysLocked() public {
        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        assertEq(hook.bondLocked(provider), 50e6, "still locked while pending");
        assertEq(hook.slashOwed(client), 0, "not slashed yet");
    }

    function test_Finalized_BondSlashed() public {
        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        vm.warp(block.timestamp + WINDOW);
        acp.finalizeRejection(jobId);
        assertEq(hook.bondLocked(provider), 0);
        assertEq(hook.slashOwed(client), 50e6, "bond slashed to client");
    }

    function test_Upheld_BondSlashed() public {
        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        vm.prank(provider);
        acp.challengeRejection(jobId);
        vm.prank(arbiter);
        acp.resolveDispute(jobId, true, bytes32("upheld"));
        assertEq(hook.slashOwed(client), 50e6);
    }

    function test_Overturned_BondReleased_ReputationRecorded() public {
        idReg.setOwner(7, provider);
        vm.prank(provider);
        hook.registerAgentId(7);

        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        vm.prank(provider);
        acp.challengeRejection(jobId);

        uint256 repBefore = repReg.callCount();
        vm.prank(arbiter);
        acp.resolveDispute(jobId, false, bytes32("overturned"));

        assertEq(hook.bondLocked(provider), 0, "bond released");
        assertEq(hook.slashOwed(client), 0, "no slash");
        assertEq(hook.bondBalance(provider), 200e6, "bond intact");
        assertEq(repReg.callCount(), repBefore + 1, "positive feedback recorded");
    }

    function test_CompletedWithFailedHook_BondRecoverable() public {
        uint256 jobId = _hookedSubmittedJob();

        // Make the hook's afterAction fail so completion succeeds but the lock survives.
        vm.mockCallRevert(address(hook), abi.encodeWithSelector(IACPHook.afterAction.selector), "boom");
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("ok"), "");
        vm.clearMockedCalls();

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(hook.bondLocked(provider), 50e6, "lock survived the failed hook");

        // Recovery: anyone can release it; the provider can then withdraw the bond.
        hook.releaseExpiredBond(jobId);
        assertEq(hook.bondLocked(provider), 0);
        vm.prank(provider);
        hook.withdrawBond(200e6);
        assertEq(hook.bondBalance(provider), 0);
    }

    function test_NormalCompletion_NothingToRelease() public {
        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.complete(jobId, bytes32("ok"), "");
        vm.expectRevert(BondHook.NoBondLocked.selector);
        hook.releaseExpiredBond(jobId);
    }

    function test_ExpiredWhileChallenged_BondReleasable() public {
        uint256 jobId = _hookedSubmittedJob();
        vm.prank(evaluator);
        acp.reject(jobId, bytes32("bad"), "");
        vm.prank(provider);
        acp.challengeRejection(jobId);

        vm.warp(block.timestamp + 31 days);
        acp.claimRefund(jobId);
        hook.releaseExpiredBond(jobId);
        assertEq(hook.bondLocked(provider), 0);
    }
}
