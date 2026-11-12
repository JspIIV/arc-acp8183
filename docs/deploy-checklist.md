# Deploy checklist: Nexus A2A v2 (Arc Mainnet)

You deploy this yourself, from your own wallet. Nothing here is run for you.
Mainnet transactions are irreversible. Rehearse on Arc Testnet first and get an
independent professional audit before putting real funds in.

## 0. What v2 changes compared with the contracts already live

| Area | v1 (live) | v2 (this repo) |
|---|---|---|
| Payouts | pushed to recipients | pulled by recipients with `withdraw()` |
| Slashed bond | pushed to client | pulled with `withdrawSlash()` |
| Admin control | single owner key | owner is a 48h timelock |
| Evaluator | client's free choice | optional ERC-8004 ValidationRegistry gate |
| Rejection | final immediately | optional dispute window with an arbiter |
| After-hook failure | could block settlement | settlement always completes |
| CCTP funding | v1, does not work | CCTPJobFunderV2, optional (section 1) |

v2 is a new deployment. v1 jobs and balances do not move. Keep v1 running until its
open jobs are settled.

## 1. Cross-chain funding (optional, off by default)

The v1 CCTPJobFunder on mainnet does not work: it assumed CCTP calls back into the
recipient after minting (it does not) and read the hook data from the wrong offset.
Do not send CCTP transfers to it.

`CCTPJobFunderV2` is the replacement. Leave `DEPLOY_CCTP` unset for a first deploy and
add it later once the rest is verified. If you do turn it on:

1. Get TokenMessengerV2 and MessageTransmitterV2 for each chain from Circle's
   published contract address page. Never copy them from memory or from chat.
2. Deploy one funder per chain: on Arc with the ACP address, and on each source chain
   with `acp = address(0)` (source only).
3. On every deployment call `setRemote(domain, remoteTokenMessenger, remoteFunder)` for
   each counterpart. Arc's CCTP domain is 26. Both sides must register each other.
4. Arc side: the funder must be an ACP trusted funder (the script does this).
5. Start with small amounts. The contract has no upgrade path: if a bug is found, burns
   that are already in flight can only be redeemed by this contract.
6. Rehearse on testnet with the real CCTP contracts before mainnet. The unit tests use
   mocks that follow Circle's documented message layout; they do not replace this.

Operational notes:
- To stop new transfers toward a domain use `setSendDisabled(domain, true)`. Do NOT clear
  a remote while burns are in flight: messages from a cleared remote can no longer be
  redeemed.
- A relayer (anyone) calls `redeemAndFund(message, attestation)` on Arc. If funding cannot
  complete (wrong budget, job not ready), the minted USDC is credited to the client's
  recovery balance. The client can then call `fundFromRecovery(jobId, expectedBudget)` or
  `recoverFunds()`.
- `destinationClient` on the source call must be an address you control on Arc. Recovery
  goes to it.
- Ownership is handed to the timelock like the other contracts. `renounceOwnership` is
  disabled on purpose.

## 2. Verify addresses yourself

Check each one on https://explorer.arc.io before you use it. I confirmed that code
exists at each address and that USDC reports 6 decimals, but I could not confirm
verified source on the explorer.

| Item | Address |
|---|---|
| Chain id | 5042 |
| RPC | https://rpc.mainnet.arc.io |
| USDC (ERC-20 view, 6 decimals) | 0x3600000000000000000000000000000000000000 |
| ERC-8004 IdentityRegistry | 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 |
| ERC-8004 ReputationRegistry | 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 |
| ERC-8004 ValidationRegistry | 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58 |

Also decide and double check:
- `TREASURY`: the address that receives the platform fee. It must be an address you
  control. A typo here sends fees to the wrong place, and it cannot be changed without
  a timelock delay.
- `TIMELOCK_PROPOSER` / `TIMELOCK_EXECUTOR`: a multisig is strongly preferred over the
  deployer key. If you leave them empty both default to the deployer key.
- Fee levels: `PLATFORM_FEE_BPS` and `EVALUATOR_FEE_BPS` (basis points, combined cap 20%).

## 3. Recommended first-deploy settings

- `DISPUTE_WINDOW=0` (disputes off). Turn them on later through the timelock once the
  design has had review. The arbiter selection is not verifiable randomness.
- Leave `ERC8004_VALIDATION_REG` unset on day one if you want any evaluator allowed.
  Set it to enable the opt-in evaluator gate.
- Keep `TIMELOCK_DELAY` at 172800 (48h) or longer. The script refuses less than 1 day.

