// Arc Testnet facts shared by the testnet runners. The addresses are public and also
// listed in ../README.md (v2 rehearsal deployment).
import { defineChain, type Address } from "viem";
import type { Deployment } from "./roles";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
});

export const D: Deployment = {
  usdc: "0x3600000000000000000000000000000000000000",
  acp: "0x557dC9bc9f401b319A1606D039B4FE1B5AC27971",
  hook: "0x7BD7eFe65c9787761502398fd272385A356c9AfE",
};
export const IDENTITY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const REPUTATION: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

export const explorerTx = (hash: string) => `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: string) => `${arcTestnet.blockExplorers.default.url}/address/${a}`;
