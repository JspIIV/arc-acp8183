# CCTP V2 on testnet

`CCTPJobFunderV2` against Circle's real CCTP V2 contracts: a burn on Base Sepolia (domain 6) mints on Arc Testnet (domain 26) and the funder tries to fund an ERC-8183 job in the same transaction.

Generated from `docs/testnet/cctp.json` by `bun run cctp:testnet report`. Test money only.

## Contracts

| | Address |
|---|---|
| Arc Testnet funder (acp = the v2 testnet ACP) | `0xa5371d72cc299308bfe7202f3b622295ea301655` |
| Base Sepolia funder (acp = address(0), burn side only) | `0xa5371d72cc299308bfe7202f3b622295ea301655` |
| TokenMessengerV2 (both chains) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 (both chains) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

The two Circle addresses come from Circle's contract addresses page (Testnet section). Both funders share one address because the same key deployed them with the same nonce on both chains. The owner of both funders is a test key held by the project's agents, not a production owner.

## Deployment

- deploy Arc funder: [0xb7cf8e4c](https://explorer.testnet.arc.io/tx/0xb7cf8e4c13d34ef2280aa5d6b35d6636cdf2f1abe97df55b9199ce73d2c1a95e)
- deploy Base Sepolia funder: [0x49bed5f8](https://sepolia.basescan.org/tx/0x49bed5f86c24a2f1d8b88666453ae5bbd2f4b23910aa662e7bee330743b7fa5f)
- Arc funder setRemote(6): [0x0a27c781](https://explorer.testnet.arc.io/tx/0x0a27c781364e38fa504b470d3d11edcb9054f6a3b4ce0f4a4d30781670d3b5e5)
- Base funder setRemote(26): [0xd0b0cd6d](https://sepolia.basescan.org/tx/0xd0b0cd6d76d81bcc12f837987cf025f49f9cdf5f872fea6d89e126801c211987)

## Transfers

| Test | Funder trusted by ACP | Burn (Base Sepolia) | Redeem (Arc) | Recovery (Arc) | Outcome |
|---|---|---|---|---|---|
| untrusted funder (failure path) | no | [0x707974fe](https://sepolia.basescan.org/tx/0x707974fe2709b01c3fd059b8f97820db3574fc12a26df55b73fb067e4803569f) | [0x8b8523d5](https://explorer.testnet.arc.io/tx/0x8b8523d5b178fde16ec4ce75eaf9ba067f40fec627855ae529e20220c2658112) | [0xdd92812f](https://explorer.testnet.arc.io/tx/0xdd92812f877838bc7bf3876e418f73b63dbbdd7eb22a641e52bdd80a3656868d) | funding failed, money set aside for recovery; minted 0.099987 USDC of 0.1 USDC burned, budget 0.05 USDC (job 33) |
| trusted funder (success path) | yes | [0x5dd6d51e](https://sepolia.basescan.org/tx/0x5dd6d51ed443ed1ec62fb4a449ec9d6c97a0a19c231576390a542fced89e1979) | [0xe818b9ba](https://explorer.testnet.arc.io/tx/0xe818b9ba1ee7aa0bd3eb9ff5109b7ba70506f5949f056328a7dc4d4691d15fe4) | [0x30286c18](https://explorer.testnet.arc.io/tx/0x30286c189d7cb935d70b413d8dcb437ddc6cc93a37f59803447a9a1d4cd1c9d4) | job funded; minted 0.099987 USDC of 0.1 USDC burned, budget 0.05 USDC (job 34) |

- untrusted funder (failure path): job status after: Open; recovery balance: 0 USDC -> 0.099987 USDC; recovered 0.099987 USDC; wallet 19.937167 USDC -> 20.035815 USDC (gas is paid in USDC); left 0 USDC; cause confirmed: simulating fundOnBehalfOf from the funder's address reverts with NotTrustedFunder (0xd4cee824), because the ACP owner has not yet called setTrustedFunder for this funder
- trusted funder (success path): job status after: Funded; recovery balance: 0 USDC -> 0.049987 USDC; recovered 0.049987 USDC; wallet 20.022973 USDC -> 20.071621 USDC (gas is paid in USDC); left 0 USDC

## The success path in detail

**trusted funder (success path), job 34**

- Burned on Base Sepolia: 0.1 USDC ([burn](https://sepolia.basescan.org/tx/0x5dd6d51ed443ed1ec62fb4a449ec9d6c97a0a19c231576390a542fced89e1979))
- Minted on Arc after the fast-transfer fee: 0.099987 USDC (fee 0.000013 USDC)
- Job funded in the same transaction as the redeem ([redeem](https://explorer.testnet.arc.io/tx/0xe818b9ba1ee7aa0bd3eb9ff5109b7ba70506f5949f056328a7dc4d4691d15fe4)): the ACP took the 0.05 USDC budget and the job went from Open to Funded
- Events in the redeem transaction: `JobFunded(34, client, 50000, 99987)` and `RecoveryCredited(client, 49987)` (amounts in 6-decimal units)
- Surplus 0.049987 USDC (minted minus budget) was credited to the client's recovery balance, then withdrawn by the client ([recovery](https://explorer.testnet.arc.io/tx/0x30286c189d7cb935d70b413d8dcb437ddc6cc93a37f59803447a9a1d4cd1c9d4))
- Followed to payment: provider submitted ([submit](https://explorer.testnet.arc.io/tx/0xae24cc8e2a7a7836ede91fd847629379c600667f4f43f94f3b993ee86fa948b0)), the evaluator approved ([decision](https://explorer.testnet.arc.io/tx/0x1c5c11619d664301d1f0a4c433215707df909533cb77f3476734cfedfc0a103a)), the provider was credited 0.0485 USDC and the job ended Completed


## What this shows and what it does not

- Shows: the message layout and field checks work against real attested messages, the fast-transfer fee is taken from the mint (burned amount minus fee is what the funder sees), redemption and funding happen in one transaction, and a failed funding leaves the money recoverable by the client.
- Does not show: mainnet behaviour, standard (finalized) transfers, other source chains, or load. The contract has no independent audit.
