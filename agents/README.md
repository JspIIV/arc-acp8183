# Reference agents

Three small agents that run a whole Nexus A2A job: a **client** that pays, a **provider** that
does the work, and an **evaluator** that decides. They are plain TypeScript on top of viem, so
they are easy to read and to replace with your own agent logic.

```bash
cd contracts && ./install-deps.sh && forge build      # once
cd ../agents && bun install && bun run demo:local
```

`demo:local` starts a throwaway local chain (anvil), deploys the contracts and a mock USDC,
and plays two jobs. Nothing touches a real network.

- **Scenario A:** the provider posts a bond and delivers a good summary. The evaluator checks the
  content hash against what the provider committed to onchain, approves it, and everyone
  withdraws their share (provider 9.7, evaluator 0.1, treasury 0.2 on a 10 USDC budget).
- **Scenario B:** the provider delivers something that fails the check. The evaluator rejects it,
  the client gets the budget back and the provider's locked bond is credited to the client.

The demo asserts these amounts and exits non-zero if any of them is off.

## What each agent does

| Agent | Onchain calls | Safety behaviour |
|---|---|---|
| `ClientAgent` | `createJob`, `approve`, `fund` | Refuses to fund unless the job's evaluator is the one it trusts. Approves exactly the budget and passes the budget so a changed budget reverts. |
| `ProviderAgent` | `approve`, `stakeBond`, `setBudget`, `submit` | Commits to the content by `keccak256` and publishes a URI. |
| `EvaluatorAgent` | `complete` / `reject` | Always verifies the content hash first, then runs a task-specific check. Sends hooked calls with an explicit gas limit. |

Deliverables are kept in an in-memory store in the demo. Replace `DeliverableStore` with IPFS or
any content-addressed storage; the evaluator only needs `get(uri)`.

## Running on Arc Testnet

The same agents can run against the v2 deployment on Arc Testnet (addresses in `../README.md`).
These are real transactions with test money.

```
cd agents
bun run testnet:keys    # once: writes three keys to .env.testnet (git-ignored), prints the addresses
# fund the three addresses with test USDC; gas on Arc is paid in USDC
bun run demo:testnet    # add --skip-reject to leave out the slower rejection scenario
```

What it does beyond the local demo:

- The provider gets an ERC-8004 identity from the testnet IdentityRegistry and links it to the bond
  hook, so settlement writes reputation. The run checks that the settlement transaction carries a
  `NewFeedback` event and no `ReputationSkipped` or `ReputationFailed`, and that the registry's
  entry count went up by one.
- It reads the contract settings first and says whether a rejection will be a proposal or final.
  With the current settings it is a proposal, so scenario B waits for the 600 s challenge window
  and then finalizes. Expect about ten minutes for that scenario.
- It does not run the dispute scenario: choosing an arbiter is an owner action, and the agents
  here do not hold the owner key.

Keep `.env.testnet` out of git. It holds private keys.

### A recorded run (Nov 12, 2026)

Three agents with fresh keys, 0.5 USDC budgets, the v2 testnet deployment, provider agentId 897857.

| Step | Result | Transaction |
|---|---|---|
| Job 5, good work | Approved. Provider credited 0.485 USDC, evaluator 0.005, treasury 0.01. One `NewFeedback` (+1) in the same transaction, no `ReputationSkipped` | [0x5af44d8b...](https://explorer.testnet.arc.io/tx/0x5af44d8bfa168ad6b07db758f08cc4e49fd96845c1881ff5c528256a775d4ffd) |
| Job 6, bad work | Rejected as a proposal | [0x67b32c89...](https://explorer.testnet.arc.io/tx/0x67b32c8949cffa89cd6a12dae892bd36aeb23fd7b7e842246846b3bb38e8c48c) |
| Job 6, after the 600 s window | Finalized by the client. Client credited the 0.5 USDC budget plus 0.25 USDC slashed bond | [0xb36b05a1...](https://explorer.testnet.arc.io/tx/0xb36b05a12def95d5d1966c603338c6eb8e5e848cac476a93f52a91a8c29e1bc4) |

The reputation registry showed 3 entries for the provider after the run (two approvals and one
rejection). The summary value is an average, so it prints as a whole number. An earlier run
(job 4) is not in the table: it stopped on an over-strict balance check in the script, which is fixed.

### A longer run: `loop:testnet`

`bun run loop:testnet` (add `--jobs 26 --seed 42`) runs seven agents (2 clients, 3 providers,
2 evaluators) through a mix of jobs: mostly approved, some rejected (bond slashed), a couple left to
expire. Budgets are tiny (0.02 to 0.10 USDC) and vary, and providers and evaluators take different
amounts of time. It tops the agents up from each other, moves money back from providers to clients
now and then, and writes `docs/testnet/activity.json` (every job and transaction) and
`docs/testnet-activity.md` (the numbers and a link for every step). The final statuses are read back
from the chain, not from the script's memory. These are our own agents and test money, so the
numbers are a record that the system works, not evidence of outside usage.

### CCTP V2 on testnet: `cctp:testnet`

`bun run cctp:testnet deploy | send | recover | status | report` tries `CCTPJobFunderV2` with Circle's
real CCTP V2 contracts (Base Sepolia to Arc Testnet). See `../docs/testnet-cctp.md` for the contracts,
the transactions and what the runs show. It needs the ACP owner to call `setTrustedFunder` for the Arc
funder before a funding can succeed; without that, the money is set aside for the client to recover.

## Using a Circle Agent Wallet instead of a local key

Circle Agent Wallets support Arc and can run any contract write with `circle wallet execute`
(see `skills/nexus-a2a/SKILL.md` for example commands). This package does not include a Circle
wallet adapter yet: it needs a Circle login with an emailed one-time code, which has to be done by
a person, so it has not been exercised against these contracts. The `Agent` class in `src/agent.ts`
is the single place to swap in such an adapter.

## Limits

- The demo uses a mock USDC and the well-known anvil test accounts. Do not reuse those keys anywhere real.
- The local demo runs the bond hook without ERC-8004 registries, so reputation writes are skipped there (the hook now emits `ReputationSkipped`). The Arc Testnet run records reputation for real.
- The evaluator's check is a toy rule. A real evaluator needs a check that fits the task.
