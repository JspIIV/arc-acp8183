/**
 * PayoutsPanel: pull-payment balances.
 *
 * v2 contracts never push USDC to a recipient. Settlement credits a balance and
 * the recipient withdraws it. Two separate balances exist:
 *   - AgenticCommerce.owed(addr)   -> escrow payouts, refunds, evaluator fees, dispute deposits
 *   - BondHook.slashOwed(addr)     -> slashed provider bond credited to the client
 */
import { useEffect } from "react";
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Loader2, ExternalLink, ArrowDownToLine } from "lucide-react";
import { toast } from "sonner";
import { ACP_ADDRESS, BOND_HOOK_ADDRESS, ARC_CHAIN_ID, TARGET_CHAIN } from "../config";
import { ACP_ABI, BOND_HOOK_ABI } from "../abis";
import { fmtUsdc } from "../utils";

const ZERO = "0x0000000000000000000000000000000000000000";
const isSet = (a: string) => a.toLowerCase() !== ZERO;

function errorText(err: unknown): string {
  const m = (err as { message?: string } | null)?.message?.toLowerCase() ?? "";
  if (m.includes("user rejected") || m.includes("denied")) return "Transaction cancelled.";
  if (m.includes("nothingtowithdraw")) return "Nothing to withdraw.";
  if (m.includes("insufficient funds")) return "Not enough USDC for gas.";
  return "Withdrawal failed. Please try again.";
}

function PayoutRow({ label, hint, amount, loading, unavailable, onWithdraw, busy, confirming, wrongChain }: {
  label: string;
  hint: string;
  amount: bigint | undefined;
  loading: boolean;
  unavailable: boolean;
  onWithdraw: () => void;
  busy: boolean;
  confirming: boolean;
  wrongChain: boolean;
}) {
  const hasFunds = (amount ?? 0n) > 0n;
  return (
    <div style={{ background: "rgba(15,32,53,0.6)", border: "1px solid #0f2035", borderRadius: 6, padding: "8px 10px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 9, letterSpacing: 1.2, color: "#4b6a8a", fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: hasFunds ? "#8dd89f" : "#7a94b0", fontVariantNumeric: "tabular-nums" }}>
          {unavailable ? "n/a" : loading ? "..." : fmtUsdc(amount ?? 0n)}
          <span style={{ fontSize: 9, color: "#4b6a8a", marginLeft: 4 }}>USDC</span>
        </span>
      </div>
      <div style={{ fontSize: 9, color: "#4b6a8a", margin: "3px 0 6px", lineHeight: 1.4 }}>
        {unavailable ? "Not available on the connected deployment." : hint}
      </div>
      <button
        onClick={onWithdraw}
        disabled={unavailable || busy || confirming || (!wrongChain && !hasFunds)}
        style={{
          width: "100%", minHeight: 32, borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          background: hasFunds || wrongChain ? "#acc6e9" : "transparent",
          color: hasFunds || wrongChain ? "#050c17" : "#4b6a8a",
          border: hasFunds || wrongChain ? "none" : "1px solid #0f2035",
          opacity: unavailable || busy || confirming ? 0.6 : 1,
        }}
      >
        {busy ? <><Loader2 size={12} className="animate-spin" /> CONFIRM IN WALLET</>
          : confirming ? <><Loader2 size={12} className="animate-spin" /> CONFIRMING</>
          : wrongChain ? "SWITCH TO ARC"
          : <><ArrowDownToLine size={12} /> WITHDRAW</>}
      </button>
    </div>
  );
}

export function PayoutsPanel() {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID;

  const acpOn = isSet(ACP_ADDRESS);
  const hookOn = isSet(BOND_HOOK_ADDRESS);
  const who = address ?? ZERO;

  const owed = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "owed", args: [who as `0x${string}`],
    chainId: ARC_CHAIN_ID, query: { enabled: acpOn && !!address, refetchInterval: 15_000 },
  });
  const slash = useReadContract({
    address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "slashOwed", args: [who as `0x${string}`],
    chainId: ARC_CHAIN_ID, query: { enabled: hookOn && !!address, refetchInterval: 15_000 },
  });

  const acpTx = useWriteContract();
  const hookTx = useWriteContract();
  const acpReceipt = useWaitForTransactionReceipt({ hash: acpTx.data });
  const hookReceipt = useWaitForTransactionReceipt({ hash: hookTx.data });

  useEffect(() => {
    if (acpReceipt.isSuccess) { toast.success("Payout withdrawn"); void owed.refetch(); }
  }, [acpReceipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (hookReceipt.isSuccess) { toast.success("Slashed bond withdrawn"); void slash.refetch(); }
  }, [hookReceipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (acpTx.error) toast.error(errorText(acpTx.error)); }, [acpTx.error]);
  useEffect(() => { if (hookTx.error) toast.error(errorText(hookTx.error)); }, [hookTx.error]);

  if (!isConnected) return null;

  const explorerTx = (h?: `0x${string}`) => (h ? `${TARGET_CHAIN.blockExplorers?.default.url}/tx/${h}` : null);
  const lastTx = explorerTx(acpReceipt.isSuccess ? acpTx.data : hookReceipt.isSuccess ? hookTx.data : undefined);

  return (
    <div style={{ padding: "8px 10px 0", flexShrink: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 2, color: "#4b6a8a", fontWeight: 700, margin: "0 2px 6px" }}>PAYOUTS</div>

      <PayoutRow
        label="ESCROW PAYOUTS"
        hint="Job payments, refunds and fees credited to you."
        amount={owed.data as bigint | undefined}
        loading={owed.isLoading}
        unavailable={!acpOn || owed.isError}
        busy={acpTx.isPending}
        confirming={acpReceipt.isLoading}
        wrongChain={wrongChain}
        onWithdraw={() => {
          if (wrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return; }
          acpTx.writeContract({ address: ACP_ADDRESS, abi: ACP_ABI, functionName: "withdraw", chainId: ARC_CHAIN_ID });
        }}
      />
      <PayoutRow
        label="SLASHED BOND"
        hint="Bond awarded to you when a provider's work was rejected."
        amount={slash.data as bigint | undefined}
        loading={slash.isLoading}
        unavailable={!hookOn || slash.isError}
        busy={hookTx.isPending}
        confirming={hookReceipt.isLoading}
        wrongChain={wrongChain}
        onWithdraw={() => {
          if (wrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return; }
          hookTx.writeContract({ address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "withdrawSlash", chainId: ARC_CHAIN_ID });
        }}
      />

      {lastTx && (
        <a href={lastTx} target="_blank" rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, color: "#acc6e9", margin: "0 2px 6px" }}>
          View last withdrawal <ExternalLink size={10} />
        </a>
      )}
    </div>
  );
}
