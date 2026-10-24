// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/AgenticCommerce.sol";

// ---------------------------------------------------------------------------
// Mock ERC-8004 ValidationRegistry
// ---------------------------------------------------------------------------
contract MockValidationRegistry {
    struct Entry {
        uint64 count;
        uint8  avg;
    }
    mapping(uint256 => Entry) public entries;

    function setEntry(uint256 agentId, uint64 count, uint8 avg) external {
        entries[agentId] = Entry(count, avg);
    }

    function getSummary(
        uint256 agentId,
        address[] calldata,
        string calldata
    ) external view returns (uint64 count, uint8 avgResponse) {
        Entry memory e = entries[agentId];
        return (e.count, e.avg);
    }
}

// ---------------------------------------------------------------------------
// Mock ERC-8004 IdentityRegistry
// ---------------------------------------------------------------------------
contract MockIdentityRegistryGate {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        require(owners[agentId] != address(0), "not found");
        return owners[agentId];
    }
}

// ---------------------------------------------------------------------------
// Mock USDC for gate tests
// ---------------------------------------------------------------------------
contract GateMockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function increaseAllowance(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] += amt; return true;
    }
}

// ---------------------------------------------------------------------------
// ValidationGateTest
// ---------------------------------------------------------------------------
contract ValidationGateTest is Test {

    AgenticCommerce         acp;
    MockValidationRegistry  valReg;
    MockIdentityRegistryGate idReg;
    GateMockUSDC            usdc;

    address owner     = makeAddr("owner");
    address treasury  = makeAddr("treasury");
    address client    = makeAddr("client");
    address provider  = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address badEval   = makeAddr("badEval");

    uint256 constant EVAL_AGENT_ID = 42;
    uint256 constant EXPIRY_OFFSET = 1 days;

    function setUp() public {
        vm.startPrank(owner);

        usdc   = new GateMockUSDC();
        valReg = new MockValidationRegistry();
        idReg  = new MockIdentityRegistryGate();

        acp = new AgenticCommerce(address(usdc), treasury);

        // Wire validation registry — 50 avg score, 1 count minimum
        acp.setValidationRegistry(address(valReg), address(idReg));
        acp.setValidationRequirement(50, 1, false);  // opt-in mode initially

        vm.stopPrank();

        // Register evaluator's agentId in identity registry
        idReg.setOwner(EVAL_AGENT_ID, evaluator);
        // Give evaluator a passing validation score
        valReg.setEntry(EVAL_AGENT_ID, 3, 80);  // 3 validations, avg 80
    }

    // ── 1. Gate disabled (no registry): any evaluator allowed ────────────────
    function test_Gate_Disabled_AnyEvaluatorAllowed() public {
        vm.prank(owner);
        acp.setValidationRegistry(address(0), address(0));

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, badEval,
            block.timestamp + EXPIRY_OFFSET, "no gate", address(0), 0);
        assertGt(jobId, 0, "job created without gate");
    }

    // ── 2. Opt-in: agentId=0 skips check ─────────────────────────────────────
    function test_OptIn_ZeroAgentId_SkipsCheck() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, badEval,
            block.timestamp + EXPIRY_OFFSET, "no check", address(0), 0);
        assertGt(jobId, 0, "job created with agentId=0");
    }

    // ── 3. Opt-in: valid agentId passes ──────────────────────────────────────
    function test_OptIn_ValidAgentId_Passes() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "validated eval", address(0), EVAL_AGENT_ID);
        assertGt(jobId, 0, "job created with validated evaluator");
    }

    // ── 4. Opt-in: wrong agentId owner reverts ───────────────────────────────
    function test_OptIn_WrongOwner_Reverts() public {
        // agentId 42 is owned by `evaluator`, not `badEval`
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, badEval, EVAL_AGENT_ID)
        );
        acp.createJob(provider, badEval,
            block.timestamp + EXPIRY_OFFSET, "wrong owner", address(0), EVAL_AGENT_ID);
    }

    // ── 5. Opt-in: score below threshold reverts ─────────────────────────────
    function test_OptIn_ScoreBelowThreshold_Reverts() public {
        uint256 lowScoreId = 99;
        idReg.setOwner(lowScoreId, evaluator);
        valReg.setEntry(lowScoreId, 2, 30);  // avg 30 < minScore 50

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, evaluator, lowScoreId)
        );
        acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "low score", address(0), lowScoreId);
    }

    // ── 6. Opt-in: count below threshold reverts ─────────────────────────────
    function test_OptIn_CountBelowThreshold_Reverts() public {
        vm.prank(owner);
        acp.setValidationRequirement(50, 5, false);  // require >= 5 validations

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, evaluator, EVAL_AGENT_ID)
        );
        // evaluator has only 3 validations, need 5
        acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "low count", address(0), EVAL_AGENT_ID);
    }

    // ── 7. Global mode: legacy createJob (no agentId) reverts ────────────────
    function test_GlobalMode_LegacyCreateJob_Reverts() public {
        vm.prank(owner);
        acp.setValidationRequirement(50, 1, true);  // global = true

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, evaluator, 0)
        );
        acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "legacy", address(0));
    }

    // ── 8. Global mode: valid agentId passes ─────────────────────────────────
    function test_GlobalMode_ValidAgentId_Passes() public {
        vm.prank(owner);
        acp.setValidationRequirement(50, 1, true);  // global = true

        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "global validated", address(0), EVAL_AGENT_ID);
        assertGt(jobId, 0, "job created in global mode");
    }

    // ── 9. Global mode: unregistered evaluator reverts ───────────────────────
    function test_GlobalMode_UnregisteredEvaluator_Reverts() public {
        vm.prank(owner);
        acp.setValidationRequirement(50, 1, true);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, badEval, 0)
        );
        acp.createJob(provider, badEval,
            block.timestamp + EXPIRY_OFFSET, "unregistered", address(0), 0);
    }

    // ── 10. isValidatedEvaluator view is correct ──────────────────────────────
    function test_IsValidatedEvaluator_View() public view {
        assertTrue(acp.isValidatedEvaluator(evaluator, EVAL_AGENT_ID), "should be valid");
        assertFalse(acp.isValidatedEvaluator(badEval, EVAL_AGENT_ID), "wrong owner: invalid");
        assertFalse(acp.isValidatedEvaluator(evaluator, 0),            "zero agentId: invalid");
    }

    // ── 11. Registry revert treated as not validated ──────────────────────────
    function test_RegistryRevert_TreatedAsNotValidated() public {
        // agentId 999 — not registered in identity registry → ownerOf reverts
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgenticCommerce.EvaluatorNotValidated.selector, evaluator, 999)
        );
        acp.createJob(provider, evaluator,
            block.timestamp + EXPIRY_OFFSET, "unknown agentId", address(0), 999);
    }
}
