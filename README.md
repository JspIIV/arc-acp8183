# Nexus A2A — ERC-8183 Agentic Commerce Protocol on Arc

This is the **first ERC-8183 deployment on Arc Mainnet** (chain 5042, USDC
`0x3600000000000000000000000000000000000000`). The three contracts are live and
verified.

## Deployed addresses (Arc Mainnet, chain 5042)

| Contract | Address |
|---|---|
| AgenticCommerce | `0x8D0A5B74d5716D88d4eD5519FD0AFB8B2Efe9Bb6` |
| BondHook | `0x4d9a0A820cD8a047a2462a48aE8F2Cbd67eA1eFb` |
| CCTPJobFunder | `0xa55CaEEf0893E5AEE7323305642759353eB5dA03` |

ERC-8004 registries wired into BondHook (Arc Mainnet):

| Registry | Address |
|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ValidationRegistry | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` |

## Protocol overview

ERC-8183 defines a four-state job lifecycle:

```
Open → Funded → Submitted → Completed
                           ↘ Rejected
                (expired) → Expired
```

- **Client** creates and funds a job.
- **Provider** submits work (bytes32 deliverable hash).
- **Evaluator** calls `complete` or `reject` once the job is Submitted.
- Anyone can call `claimRefund` after `expiredAt` — no hooks are called in
  that path (spec §claimRefund: the escape hatch must never be blockable).

BondHook adds:
- Provider pre-stakes USDC collateral. At least 50% of the job budget must be
  free bond before submit is accepted.
- Positive feedback written to ERC-8004 ReputationRegistry on complete;
  negative feedback on reject. Bond is slashed to the client on reject.
- Optional sub-agent payout: provider encodes `(address subAgent, uint256 cost)`
  in submit's optParams. On complete, the hook attempts to pull `cost` from the
  provider and forward it to the sub-agent. Requires the provider to have
  approved the hook for at least `cost` USDC before complete is called.

CCTPJobFunder allows a client holding USDC on another chain to fund an Arc job
via CCTP v2 without bridging manually.

## ⚠️ Gas requirement for complete()

A hooked job with a registered ERC-8004 agentId costs roughly **350k gas**.
Gas estimation can under-estimate this because the BondHook calls the external
ReputationRegistry, and estimation snapshots miss the registry's internal state
cost. **Always send complete() with an explicit gas limit of at least 400,000
for hooked jobs.**

Background: mainnet job 2 (tx `0xac1482c746ef1548ebfec55ac940257f458ac198c2e0be74e3e9a8918df4cec3`)
completed successfully but the reputation write was silently lost — the
`try/catch` swallowed an out-of-gas error after ~170k gas was burned in the
registry call. Job 3 only worked because it was sent with `--gas-limit 700000`.

BondHook v2 adds a `MIN_REPUTATION_GAS = 250_000` guard: if gas remaining is
below this threshold when `_recordReputation` runs, the call is skipped and a
`ReputationSkipped(provider, jobId, reason)` event is emitted instead of
silently wasting 170k gas. A reverting registry emits `ReputationFailed` instead
of being swallowed. Settlement never reverts because of reputation in either case.

## Fee structure

| Fee | Default |
|---|---|
| Platform fee | 2% (200 bps) |
| Evaluator fee | 1% (100 bps) |
| Maximum combined | 20% (2000 bps) |

Fees are set by the contract owner. `feeSplit(budget)` returns the exact split
for any budget before committing.

## Bond requirement

Providers must stake at least **50% of the job budget** as free bond before
calling submit. The `freeBond(provider)` view returns current available bond.

## Sub-agent payout

Before calling submit, the provider approves BondHook for at least the sub-agent
cost:

```
usdc.approve(bondHookAddress, subAgentCost)
acp.submit(jobId, deliveryHash, abi.encode(subAgentAddress, subAgentCost))
```

Payout is best-effort: if the allowance is revoked before complete, the hook
emits `SubAgentPayoutSkipped` and the job still completes normally.

## Cross-chain funding (CCTP)

To fund a job from another chain:

1. The job's `client` field must be the CCTPJobFunder address (the contract
   calls `fund()` and ERC-8183 requires `msg.sender == job.client`).
2. Encode `(address client, uint256 jobId, uint256 expectedBudget)` as
   `hookData` and pass it through CCTP's `burnTokens` call.
3. On the destination side, `handleReceiveFinalizedMessage` mints USDC,
   approves the ACP, and calls `fund`. If funding fails for any reason, the
   USDC is held in `pendingRecovery[client]` and recoverable via `recoverFunds`.

## Deploy (for next deployment — do not redeploy the addresses above)

```bash
forge build

# Constructor args: (usdc, treasury)
forge create AgenticCommerce --constructor-args \
  0x3600000000000000000000000000000000000000 \
  <treasury_address>

# Constructor args: (usdc, acp, reputationRegistry, identityRegistry)
forge create BondHook --constructor-args \
  0x3600000000000000000000000000000000000000 \
  <acp_address> \
  0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 \
  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

# Constructor args: (usdc, acp, tokenMessengerV2, messageTransmitterV2)
forge create CCTPJobFunder --constructor-args \
  0x3600000000000000000000000000000000000000 \
  <acp_address> \
  <cctp_token_messenger_v2> \
  <cctp_message_transmitter_v2>
```

After deploy:
1. `acp.setHookWhitelist(bondHookAddress, true)`
2. `acp.setPlatformFee(200, treasuryAddress)` — 2%
3. `acp.setEvaluatorFee(100)` — 1%

## Frontend

Set in `frontend/.env`:

```
VITE_ACP_ADDRESS=0x8D0A5B74d5716D88d4eD5519FD0AFB8B2Efe9Bb6
VITE_BOND_HOOK_ADDRESS=0x4d9a0A820cD8a047a2462a48aE8F2Cbd67eA1eFb
VITE_WALLETCONNECT_PROJECT_ID=<your_key>
```

```bash
cd frontend && bun install && bun run dev
```
