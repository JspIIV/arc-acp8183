// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/governance/TimelockController.sol";

// ---------------------------------------------------------------------------
// ACPTimelock — owner governance wrapper for AgenticCommerce and BondHook
//
// All privileged admin calls on ACP and BondHook (setPlatformFee, setEvaluatorFee,
// setHookWhitelist, setTrustedFunder, setTreasury, setTrustedRemote) must go
// through this timelock. This prevents instant-rug attacks: a stolen deployer
// key cannot drain treasury or whitelist a malicious hook without waiting for
// the MIN_DELAY window, during which any watcher can detect and respond.
//
// Roles (set at deploy time, cannot be changed without another timelock proposal):
//   PROPOSER_ROLE  — the deployer/owner address (you). Only you can schedule ops.
//   EXECUTOR_ROLE  — the deployer/owner address (you). Only you can execute after delay.
//   CANCELLER_ROLE — the deployer/owner address (you). You can cancel pending ops.
//   DEFAULT_ADMIN  — address(0) after renounce. No one can grant roles post-deploy.
//
// MIN_DELAY: 48 hours on mainnet. Use 0 for local tests.
//
// Usage:
//   1. Deploy ACPTimelock(48 hours, [owner], [owner], owner).
//   2. Call acp.transferOwnership(address(timelock)).
//   3. Call bondHook.transferOwnership(address(timelock)).
//   4. To change a param: schedule via timelock.schedule(), wait MIN_DELAY, execute.
//
// Emergency:
//   The deployer can cancel any pending operation before it executes via
//   timelock.cancel(id). There is no emergency bypass — this is intentional.
//   A genuinely urgent fix (e.g. hook exploit) should be handled by scheduling
//   with MIN_DELAY = 0 only on a fresh fork where you control the timestamp,
//   or by deploying a new ACP instance.
// ---------------------------------------------------------------------------
contract ACPTimelock is TimelockController {
    /// @param minDelay   Seconds before a scheduled op can execute. Use 48 hours on mainnet.
    /// @param proposers  Addresses that can schedule ops. Pass [ownerAddress].
    /// @param executors  Addresses that can execute after delay. Pass [ownerAddress].
    /// @param admin      Address that receives DEFAULT_ADMIN_ROLE.
    ///                   Pass ownerAddress; then call renounceRole(DEFAULT_ADMIN_ROLE, ownerAddress)
    ///                   via the timelock after setup to fully lock down role management.
    constructor(
        uint256        minDelay,
        address[] memory proposers,
        address[] memory executors,
        address        admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
