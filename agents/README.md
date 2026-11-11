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

## Using a Circle Agent Wallet instead of a local key

Circle Agent Wallets support Arc and can run any contract write with `circle wallet execute`
(see `skills/nexus-a2a/SKILL.md` for example commands). This package does not include a Circle
wallet adapter yet: it needs a Circle login with an emailed one-time code, which has to be done by
a person, so it has not been exercised against these contracts. The `Agent` class in `src/agent.ts`
is the single place to swap in such an adapter.

## Limits

- The demo uses a mock USDC and the well-known anvil test accounts. Do not reuse those keys anywhere real.
- The bond hook runs without ERC-8004 registries here (reputation writes are skipped).
- The evaluator's check is a toy rule. A real evaluator needs a check that fits the task.
