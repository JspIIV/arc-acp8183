import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { getDefaultConfig } from "connectkit";

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

export const USDC_ADDRESS   = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS  = 6;
export const ACP_ADDRESS    = (import.meta.env.VITE_ACP_ADDRESS    ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const BOND_HOOK_ADDRESS = (import.meta.env.VITE_BOND_HOOK_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const ARC_CHAIN_ID   = arcMainnet.id;
export const TARGET_CHAIN   = arcMainnet;

// WalletConnect project ID is optional — ConnectKit works without it (injected wallets only)
const WC_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [arcMainnet, arcTestnet],
    transports: {
      [arcMainnet.id]:  http("https://rpc.arc.io"),
      [arcTestnet.id]: http("https://rpc.testnet.arc.io"),
    },
    walletConnectProjectId: WC_ID ?? "00000000000000000000000000000000",
    appName:        "Nexus A2A",
    appDescription: "ERC-8183 Agentic Commerce Protocol on Arc",
    appUrl:         "https://acp.arc.io",
  })
);
