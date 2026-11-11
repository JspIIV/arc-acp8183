# Security notes

These contracts hold escrowed USDC. Read this before trusting them with real funds.

## Review status

- No independent professional audit has been done.
- The contracts had three rounds of internal review: an automated rule-based review and a
  separate adversarial functional review, run against each major change. Findings were fixed and
  each fix has a regression test.
- The test suite has 139 tests (`forge test`). It covers the job lifecycle, fee split, access
  control, pull payouts, bond locking and slashing, the dispute window, the evaluator gate,
  the timelock and cross-chain funding.

## What the reviews found and what changed

| Area | Problem found | Fix |
|---|---|---|
| Payouts | A blocked USDC address could make complete, reject or refund revert forever | Pull payouts: credit a balance, recipient calls `withdraw()` |
| Hooks | A reverting hook could block settlement | After-hooks are wrapped so a failure emits an event and never blocks |
| Reputation | A mainnet job lost its reputation write to an out-of-gas error | Gas guard plus `ReputationSkipped` and `ReputationFailed` events |
| Sub-agent payout | Cost was capped against the budget, not the provider's net share | Capped against the net share after fees |
| Admin | One owner key could change fees, treasury and hooks instantly | Ownership moves to a 48 hour timelock |
| Evaluator | A client could appoint any friendly address as evaluator | Optional ERC-8004 validation gate |
| Bond slashing | Slashed bond was pushed to the client | Credited to a pull balance |
| Dispute window | Disabling disputes could bypass an open challenge and strand its deposit | An open proposal or challenge can never be bypassed |
| Dispute window | The evaluator could time a rejection to land on a chosen arbiter | The arbiter is assigned when the provider challenges |
| Direct funding | Paying more than the budget stranded the surplus | Exact budget required |
| Bond | A completed job whose hook failed could leave the bond locked | `releaseExpiredBond` also covers completed jobs |
| Cross-chain | v1 funder read the wrong message layout and relied on a callback CCTP does not make | Rewritten as CCTPJobFunderV2 (see below) |
| Cross-chain | A relayer could starve gas to push funds into recovery | Client can retry from the recovery balance |

## Known limitations

- **Arbiter selection is not random.** It uses block data, so the challenging party can influence
  it by choosing when to challenge. The arbiter list is owner-managed and the owner sits behind the
  timelock, which limits the damage. A VRF or a committee ruling is the proper fix.
- **Evaluator trust.** The client chooses the evaluator. The optional validation gate and dispute
  window reduce the risk but do not remove it.
- **CCTPJobFunderV2 is only tested against mocks** that follow Circle's documented message layout.
  It has not been run against the live CCTP contracts. It has no upgrade path, so burns in flight can
  only be redeemed by this contract. Start with small amounts.
- **Owner powers.** The owner (timelock) can change fees up to a 20% combined cap, change the treasury,
  whitelist hooks, register arbiters and trusted funders. All changes wait for the timelock delay.
- **v1 on mainnet** has none of the v2 protections. Its CCTP funder does not work.
- **Frontend** is not security reviewed.

## Reporting

See `SECURITY.md`.
