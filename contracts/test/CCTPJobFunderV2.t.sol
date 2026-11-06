// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./AgenticCommerce.t.sol";
import "../src/CCTPJobFunderV2.sol";

// ---------------------------------------------------------------------------
// Mocks that follow Circle's documented CCTP V2 wire format.
//   Header (148 bytes): version 0 | sourceDomain 4 | destinationDomain 8 | nonce 12 |
//     sender 44 | recipient 76 | destinationCaller 108 | minFinality 140 | finalityExecuted 144
//   Burn body (228 bytes + hook): version 0 | burnToken 4 | mintRecipient 36 | amount 68 |
//     messageSender 100 | maxFee 132 | feeExecuted 164 | expirationBlock 196 | hookData 228
// ---------------------------------------------------------------------------

/// Source-side TokenMessengerV2: records the burn and pulls the tokens.
contract MockTokenMessengerV2 {
    MockUSDC public usdc;
    uint256 public lastAmount;
    uint32  public lastDomain;
    bytes32 public lastMintRecipient;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    bytes   public lastHookData;

    constructor(MockUSDC u) { usdc = u; }

    function depositForBurnWithHook(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address,
        bytes32 destinationCaller, uint256 maxFee, uint32, bytes calldata hookData
    ) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        lastAmount = amount; lastDomain = destinationDomain; lastMintRecipient = mintRecipient;
        lastDestinationCaller = destinationCaller; lastMaxFee = maxFee; lastHookData = hookData;
    }
}

/// Destination-side MessageTransmitterV2 + TokenMessengerV2 mint, collapsed into one mock.
/// Enforces what the real contracts enforce: attestation, destinationCaller, replay protection.
contract MockTransmitterV2 {
    MockUSDC public usdc;
    address public feeRecipient = address(0xFEE);
    mapping(bytes32 => bool) public used;
    bool public returnFalse;

    constructor(MockUSDC u) { usdc = u; }

    function setReturnFalse(bool v) external { returnFalse = v; }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(keccak256(attestation) == keccak256("valid-attestation"), "bad attestation");
        bytes32 destinationCaller = bytes32(message[108:140]);
        require(destinationCaller == bytes32(0) || destinationCaller == bytes32(uint256(uint160(msg.sender))), "wrong caller");
        bytes32 nonce = bytes32(message[12:44]);
        require(!used[nonce], "nonce used");
        used[nonce] = true;
        if (returnFalse) return false;

        bytes calldata body = message[148:];
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 fee    = uint256(bytes32(body[164:196]));
        usdc.mint(mintRecipient, amount - fee);
        if (fee > 0) usdc.mint(feeRecipient, fee);
        return true;
    }
}

