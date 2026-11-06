// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/AgenticCommerce.sol";
import "../src/BondHook.sol";
import "../src/CCTPJobFunder.sol";
import "../src/ACPTimelock.sol";

// ---------------------------------------------------------------------------
// Deploy.s.sol: full deployment + initialization sequence.
//
// Run it yourself, from your own wallet. Read docs/deploy-checklist.md first.
//
//   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast -vvvv
//
// Required env vars:
//   PRIVATE_KEY   deployer key (becomes the temporary owner and timelock admin)
//   TREASURY      address that receives the platform fee. Use YOUR address.
//
// Optional env vars (defaults in code):
//   USDC                     Arc USDC 0x3600... (6 decimals)
//   ERC8004_IDENTITY_REG     address(0) = disabled
//   ERC8004_REP_REG          address(0) = disabled
//   ERC8004_VALIDATION_REG   address(0) = evaluator gate disabled
//   MIN_VALIDATION_SCORE     60
//   MIN_VALIDATION_COUNT     1
//   TIMELOCK_DELAY           172800 (48h)
//   TIMELOCK_PROPOSER        deployer (use a multisig!)
//   TIMELOCK_EXECUTOR        deployer (use a multisig!)
//   PLATFORM_FEE_BPS         200 (2%)
//   EVALUATOR_FEE_BPS        100 (1%)
//   DISPUTE_WINDOW           0 (disputes disabled)
//   ARBITER_DEADLINE         172800 (only used when DISPUTE_WINDOW > 0)
//   DISPUTE_DEPOSIT          0 (USDC base units, 6 decimals)
//   ARBITERS                 comma separated arbiter addresses (optional)
//   DEPLOY_CCTP              false. CCTPJobFunder is NOT safe to deploy until it is
//                            redesigned. Leave this off.
//   CCTP_TOKEN_MESSENGER     required only when DEPLOY_CCTP=true
//   CCTP_MESSAGE_TRANSMITTER required only when DEPLOY_CCTP=true
// ---------------------------------------------------------------------------

struct DeployConfig {
    address deployer;
    address usdc;
    address treasury;
    address validationReg;
    address identityReg;
    address reputationReg;
    address proposer;
    address executor;
    uint256 timelockDelay;
    uint256 platformFeeBps;
    uint256 evaluatorFeeBps;
    uint8   minValScore;
    uint64  minValCount;
    uint64  disputeWindow;
    uint64  arbiterDeadline;
    uint256 disputeDeposit;
    bool    deployCctp;
    address tokenMessenger;
    address messageTransmitter;
}

