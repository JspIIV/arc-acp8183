// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/AgenticCommerce.sol";
import "../src/BondHook.sol";
import "../src/CCTPJobFunder.sol";
import "../src/ACPTimelock.sol";

// ---------------------------------------------------------------------------
// Deploy.s.sol — Full ACP deployment + initialization sequence
//
// Usage:
//   forge script script/Deploy.s.sol \
//     --rpc-url $ARC_TESTNET_RPC_URL \
//     --broadcast --verify -vvvv
//
// Required env vars:
//   PRIVATE_KEY, TREASURY, CCTP_TOKEN_MESSENGER, CCTP_MESSAGE_TRANSMITTER
//
// Optional env vars (defaults in code):
//   USDC                     (default: Arc USDC 0x3600...)
//   ERC8004_VALIDATION_REG   (default: address(0) = disabled)
//   ERC8004_IDENTITY_REG     (default: address(0))
//   ERC8004_REP_REG          (default: address(0))
//   TIMELOCK_DELAY           (default: 172800 = 48h)
//   PLATFORM_FEE_BPS         (default: 200 = 2%)
//   EVALUATOR_FEE_BPS        (default: 100 = 1%)
//   MIN_VALIDATION_SCORE     (default: 60)
//   MIN_VALIDATION_COUNT     (default: 1)
// ---------------------------------------------------------------------------

struct DeployConfig {
    address deployer;
    address usdc;
    address treasury;
    address tokenMessenger;
    address messageTransmitter;
    address validationReg;
    address identityReg;
    address reputationReg;
    uint256 timelockDelay;
    uint256 platformFeeBps;
    uint256 evaluatorFeeBps;
    uint8   minValScore;
    uint64  minValCount;
}

contract Deploy is Script {

    address constant USDC_ARC = 0x3600000000000000000000000000000000000000;

    function run() external {
        DeployConfig memory cfg = _loadConfig();

        require(cfg.treasury            != address(0), "TREASURY not set");
        require(cfg.tokenMessenger      != address(0), "CCTP_TOKEN_MESSENGER not set");
        require(cfg.messageTransmitter  != address(0), "CCTP_MESSAGE_TRANSMITTER not set");
        require(cfg.platformFeeBps + cfg.evaluatorFeeBps <= 2_000, "Combined fee > 20%");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        _deploy(cfg);
        vm.stopBroadcast();
    }

    function _loadConfig() internal view returns (DeployConfig memory cfg) {
        cfg.deployer          = vm.addr(vm.envUint("PRIVATE_KEY"));
        cfg.usdc              = vm.envOr("USDC", USDC_ARC);
        cfg.treasury          = vm.envAddress("TREASURY");
        cfg.tokenMessenger    = vm.envAddress("CCTP_TOKEN_MESSENGER");
        cfg.messageTransmitter = vm.envAddress("CCTP_MESSAGE_TRANSMITTER");
        cfg.validationReg     = vm.envOr("ERC8004_VALIDATION_REG", address(0));
        cfg.identityReg       = vm.envOr("ERC8004_IDENTITY_REG",   address(0));
        cfg.reputationReg     = vm.envOr("ERC8004_REP_REG",         address(0));
        cfg.timelockDelay     = vm.envOr("TIMELOCK_DELAY",       uint256(2 days));
        cfg.platformFeeBps    = vm.envOr("PLATFORM_FEE_BPS",     uint256(200));
        cfg.evaluatorFeeBps   = vm.envOr("EVALUATOR_FEE_BPS",    uint256(100));
        cfg.minValScore       = uint8(vm.envOr("MIN_VALIDATION_SCORE", uint256(60)));
        cfg.minValCount       = uint64(vm.envOr("MIN_VALIDATION_COUNT", uint256(1)));
    }

    function _deploy(DeployConfig memory cfg) internal {
        // Step 1: AgenticCommerce
        AgenticCommerce acp = new AgenticCommerce(cfg.usdc, cfg.treasury);
        console.log("AgenticCommerce:", address(acp));

        // Step 2: BondHook
        BondHook bondHook = new BondHook(
            cfg.usdc, address(acp), cfg.reputationReg, cfg.identityReg
        );
        console.log("BondHook:", address(bondHook));

        // Step 3: CCTPJobFunder
        CCTPJobFunder cctpFunder = new CCTPJobFunder(
            cfg.usdc, address(acp), cfg.tokenMessenger, cfg.messageTransmitter
        );
        console.log("CCTPJobFunder:", address(cctpFunder));

        // Step 4: ACPTimelock
        ACPTimelock timelock = _deployTimelock(cfg.deployer, cfg.timelockDelay);
        console.log("ACPTimelock:", address(timelock));

        // Steps 5-10: configure ACP
        _configureACP(acp, bondHook, cctpFunder, cfg);

        // Steps 11-12: transfer ownership to timelock (pending — requires accept)
        acp.transferOwnership(address(timelock));
        bondHook.transferOwnership(address(timelock));
        console.log("Ownership transferred to timelock (pending acceptOwnership)");

        // Print summary
        _printSummary(address(acp), address(bondHook), address(cctpFunder), address(timelock), cfg.timelockDelay);
    }

    function _deployTimelock(address deployer, uint256 delay) internal returns (ACPTimelock) {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = deployer;
        executors[0] = deployer;
        return new ACPTimelock(delay, proposers, executors, deployer);
    }

    function _configureACP(
        AgenticCommerce acp,
        BondHook        bondHook,
        CCTPJobFunder   cctpFunder,
        DeployConfig memory cfg
    ) internal {
        // Step 5: whitelist BondHook
        acp.setHookWhitelist(address(bondHook), true);
        console.log("BondHook whitelisted");

        // Step 6: trusted funder
        acp.setTrustedFunder(address(cctpFunder), true);
        console.log("CCTPJobFunder trusted funder registered");

        // Step 8: ValidationRegistry (if provided)
        if (cfg.validationReg != address(0)) {
            acp.setValidationRegistry(cfg.validationReg, cfg.identityReg);
            acp.setValidationRequirement(cfg.minValScore, cfg.minValCount, false);
            console.log("ValidationRegistry configured (opt-in mode)");
        }

        // Step 10: fees
        acp.setPlatformFee(cfg.platformFeeBps, cfg.treasury);
        acp.setEvaluatorFee(cfg.evaluatorFeeBps);
        console.log("Fees configured. PlatformBps:", cfg.platformFeeBps);
    }

    function _printSummary(
        address acp,
        address bondHook,
        address cctpFunder,
        address timelock,
        uint256 delay
    ) internal pure {
        console.log("=== DEPLOYED ===");
        console.log("AgenticCommerce:", acp);
        console.log("BondHook:       ", bondHook);
        console.log("CCTPJobFunder:  ", cctpFunder);
        console.log("ACPTimelock:    ", timelock);
        console.log("Timelock delay (s):", delay);
        console.log("=== NEXT STEPS ===");
        console.log("A: schedule + execute acceptOwnership for ACP via timelock");
        console.log("B: schedule + execute acceptOwnership for BondHook via timelock");
        console.log("C: call cctpFunder.setTrustedRemote per CCTP route");
        console.log("D: (optional) renounce DEFAULT_ADMIN_ROLE on timelock");
    }
}
