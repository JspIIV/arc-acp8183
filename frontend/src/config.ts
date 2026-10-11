import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { getDefaultConfig } from "connectkit";

// Arc Mainnet — chain 5042
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.arc.io"] },
    public:  { http: ["https://rpc.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// Arc Testnet — chain 5042002, used for testing
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
    public:  { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" },
  },
});

// USDC on Arc Mainnet — same address on both mainnet and testnet
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;

// ACP contract — set after you deploy. REPLACE with your deployed address.
// This is intentionally left as a placeholder to prevent accidental mainnet writes.
export const ACP_ADDRESS = (import.meta.env.VITE_ACP_ADDRESS ?? "") as `0x${string}`;
export const BOND_HOOK_ADDRESS = (import.meta.env.VITE_BOND_HOOK_ADDRESS ?? "") as `0x${string}`;

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [arcMainnet, arcTestnet],
    transports: {
      [arcMainnet.id]:  http("https://rpc.arc.io"),
      [arcTestnet.id]: http("https://rpc.testnet.arc.io"),
    },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "",
    appName: "ACP — Agentic Commerce Protocol",
    appDescription: "ERC-8183 agentic job marketplace on Arc",
    appUrl: "https://acp.arc.io",
  })
);

export const TARGET_CHAIN = arcMainnet;
