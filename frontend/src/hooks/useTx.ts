// Sends one transaction, waits for it, tells the user what happened and refreshes the board.

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Abi, Address, TransactionReceipt } from "viem";
import { ARC_CHAIN_ID, EXPLORER_URL, NETWORK_LABEL, WRITES_ENABLED } from "../config";

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  gas?: bigint;
}

/** A readable message for the errors people actually hit. */
export function explainError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string } | null;
  const raw = err?.shortMessage ?? err?.message ?? "Transaction failed";
  const low = raw.toLowerCase();
  if (low.includes("user rejected") || low.includes("user denied")) return "You cancelled the request in your wallet.";
  if (low.includes("insufficient funds")) return "Not enough USDC to pay for gas.";
  return raw.split("\n")[0].slice(0, 220);
}

export function useTx() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID;

  const run = useCallback(async (label: string, call: Call): Promise<TransactionReceipt | null> => {
    if (!WRITES_ENABLED) { toast.error(`Sending transactions is limited to Arc Testnet. This app is on ${NETWORK_LABEL}.`); return null; }
    if (!client) { toast.error("No connection to Arc."); return null; }
    setBusy(label);
    const id = toast.loading(`${label}…`);
    try {
      if (wrongChain) await switchChainAsync({ chainId: ARC_CHAIN_ID });
      const hash = await writeContractAsync({ ...call, chainId: ARC_CHAIN_ID } as Parameters<typeof writeContractAsync>[0]);
      toast.loading(`${label}: waiting for confirmation…`, { id });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction was included but reverted.");
      toast.success(`${label}: done`, {
        id,
        action: { label: "View", onClick: () => window.open(`${EXPLORER_URL}/tx/${hash}`, "_blank", "noopener") },
      });
      void qc.invalidateQueries();
      return receipt;
    } catch (e) {
      toast.error(`${label}: ${explainError(e)}`, { id });
      return null;
    } finally {
      setBusy(null);
    }
  }, [client, qc, switchChainAsync, writeContractAsync, wrongChain]);

  return { run, busy, address, isConnected, wrongChain };
}

/** Unix seconds, refreshed on an interval so time-based actions appear when they unlock. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
