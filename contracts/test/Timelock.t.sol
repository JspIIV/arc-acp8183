// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "../src/AgenticCommerce.sol";
import "../src/BondHook.sol";
import "../src/ACPTimelock.sol";

// ---------------------------------------------------------------------------
// Minimal mock USDC for timelock tests
// ---------------------------------------------------------------------------
contract TLMockUSDC {
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
    function increaseAllowance(address sp, uint256 added) external returns (bool) {
        allowance[msg.sender][sp] += added; return true;
    }
}

// ---------------------------------------------------------------------------
// TimelockTest — verifies that admin functions on ACP and BondHook require
// the timelock delay and cannot be called directly once ownership is transferred.
// ---------------------------------------------------------------------------
contract TimelockTest is Test {

    ACPTimelock  timelock;
    AgenticCommerce acp;
    BondHook     bondHook;
    TLMockUSDC   usdc;

    address deployer  = makeAddr("deployer");   // the owner / proposer / executor
    address treasury  = makeAddr("treasury");
    address attacker  = makeAddr("attacker");
    address mockRepReg = makeAddr("repReg");
    address mockIdReg  = makeAddr("idReg");

    uint256 constant DELAY = 2 days;  // 48 h mainnet delay

    function setUp() public {
        vm.startPrank(deployer);

        usdc = new TLMockUSDC();

        // Deploy ACP and BondHook — deployer is initial owner
        acp      = new AgenticCommerce(address(usdc), treasury);
        bondHook = new BondHook(address(usdc), address(acp), mockRepReg, mockIdReg);

        // Deploy timelock: proposer=deployer, executor=deployer, admin=deployer
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = deployer;
        executors[0] = deployer;
        timelock = new ACPTimelock(DELAY, proposers, executors, deployer);

        // Transfer ownership of ACP and BondHook to timelock
        acp.transferOwnership(address(timelock));
        bondHook.transferOwnership(address(timelock));

        // Accept pending ownership (Ownable2Step requires acceptOwnership from new owner)
        vm.stopPrank();
        vm.prank(address(timelock));
        acp.acceptOwnership();
        vm.prank(address(timelock));
        bondHook.acceptOwnership();

        vm.startPrank(deployer);
        vm.stopPrank();
    }

    // ── 1. Direct owner call reverts — timelock is now the owner ────────────
    function test_DirectAdminCall_Reverts() public {
        // Deployer can no longer call setPlatformFee directly
        vm.prank(deployer);
        vm.expectRevert();
        acp.setPlatformFee(500, treasury);
    }

    // ── 2. Attacker cannot call admin functions ──────────────────────────────
    function test_Attacker_AdminCall_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert();
        acp.setPlatformFee(9_999, attacker);
    }

    // ── 3. Timelock schedule + wait + execute succeeds ──────────────────────
    function test_Timelock_ScheduleAndExecute_Succeeds() public {
        // Build the call: acp.setPlatformFee(500, treasury)
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setPlatformFee.selector,
            uint256(500),
            treasury
        );

        bytes32 salt       = bytes32(0);
        bytes32 predecessor = bytes32(0);

        // Schedule via timelock
        vm.prank(deployer);
        timelock.schedule(
            address(acp),
            0,           // value
            callData,
            predecessor,
            salt,
            DELAY
        );

        // Cannot execute before delay
        vm.prank(deployer);
        vm.expectRevert();
        timelock.execute(address(acp), 0, callData, predecessor, salt);

        // Warp past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Execute — must succeed
        vm.prank(deployer);
        timelock.execute(address(acp), 0, callData, predecessor, salt);

        // Verify fee was applied
        assertEq(acp.platformFeeBps(), 500, "platform fee updated via timelock");
    }

    // ── 4. Attacker cannot schedule ─────────────────────────────────────────
    function test_Attacker_CannotSchedule() public {
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setTreasury.selector,
            attacker
        );

        vm.prank(attacker);
        vm.expectRevert();
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32(0), DELAY);
    }

    // ── 5. Deployer can cancel a pending operation ───────────────────────────
    function test_Deployer_CanCancelPending() public {
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setTreasury.selector,
            attacker  // malicious treasury change
        );

        vm.prank(deployer);
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32(0), DELAY);

        // Cancel before delay expires
        bytes32 opId = timelock.hashOperation(address(acp), 0, callData, bytes32(0), bytes32(0));
        vm.prank(deployer);
        timelock.cancel(opId);

        // Operation is no longer pending
        assertFalse(timelock.isOperation(opId), "operation cancelled");

        // Warp and try to execute — must fail
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(deployer);
        vm.expectRevert();
        timelock.execute(address(acp), 0, callData, bytes32(0), bytes32(0));

        // Treasury unchanged
        assertEq(acp.treasury(), treasury, "treasury unchanged");
    }

    // ── 6. BondHook admin also requires timelock ─────────────────────────────
    function test_BondHook_DirectAdmin_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert();
        // BondHook has no direct admin functions beyond Ownable;
        // transferOwnership would revert since only owner (timelock) can call it
        bondHook.transferOwnership(attacker);
    }

    // ── 7. setHookWhitelist via timelock succeeds ────────────────────────────
    function test_SetHookWhitelist_ViaTimelock() public {
        address newHook = makeAddr("newHook");
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setHookWhitelist.selector,
            newHook,
            true
        );

        vm.prank(deployer);
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32("hook"), DELAY);

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(deployer);
        timelock.execute(address(acp), 0, callData, bytes32(0), bytes32("hook"));

        assertTrue(acp.hookWhitelist(newHook), "hook whitelisted via timelock");
    }

    // ── 8. setTrustedFunder via timelock succeeds ────────────────────────────
    function test_SetTrustedFunder_ViaTimelock() public {
        address newFunder = makeAddr("funder");
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setTrustedFunder.selector,
            newFunder,
            true
        );

        vm.prank(deployer);
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32("funder"), DELAY);

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(deployer);
        timelock.execute(address(acp), 0, callData, bytes32(0), bytes32("funder"));

        assertTrue(acp.trustedFunder(newFunder), "funder trusted via timelock");
    }

    // ── 9. Stolen key cannot steal treasury in under 48h ────────────────────
    // Simulates: attacker has deployer key, tries to change treasury immediately.
    // Even with the key, they must wait DELAY before execution — window to detect.
    function test_StolenKey_CannotStealTreasury_Under48h() public {
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setTreasury.selector,
            attacker
        );

        // "attacker" has the deployer key — can schedule
        vm.prank(deployer);
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32("steal"), DELAY);

        // But cannot execute until DELAY passes
        vm.warp(block.timestamp + DELAY - 1);  // 1 second short
        vm.prank(deployer);
        vm.expectRevert();
        timelock.execute(address(acp), 0, callData, bytes32(0), bytes32("steal"));

        // Treasury is still safe
        assertEq(acp.treasury(), treasury, "treasury not stolen");
    }

    // ── 10. Minimum delay cannot be bypassed ────────────────────────────────
    function test_ScheduleWithLessThanMinDelay_Reverts() public {
        bytes memory callData = abi.encodeWithSelector(
            AgenticCommerce.setTreasury.selector,
            attacker
        );

        // Try scheduling with 0 delay (less than MIN_DELAY = 2 days)
        vm.prank(deployer);
        vm.expectRevert();
        timelock.schedule(address(acp), 0, callData, bytes32(0), bytes32("fast"), 0);
    }
}