contract Deploy is Script {

    address constant USDC_ARC = 0x3600000000000000000000000000000000000000;

    function run() external {
        DeployConfig memory cfg = _loadConfig();

        require(cfg.treasury != address(0), "TREASURY not set");
        require(cfg.platformFeeBps + cfg.evaluatorFeeBps <= 2_000, "Combined fee > 20%");
        require(cfg.timelockDelay >= 1 days, "Timelock delay too short");
        if (cfg.deployCctp) {
            require(cfg.tokenMessenger     != address(0), "CCTP_TOKEN_MESSENGER not set");
            require(cfg.messageTransmitter != address(0), "CCTP_MESSAGE_TRANSMITTER not set");
        }

        console.log("Chain id:", block.chainid);
        console.log("Deployer:", cfg.deployer);
        console.log("Treasury (fee recipient):", cfg.treasury);

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        _deploy(cfg);
        vm.stopBroadcast();
    }

    function _loadConfig() internal view returns (DeployConfig memory cfg) {
        cfg.deployer          = vm.addr(vm.envUint("PRIVATE_KEY"));
        cfg.usdc              = vm.envOr("USDC", USDC_ARC);
        cfg.treasury          = vm.envAddress("TREASURY");
        cfg.validationReg     = vm.envOr("ERC8004_VALIDATION_REG", address(0));
        cfg.identityReg       = vm.envOr("ERC8004_IDENTITY_REG",   address(0));
        cfg.reputationReg     = vm.envOr("ERC8004_REP_REG",        address(0));
        cfg.proposer          = vm.envOr("TIMELOCK_PROPOSER", cfg.deployer);
        cfg.executor          = vm.envOr("TIMELOCK_EXECUTOR", cfg.deployer);
        cfg.timelockDelay     = vm.envOr("TIMELOCK_DELAY",     uint256(2 days));
        cfg.platformFeeBps    = vm.envOr("PLATFORM_FEE_BPS",   uint256(200));
        cfg.evaluatorFeeBps   = vm.envOr("EVALUATOR_FEE_BPS",  uint256(100));
        cfg.minValScore       = uint8(vm.envOr("MIN_VALIDATION_SCORE", uint256(60)));
        cfg.minValCount       = uint64(vm.envOr("MIN_VALIDATION_COUNT", uint256(1)));
        cfg.disputeWindow     = uint64(vm.envOr("DISPUTE_WINDOW",   uint256(0)));
        cfg.arbiterDeadline   = uint64(vm.envOr("ARBITER_DEADLINE", uint256(2 days)));
        cfg.disputeDeposit    = vm.envOr("DISPUTE_DEPOSIT", uint256(0));
        cfg.deployCctp        = vm.envOr("DEPLOY_CCTP", false);
        cfg.tokenMessenger    = vm.envOr("CCTP_TOKEN_MESSENGER", address(0));
        cfg.messageTransmitter = vm.envOr("CCTP_MESSAGE_TRANSMITTER", address(0));
    }

    function _deploy(DeployConfig memory cfg) internal {
        AgenticCommerce acp = new AgenticCommerce(cfg.usdc, cfg.treasury);
        console.log("AgenticCommerce:", address(acp));

        BondHook bondHook = new BondHook(cfg.usdc, address(acp), cfg.reputationReg, cfg.identityReg);
        console.log("BondHook:", address(bondHook));

        ACPTimelock timelock = _deployTimelock(cfg);
        console.log("ACPTimelock:", address(timelock));

        address cctpFunder = address(0);
        if (cfg.deployCctp) {
            cctpFunder = address(new CCTPJobFunder(
                cfg.usdc, address(acp), cfg.tokenMessenger, cfg.messageTransmitter
            ));
            console.log("CCTPJobFunder:", cctpFunder);
        }

        // The deployer is still the owner here, so all configuration happens BEFORE
        // ownership moves to the timelock. After that, every change waits for the delay.
        _configureACP(acp, bondHook, cctpFunder, cfg);
        _configureDisputes(acp, cfg);

        acp.transferOwnership(address(timelock));
        bondHook.transferOwnership(address(timelock));
        console.log("Ownership transfer started (pending acceptOwnership by the timelock)");

        _printSummary(address(acp), address(bondHook), cctpFunder, address(timelock), cfg.timelockDelay);
    }

    function _deployTimelock(DeployConfig memory cfg) internal returns (ACPTimelock) {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = cfg.proposer;
        executors[0] = cfg.executor;
        return new ACPTimelock(cfg.timelockDelay, proposers, executors, cfg.deployer);
    }

    function _configureACP(
        AgenticCommerce acp,
        BondHook        bondHook,
        address         cctpFunder,
        DeployConfig memory cfg
    ) internal {
        acp.setHookWhitelist(address(bondHook), true);
        console.log("BondHook whitelisted");

        if (cctpFunder != address(0)) {
            acp.setTrustedFunder(cctpFunder, true);
            console.log("CCTPJobFunder registered as trusted funder");
        }

        if (cfg.validationReg != address(0)) {
            acp.setValidationRegistry(cfg.validationReg, cfg.identityReg);
            acp.setValidationRequirement(cfg.minValScore, cfg.minValCount, false);
            console.log("ValidationRegistry configured (opt-in per job)");
        }

        acp.setPlatformFee(cfg.platformFeeBps, cfg.treasury);
        acp.setEvaluatorFee(cfg.evaluatorFeeBps);
        console.log("Platform fee bps:", cfg.platformFeeBps);
        console.log("Evaluator fee bps:", cfg.evaluatorFeeBps);
    }

    function _configureDisputes(AgenticCommerce acp, DeployConfig memory cfg) internal {
        address[] memory none = new address[](0);
        address[] memory arbiters = vm.envOr("ARBITERS", ",", none);
        for (uint256 i; i < arbiters.length; ++i) {
            acp.addArbiter(arbiters[i]);
        }
        acp.setDisputeConfig(cfg.disputeWindow, cfg.arbiterDeadline, cfg.disputeDeposit);
        console.log("Dispute window (s):", cfg.disputeWindow);
        console.log("Arbiters registered:", arbiters.length);
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
        console.log("A: timelock.schedule + execute acceptOwnership on AgenticCommerce");
        console.log("B: timelock.schedule + execute acceptOwnership on BondHook");
        console.log("C: renounce the timelock admin role once everything is verified");
        console.log("See docs/deploy-checklist.md");
    }
}
