# Announcement drafts

Drafts for Arc House and X. Edit the tone to your own voice before posting. Nothing here claims
traction that does not exist.

## Arc House post

**Title:** Nexus A2A: escrow, independent evaluation and bonded reputation for agents hiring agents on Arc

When one agent pays another per call (x402, nanopayments), there is no recourse if the work is
never delivered. That is fine for a $0.001 lookup. It is not fine for a job that costs real money,
needs several steps, or has to be checked before anyone is paid.

Nexus A2A is an ERC-8183 implementation on Arc that adds the missing layer:

- The client locks USDC in escrow for a job.
- The provider submits work, with a hash (and optionally a URI) of the deliverable.
- An independent evaluator approves or rejects it. Payment follows the verdict.
- Providers post a bond. Bad work costs the bond, good work builds ERC-8004 reputation.
- Payouts are credited and withdrawn by each party, so one blocked address cannot freeze everyone else.

**Where it stands, plainly**

- A first version is live on Arc Mainnet. It has only been used by me (3 test jobs).
- A second version is in the repository, with 131 passing tests: timelocked admin, ERC-8004
  evaluator checks, an optional dispute window with an arbiter, and a rebuilt CCTP V2 funder.
  It is not deployed yet.
- There has been no independent audit. Internal automated and adversarial reviews only.
  Known limitations are listed in `docs/security.md`.
- The CCTP funder has only been tested against mocks of Circle's documented message layout.

**Built for agents, not only people.** The repo ships a skill file and an `llms.txt`, so a coding
agent can read what it needs and run a whole job. The same flow works from a Circle Agent Wallet
(`circle wallet execute`), which supports Arc.

Repo: https://github.com/JspIIV/arc-acp8183
Agent skill: https://github.com/JspIIV/arc-acp8183/blob/main/skills/nexus-a2a/SKILL.md

**What I would like feedback on**

1. Evaluator trust. The client chooses the evaluator. Would you require ERC-8004 validation,
   a stake, or a registry of vetted evaluators?
2. Disputes. Is a short challenge window with a second evaluator the right weight for agent jobs?
   What window length makes sense when both sides are software?
3. Arbiter selection. Mine uses block data, which a challenger can influence. Would you use a VRF,
   a committee, or something else on Arc?
4. Where would you plug this in: as an escrow step behind Agent Marketplace services, or as a
   separate flow for larger jobs?

If you are building an agent that sells work and wants to try it on testnet, tell me what you need.

## X thread

1/ Agents can already pay each other per call on Arc. What they cannot do is get their money back when the work never shows up. I built an escrow layer for that: Nexus A2A, ERC-8183 on Arc, USDC.

2/ How it works: the client locks USDC, the provider submits work, an independent evaluator approves or rejects, and payment follows the verdict. Providers post a bond, so bad work costs something and good work builds ERC-8004 reputation.

3/ Payouts are pulled, not pushed. If one address is blocked, everyone else can still withdraw. Admin changes go through a 48h timelock. There is an optional dispute window with an arbiter.

4/ Honest status: v1 is live on Arc Mainnet and only I have used it (3 test jobs). v2 has 131 passing tests and is not deployed. No independent audit yet. Limits are written down in the repo.

5/ It is made for agents to read. There is a skill file and llms.txt, and it works from a Circle Agent Wallet. Feedback on evaluator trust and disputes welcome: https://github.com/JspIIV/arc-acp8183

## Before you post

- Do not add numbers you cannot show on chain. If you run more real jobs first, update the traction line.
- Tag the right accounts yourself (for example @buildoncircle). I have not verified any handles beyond that one.
- If v2 is deployed by then, update the status paragraph and link the addresses.
