// React binding for the board's data. The reading itself lives in lib/snapshot.ts.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ACP_ADDRESS, BOND_HOOK_ADDRESS, ACP_DEPLOY_BLOCK, ARC_CHAIN_ID } from "../config";
import { norm } from "../lib/chain";
import { fetchSnapshot, EVENT_LOOKBACK_BLOCKS, type OnchainSnapshot } from "../lib/snapshot";

export { EVENT_LOOKBACK_BLOCKS };
export type { OnchainSnapshot };

const ZERO = "0x0000000000000000000000000000000000000000";
const POLL_MS = 20_000;
const CATCH_UP_MS = 4_000;

export const acpConfigured = norm(ACP_ADDRESS) !== ZERO;

export function useOnchainWorld() {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID });

  return useQuery<OnchainSnapshot>({
    queryKey: ["onchain-world", ACP_ADDRESS, BOND_HOOK_ADDRESS],
    enabled: acpConfigured && !!client,
    // While old history is still being read, come back quickly; afterwards poll slowly.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && !d.eventsComplete && !d.eventsError ? CATCH_UP_MS : POLL_MS;
    },
    staleTime: 10_000,
    queryFn: () => {
      if (!client) throw new Error("No RPC client for Arc");
      return fetchSnapshot(client, ACP_ADDRESS, BOND_HOOK_ADDRESS, { deployBlock: ACP_DEPLOY_BLOCK });
    },
  });
}