contract CCTPJobFunderV2Test is ACPBase {
    uint32  constant SRC_DOMAIN  = 6;    // example source domain
    uint32  constant DST_DOMAIN  = 26;   // Arc
    bytes32 constant SRC_MESSENGER = bytes32(uint256(0xAAA1));
    bytes32 constant SRC_FUNDER    = bytes32(uint256(0xBBB2));
    address constant DST_MESSENGER = address(0xD57);

    MockTransmitterV2   transmitter;
    MockTokenMessengerV2 srcMessenger;
    CCTPJobFunderV2     dest;     // on Arc, with ACP
    CCTPJobFunderV2     src;      // source chain, no ACP

    bytes constant ATTEST = "valid-attestation";
    uint256 nonceCounter;

    function setUp() public override {
        super.setUp();
        transmitter  = new MockTransmitterV2(usdc);
        srcMessenger = new MockTokenMessengerV2(usdc);

        dest = new CCTPJobFunderV2(address(usdc), address(acp), DST_MESSENGER, address(transmitter));
        src  = new CCTPJobFunderV2(address(usdc), address(0), address(srcMessenger), address(transmitter));

        vm.prank(owner);
        acp.setTrustedFunder(address(dest), true);

        dest.setRemote(SRC_DOMAIN, SRC_MESSENGER, SRC_FUNDER);
        src.setRemote(DST_DOMAIN, bytes32(uint256(uint160(DST_MESSENGER))), bytes32(uint256(uint160(address(dest)))));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _b32(address a) internal pure returns (bytes32) { return bytes32(uint256(uint160(a))); }

    function _message(
        bytes32 headerSender, bytes32 recipient, bytes32 destCaller, bytes32 mintRecipient,
        uint256 amount, bytes32 messageSender, uint256 feeExecuted, bytes memory hookData
    ) internal returns (bytes memory) {
        bytes memory header = abi.encodePacked(
            uint32(1), SRC_DOMAIN, DST_DOMAIN, bytes32(++nonceCounter),
            headerSender, recipient, destCaller, uint32(1000), uint32(1000)
        );
        bytes memory body = abi.encodePacked(
            uint32(1), bytes32(uint256(0xC0FFEE)), mintRecipient, amount,
            messageSender, uint256(0), feeExecuted, uint256(0), hookData
        );
        return bytes.concat(header, body);
    }

    function _goodMessage(uint256 jobId, uint256 amount, uint256 fee, address hookClient) internal returns (bytes memory) {
        return _message(
            SRC_MESSENGER, _b32(DST_MESSENGER), _b32(address(dest)), _b32(address(dest)),
            amount, SRC_FUNDER, fee, abi.encode(jobId, BUDGET, hookClient)
        );
    }

    function _openJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "x-chain", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
    }

    // ── happy path ───────────────────────────────────────────────────────────

    function test_Redeem_FundsJob_ExactBudget() public {
        uint256 jobId = _openJob();
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, client), ATTEST);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(usdc.balanceOf(address(acp)), BUDGET);
        assertEq(dest.pendingRecovery(client), 0);
        assertEq(dest.totalPending(), 0);
    }

    function test_Redeem_Surplus_CreditedToClient_NotStranded() public {
        uint256 jobId = _openJob();
        // Sender burned 105, a 1 USDC fast-transfer fee was taken, 104 minted, budget 100.
        dest.redeemAndFund(_goodMessage(jobId, 105e6, 1e6, client), ATTEST);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(dest.pendingRecovery(client), 4e6, "surplus recoverable");
        assertEq(dest.totalPending(), 4e6);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        dest.recoverFunds();
        assertEq(usdc.balanceOf(client) - before, 4e6);
        assertEq(dest.totalPending(), 0);
    }

    function test_Redeem_FeeEatsBudget_NoFunding_FullMintRecoverable() public {
        uint256 jobId = _openJob();
        // Burn exactly the budget, but a 1 USDC fee leaves only 99 minted.
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 1e6, client), ATTEST);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Open), "not funded");
        assertEq(dest.pendingRecovery(client), BUDGET - 1e6);
    }

    function test_Redeem_WrongClientInHook_FundingFails_RecoveryGoesToHookClient() public {
        uint256 jobId = _openJob();
        address other = makeAddr("other");
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, other), ATTEST);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Open));
        assertEq(dest.pendingRecovery(other), BUDGET);
        assertEq(usdc.allowance(address(dest), address(acp)), 0, "allowance cleared");
    }

    function test_Redeem_UnknownJob_FundsRecoverable() public {
        dest.redeemAndFund(_goodMessage(999, BUDGET, 0, client), ATTEST);
        assertEq(dest.pendingRecovery(client), BUDGET);
    }

    function test_Redeem_BudgetMoved_FundingFails_Recoverable() public {
        uint256 jobId = _openJob();
        bytes memory m = _message(
            SRC_MESSENGER, _b32(DST_MESSENGER), _b32(address(dest)), _b32(address(dest)),
            BUDGET, SRC_FUNDER, 0, abi.encode(jobId, BUDGET + 1, client)   // expectedBudget != job.budget
        );
        dest.redeemAndFund(m, ATTEST);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Open));
        assertEq(dest.pendingRecovery(client), BUDGET);
    }

    // ── authentication: every check fires BEFORE the message is redeemed ─────

    function test_Reject_UntrustedHeaderSender() public {
        uint256 jobId = _openJob();
        bytes memory m = _message(bytes32(uint256(0xDEAD)), _b32(DST_MESSENGER), _b32(address(dest)), _b32(address(dest)),
            BUDGET, SRC_FUNDER, 0, abi.encode(jobId, BUDGET, client));
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunderV2.UntrustedMessenger.selector, SRC_DOMAIN, bytes32(uint256(0xDEAD))));
        dest.redeemAndFund(m, ATTEST);
        assertEq(usdc.balanceOf(address(dest)), 0);
    }

    function test_Reject_UntrustedBurner() public {
        uint256 jobId = _openJob();
        bytes memory m = _message(SRC_MESSENGER, _b32(DST_MESSENGER), _b32(address(dest)), _b32(address(dest)),
            BUDGET, bytes32(uint256(0xBAD)), 0, abi.encode(jobId, BUDGET, client));
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunderV2.UntrustedBurner.selector, SRC_DOMAIN, bytes32(uint256(0xBAD))));
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_UnknownSourceDomain() public {
        uint256 jobId = _openJob();
        dest.setRemote(SRC_DOMAIN, bytes32(0), bytes32(0));   // disable
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunderV2.RemoteNotSet.selector, SRC_DOMAIN));
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, client), ATTEST);
    }

    function test_Reject_WrongRecipient() public {
        uint256 jobId = _openJob();
        bytes memory m = _message(SRC_MESSENGER, _b32(address(0x1234)), _b32(address(dest)), _b32(address(dest)),
            BUDGET, SRC_FUNDER, 0, abi.encode(jobId, BUDGET, client));
        vm.expectRevert(CCTPJobFunderV2.WrongRecipient.selector);
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_DestinationCallerNotThisContract() public {
        uint256 jobId = _openJob();
        // destinationCaller = 0 would let anyone redeem directly and strand the mint here.
        bytes memory m = _message(SRC_MESSENGER, _b32(DST_MESSENGER), bytes32(0), _b32(address(dest)),
            BUDGET, SRC_FUNDER, 0, abi.encode(jobId, BUDGET, client));
        vm.expectRevert(CCTPJobFunderV2.WrongDestinationCaller.selector);
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_MintRecipientNotThisContract() public {
        uint256 jobId = _openJob();
        bytes memory m = _message(SRC_MESSENGER, _b32(DST_MESSENGER), _b32(address(dest)), _b32(stranger),
            BUDGET, SRC_FUNDER, 0, abi.encode(jobId, BUDGET, client));
        vm.expectRevert(CCTPJobFunderV2.WrongMintRecipient.selector);
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_BadAttestation_Reverts() public {
        uint256 jobId = _openJob();
        vm.expectRevert("bad attestation");
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, client), "forged");
    }

    function test_Reject_Replay() public {
        uint256 jobId = _openJob();
        bytes memory m = _goodMessage(jobId, BUDGET, 0, client);
        dest.redeemAndFund(m, ATTEST);
        vm.expectRevert("nonce used");
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_ShortMessage() public {
        vm.expectRevert(CCTPJobFunderV2.MessageTooShort.selector);
        dest.redeemAndFund(new bytes(100), ATTEST);
    }

    function test_Reject_HookDataWrongLength() public {
        bytes memory m = _message(SRC_MESSENGER, _b32(DST_MESSENGER), _b32(address(dest)), _b32(address(dest)),
            BUDGET, SRC_FUNDER, 0, abi.encodePacked(new bytes(95), hex"01", new bytes(1)));   // 97 bytes
        vm.expectRevert(CCTPJobFunderV2.BadHookData.selector);
        dest.redeemAndFund(m, ATTEST);
    }

    function test_Reject_ZeroClientInHook() public {
        uint256 jobId = _openJob();
        vm.expectRevert(CCTPJobFunderV2.BadHookData.selector);
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, address(0)), ATTEST);
    }

    function test_Reject_TransmitterReturnsFalse_RevertsAtomically() public {
        uint256 jobId = _openJob();
        transmitter.setReturnFalse(true);
        vm.expectRevert(CCTPJobFunderV2.RedeemFailed.selector);
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, client), ATTEST);
    }

    function test_Reject_NoAcpOnSourceChain() public {
        vm.expectRevert(CCTPJobFunderV2.NoAcpOnThisChain.selector);
        src.redeemAndFund(new bytes(500), ATTEST);
    }

    // ── gas guard: a relayer cannot starve the funding call ──────────────────

    function test_LowGas_RevertsInsteadOfDivertingFunds() public {
        uint256 jobId = _openJob();
        bytes memory m = _goodMessage(jobId, BUDGET, 0, client);
        // Enough gas to reach the funding step, not enough to pass the guard.
        (bool ok,) = address(dest).call{gas: 450_000}(abi.encodeCall(dest.redeemAndFund, (m, ATTEST)));
        assertFalse(ok, "must revert, not divert to recovery");
        assertEq(dest.pendingRecovery(client), 0);
        assertFalse(transmitter.used(bytes32(nonceCounter)), "redeem rolled back so it can be relayed again");
        // Retry with normal gas works.
        dest.redeemAndFund(m, ATTEST);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    // ── review fixes ─────────────────────────────────────────────────────────

    function test_Renounce_Disabled() public {
        vm.expectRevert(CCTPJobFunderV2.RenounceDisabled.selector);
        dest.renounceOwnership();
    }

    function test_DisableSend_StillRedeemsInFlightBurns() public {
        uint256 jobId = _openJob();
        bytes memory m = _goodMessage(jobId, BUDGET, 0, client);

        // Owner pauses NEW burns toward Arc on the source deployment...
        src.setSendDisabled(DST_DOMAIN, true);
        usdc.mint(client, 200e6);
        vm.startPrank(client);
        usdc.approve(address(src), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunderV2.SendDisabled.selector, DST_DOMAIN));
        src.initiateJobFunding(jobId, BUDGET, BUDGET, DST_DOMAIN, client, 0, 1000);
        vm.stopPrank();

        // ...while a burn that is already in flight still redeems on the destination.
        dest.redeemAndFund(m, ATTEST);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    function test_FundFromRecovery_RetriesAfterFailedFunding() public {
        // Job has no budget yet, so redemption cannot fund it and the mint goes to recovery.
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + EXPIRY_OFFSET, "late", address(0));
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, client), ATTEST);
        assertEq(dest.pendingRecovery(client), BUDGET);

        // Provider sets the budget afterwards; the client funds from their recovered balance.
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        dest.fundFromRecovery(jobId, BUDGET);

        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(dest.pendingRecovery(client), 0);
        assertEq(dest.totalPending(), 0);
        assertEq(usdc.balanceOf(address(dest)), 0);
    }

    function test_FundFromRecovery_OnlyOwnBalance() public {
        uint256 jobId = _openJob();
        // Funds recovered by someone else cannot be used by a different account.
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, makeAddr("other")), ATTEST);
        vm.prank(client);
        vm.expectRevert(CCTPJobFunderV2.InsufficientRecovery.selector);
        dest.fundFromRecovery(jobId, BUDGET);
    }

    function test_FundFromRecovery_WrongClient_RevertsAndKeepsBalance() public {
        uint256 jobId = _openJob();
        address other = makeAddr("other");
        dest.redeemAndFund(_goodMessage(jobId, BUDGET, 0, other), ATTEST);
        // `other` has the balance but is not the job's client, so ACP refuses and nothing moves.
        vm.prank(other);
        vm.expectRevert();
        dest.fundFromRecovery(jobId, BUDGET);
        assertEq(dest.pendingRecovery(other), BUDGET);
    }

    // ── stray funds ──────────────────────────────────────────────────────────

    function test_RescueStray_NeverTouchesPendingRecovery() public {
        uint256 jobId = _openJob();
        dest.redeemAndFund(_goodMessage(jobId, 105e6, 1e6, client), ATTEST);   // 4e6 pending
        usdc.mint(address(dest), 7e6);                                         // stray

        address sink = makeAddr("sink");
        dest.rescueStray(sink);
        assertEq(usdc.balanceOf(sink), 7e6);
        assertEq(dest.pendingRecovery(client), 4e6);

        vm.prank(client);
        dest.recoverFunds();                                                   // still fully backed
        vm.expectRevert(CCTPJobFunderV2.NothingToRecover.selector);
        dest.rescueStray(sink);
    }

    function test_RescueStray_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        dest.rescueStray(stranger);
    }

    function test_Recover_NothingReverts() public {
        vm.prank(stranger);
        vm.expectRevert(CCTPJobFunderV2.NothingToRecover.selector);
        dest.recoverFunds();
    }

    // ── source side ──────────────────────────────────────────────────────────

    function test_Initiate_BindsRemoteFunder_AsMintRecipientAndCaller() public {
        usdc.mint(client, 200e6);
        vm.startPrank(client);
        usdc.approve(address(src), type(uint256).max);
        src.initiateJobFunding(7, BUDGET, 105e6, DST_DOMAIN, client, 1e6, 1000);
        vm.stopPrank();

        assertEq(srcMessenger.lastAmount(), 105e6);
        assertEq(srcMessenger.lastDomain(), DST_DOMAIN);
        assertEq(srcMessenger.lastMintRecipient(), _b32(address(dest)));
        assertEq(srcMessenger.lastDestinationCaller(), _b32(address(dest)));
        (uint256 jobId, uint256 expected, address c) = abi.decode(srcMessenger.lastHookData(), (uint256, uint256, address));
        assertEq(jobId, 7); assertEq(expected, BUDGET); assertEq(c, client);
        assertEq(usdc.allowance(address(src), address(srcMessenger)), 0, "allowance cleared");
    }

    function test_Initiate_UnregisteredDomain_Reverts() public {
        usdc.mint(client, 200e6);
        vm.startPrank(client);
        usdc.approve(address(src), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CCTPJobFunderV2.RemoteNotSet.selector, uint32(99)));
        src.initiateJobFunding(7, BUDGET, 105e6, 99, client, 1e6, 1000);
        vm.stopPrank();
    }

    function test_Initiate_ZeroAmountOrClient_Reverts() public {
        vm.expectRevert(CCTPJobFunderV2.ZeroAmount.selector);
        src.initiateJobFunding(7, BUDGET, 0, DST_DOMAIN, client, 0, 1000);
        vm.expectRevert(CCTPJobFunderV2.ZeroAddress.selector);
        src.initiateJobFunding(7, BUDGET, 1, DST_DOMAIN, address(0), 0, 1000);
    }

    /// Source burn -> relayer builds the message from what was burned -> destination funds the job.
    function test_EndToEnd_SourceBurn_ThenRedeem() public {
        uint256 jobId = _openJob();
        usdc.mint(client, 200e6);
        vm.startPrank(client);
        usdc.approve(address(src), type(uint256).max);
        src.initiateJobFunding(jobId, BUDGET, BUDGET, DST_DOMAIN, client, 0, 1000);
        vm.stopPrank();

        // What the attestation service would sign: header from the source TokenMessenger,
        // body from the burn, messageSender = the source funder that called depositForBurn.
        bytes memory m = _message(
            SRC_MESSENGER, _b32(DST_MESSENGER), srcMessenger.lastDestinationCaller(), srcMessenger.lastMintRecipient(),
            srcMessenger.lastAmount(), _b32(address(src)), 0, srcMessenger.lastHookData()
        );
        // Register the real source funder as the trusted burner for this domain.
        dest.setRemote(SRC_DOMAIN, SRC_MESSENGER, _b32(address(src)));

        dest.redeemAndFund(m, ATTEST);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IAgenticCommerce.JobStatus.Funded));
    }
}