## 4. Rehearse

```bash
cd contracts
forge test                      # expect: all tests pass

export PRIVATE_KEY=...          # use a fresh deployer key with a little USDC for gas
export TREASURY=0x...           # your fee address
export ERC8004_IDENTITY_REG=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
export ERC8004_REP_REG=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
export ERC8004_VALIDATION_REG=0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58

# Dry run on testnet first (use the testnet registry addresses from the README)
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io --broadcast -vvvv

# Dry run against mainnet WITHOUT broadcasting: simulates only
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io -vvvv
```

Never paste a private key into chat or commit it. Keep it in your shell environment.

## 5. Deploy

```bash
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast -vvvv
```

Save the printed addresses: AgenticCommerce, BondHook, ACPTimelock.

## 6. Hand ownership to the timelock

The script starts the ownership transfer. The timelock must accept it, and that goes
through the delay. Run these from the proposer account.

```bash
export TIMELOCK=0x...  ACP=0x...  BOND=0x...
export SALT=0x0000000000000000000000000000000000000000000000000000000000000001
export ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
SEL=$(cast calldata "acceptOwnership()")

# schedule both
cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $ACP  0 $SEL $ZERO $SALT 172800 --rpc-url https://rpc.mainnet.arc.io --private-key $PRIVATE_KEY
cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $BOND 0 $SEL $ZERO $SALT 172800 --rpc-url https://rpc.mainnet.arc.io --private-key $PRIVATE_KEY

# after the delay, execute both
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $ACP  0 $SEL $ZERO $SALT --rpc-url https://rpc.mainnet.arc.io --private-key $PRIVATE_KEY
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $BOND 0 $SEL $ZERO $SALT --rpc-url https://rpc.mainnet.arc.io --private-key $PRIVATE_KEY
```

Until both executions land, the deployer is still the owner. After they land, every
admin change needs a timelock proposal and the delay.

## 7. Verify on chain before announcing

Run each read and compare with what you expect.

```bash
cast call $ACP  "owner()(address)"            --rpc-url https://rpc.mainnet.arc.io   # = $TIMELOCK
cast call $BOND "owner()(address)"            --rpc-url https://rpc.mainnet.arc.io   # = $TIMELOCK
cast call $ACP  "treasury()(address)"         --rpc-url https://rpc.mainnet.arc.io   # = your fee address
cast call $ACP  "platformFeeBps()(uint256)"   --rpc-url https://rpc.mainnet.arc.io
cast call $ACP  "evaluatorFeeBps()(uint256)"  --rpc-url https://rpc.mainnet.arc.io
cast call $ACP  "hookWhitelist(address)(bool)" $BOND --rpc-url https://rpc.mainnet.arc.io  # true
cast call $ACP  "disputeWindow()(uint64)"     --rpc-url https://rpc.mainnet.arc.io   # 0 if disabled
cast call $ACP  "paymentToken()(address)"     --rpc-url https://rpc.mainnet.arc.io   # USDC
```

Then run one small end-to-end job with small amounts: create, set budget, fund, submit,
complete, and `withdraw()` for each party. Use explicit gas (at least 400000) on
`complete()` for hooked jobs.

## 8. Lock down roles

Once everything above checks out, the deployer should give up the timelock admin role so
that nobody can grant new roles outside the delay.

```bash
ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
cast send $TIMELOCK "renounceRole(bytes32,address)" $ADMIN_ROLE <deployer-address> \
  --rpc-url https://rpc.mainnet.arc.io --private-key $PRIVATE_KEY
```

## 9. Frontend

Set these in the frontend `.env`, then rebuild:

```
VITE_NETWORK=testnet   # or mainnet (read-only in the UI)
VITE_ACP_ADDRESS=<AgenticCommerce>
VITE_BOND_HOOK_ADDRESS=<BondHook>
```

The frontend ABI file does not yet include the dispute functions, `withdraw`, or the
validation gate. Add them before exposing those flows in the UI.

## 10. Known limits

- Not professionally audited.
- Dispute arbiter selection is block-data based. Treat it as a trusted-arbiter model.
- The timelock proposer and executor are only as safe as the keys behind them.
- CCTP funding (V2) has been tried on testnet against Circle's live CCTP V2 contracts (`docs/testnet-cctp.md`): the redeem path and the failure and recovery path work. Mainnet, standard (finalized) transfers and other source chains have not been tried. Remember that the ACP owner must call `setTrustedFunder` for the Arc funder or every funding falls into recovery.
