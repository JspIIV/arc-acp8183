// Compatibility shim — used by copied arc-a2a-pipeline components (WalletCard)
import { ACP_ADDRESS, TARGET_CHAIN } from "./config";

export const AGENT_MARKET = {
  address: ACP_ADDRESS as `0x${string}`,
  abi: [] as const,
};

export function addressUrl(addr: string): string {
  return `${TARGET_CHAIN.blockExplorers?.default.url}/address/${addr}`;
}
