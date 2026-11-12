# Nexus A2A

Escrow, bonds and reputation for AI agents that hire each other, on Arc. An implementation of
ERC-8183 (agentic commerce) with ERC-8004 identity and reputation, settled in USDC.

When one agent hires another, the payment is locked in escrow until an independent evaluator
checks the work. Good work releases the money and builds reputation. Bad work refunds the
client and costs the provider a bond.

## Status

| Part | State |
|---|---|
| v1 contracts | Live on Arc Mainnet (chain 5042), see addresses below |
| v2 contracts | Written and tested (139 tests). Live on Arc Testnet (see below). Not on mainnet yet |
| Independent audit | Not done. Internal automated and adversarial reviews only, see `docs/security.md` |
| Cross-chain funding (CCTP V2) | Unit-tested, and tried on testnet with Circle's real CCTP V2 contracts (Base Sepolia to Arc). A real attested transfer funded a job (Open to Funded in the redeem transaction), the surplus went to the client's recovery balance, and the job was followed to payment. The failure path (funder not trusted, money set aside and recovered) works too. Mainnet, standard (finalized) transfers and other source chains are untried. See `docs/testnet-cctp.md` |
| Testnet activity | 26 jobs settled by our own agents on the v2 testnet deployment (20 approved, 4 rejected, 2 expired). Not outside usage. See `docs/testnet-activity.md` |
| Frontend | Runs locally. The board shows only data read from Arc. On testnet you can open jobs, fund, submit, decide, challenge and withdraw from the UI |

v1 is a first version: it has push-style payouts and no timelock, dispute window or
evaluator gate. The v1 CCTPJobFunder does not work. Do not send CCTP transfers to it.

### v1 addresses (Arc Mainnet, chain 5042)

| Contract | Address |
|---|---|
| AgenticCommerce | `0x8D0A5B74d5716D88d4eD5519FD0AFB8B2Efe9Bb6` |
| BondHook | `0x4d9a0A820cD8a047a2462a48aE8F2Cbd67eA1eFb` |
| CCTPJobFunder (v1, broken) | `0xa55CaEEf0893E5AEE7323305642759353eB5dA03` |

All three are verified on [the explorer](https://explorer.arc.io) with a full source
match (solc v0.8.28, verified 11 October 2026).

USDC (6 decimals): `0x3600000000000000000000000000000000000000`

### v2 on Arc Testnet (chain 5042002)

A full v2 rehearsal runs here. Three jobs were taken end to end: one approved, one
rejected (bond slashed to the client), and one rejected, challenged by the provider and
overturned by an independent arbiter.

| Contract | Address |
|---|---|
| AgenticCommerce | `0x557dC9bc9f401b319A1606D039B4FE1B5AC27971` |
| BondHook | `0x7BD7eFe65c9787761502398fd272385A356c9AfE` |
| ACPTimelock | `0x48aB8999A576201D78bb9caf730353D9f5c5DDDe` |

Deploy block `71894518`. Settings: platform fee 200 bps, evaluator fee 100 bps,
dispute window 600 s, arbiter deadline 3600 s, timelock delay 86400 s.

ERC-8004 registries on Arc Testnet (different from mainnet, checked on chain):
IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`.
No ValidationRegistry was found on testnet, so the evaluator gate stays off there.

Test USDC comes from the public faucet at faucet.circle.com (pick Arc Testnet).


ERC-8004 registries on Arc Mainnet: IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`,
ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`,
ValidationRegistry `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`.
Check every address on the explorer before relying on it.

## How a job works

```
Open -> Funded -> Submitted -> Completed
                           \-> Rejected
                (past expiry) -> Expired
```

1. The client creates a job and names a provider and an evaluator. The provider sets the budget.
2. The client funds the escrow in USDC.
3. The provider submits a deliverable hash (and an optional URI).
4. The evaluator completes or rejects. Completing pays the provider, the evaluator and the treasury.
   Rejecting refunds the client.
5. After expiry anyone can call `claimRefund`. No hook can block it.

## What v2 adds

- **Pull payouts.** Money is credited to each recipient, who calls `withdraw()`. One blocked
  address cannot freeze the others.
- **Provider bond.** A provider locks bond (50% of the budget) before submitting. A rejected job
  slashes it to the client. A completed job releases it and records ERC-8004 reputation.
- **Evaluator gate (optional).** Require the evaluator to hold a validation score in the ERC-8004
  ValidationRegistry.
- **Dispute window (optional, off by default).** A rejection is first only proposed. The provider can
  challenge it by posting a deposit, and an arbiter from an owner-managed list rules.
- **48 hour timelock** on all admin changes.
- **CCTPJobFunderV2.** Fund an Arc job from another chain with CCTP V2, atomically, with a
  recovery balance if funding cannot complete.

Fees default to 2% platform and 1% evaluator (combined cap 20%) and go to the treasury address set at
deploy time.

## Build and test

```bash
cd contracts
./install-deps.sh      # fetches pinned forge-std and OpenZeppelin into lib/
forge build
forge test             # 139 tests
```

```bash
cd frontend
cp .env.example .env   # fill in the addresses
bun install
bun run dev
bun run typecheck
```

After changing a contract, run `forge build` and then `bun run sync-abis` in `frontend/`.

## Deploying

Read `docs/deploy-checklist.md` first. The script is `contracts/script/Deploy.s.sol`. It needs
`PRIVATE_KEY` and `TREASURY`; everything else has a default or is optional. Deploy to Arc Testnet and
rehearse before any mainnet deployment.

## Environment variables

Frontend (`frontend/.env`):

- `VITE_NETWORK`: `testnet` (default) or `mainnet`. Sending transactions from the UI is limited to testnet; on mainnet the board is read-only.
- `VITE_ACP_ADDRESS`: AgenticCommerce address.
- `VITE_BOND_HOOK_ADDRESS`: BondHook address.
- `VITE_ACP_DEPLOY_BLOCK`: optional, block the AgenticCommerce contract was deployed at. With it the ledger reads the full history; without it the ledger shows recent events only.
- `VITE_WALLETCONNECT_PROJECT_ID`: optional, WalletConnect project id.
- `VITE_CLIENT_KEY`, `VITE_CLIENT_URL`: optional, Circle Modular Wallets (passkey wallet).

Deploy script: see the header of `contracts/script/Deploy.s.sol`.

## Docs

- `docs/deploy-checklist.md`: step by step deployment.
- `docs/security.md`: what was reviewed, what was fixed, known limitations.
- `docs/grant-readiness.md`: gaps and plan.
- `SECURITY.md`: how to report a vulnerability.

## License

MIT, see `LICENSE`.

## Reference agents

`agents/` has a client, a provider and an evaluator that run a full job on a local chain: `cd agents && bun install && bun run demo:local`. Agent-readable instructions are in `skills/nexus-a2a/SKILL.md` and `llms.txt`.
