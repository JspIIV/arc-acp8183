/**
 * PasskeyWalletPanel — Circle Modular Wallets (ERC-4337 MSCA) ile passkey tabanlı
 * Arc Mainnet cüzdan kurulumu ve USDC transfer paneli.
 *
 * Kullanıcı ya mevcut cüzdanını bağlar (wagmi/ConnectKit) ya da burada
 * passkey ile yeni bir Circle Smart Account (MSCA) oluşturur.
 */

import { useState, useCallback, useEffect } from "react";
import {
  createPublicClient,
  parseUnits,
  formatUnits,
  type Hex,
} from "viem";
import { arc } from "viem/chains";
import {
  createBundlerClient,
  toWebAuthnAccount,
  type P256Credential,
  type SmartAccount,
} from "viem/account-abstraction";
import {
  WebAuthnMode,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  encodeTransfer,
  ContractAddress,
} from "@circle-fin/modular-wallets-core";
import { Fingerprint, LogIn, LogOut, Send, Copy, CheckCircle, Loader2, AlertTriangle } from "lucide-react";

// ─── Env ────────────────────────────────────────────────────────────────────
const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY as string | undefined;
const CLIENT_URL = import.meta.env.VITE_CLIENT_URL as string;
const USDC_DECIMALS = 6;
const CREDENTIAL_KEY = "acp_passkey_credential";

// ─── Transports ─────────────────────────────────────────────────────────────
function getTransports() {
  if (!CLIENT_KEY) return null;
  return {
    passkey: toPasskeyTransport(CLIENT_URL, CLIENT_KEY),
    modular: toModularTransport(`${CLIENT_URL}/arc`, CLIENT_KEY),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ─── Types ──────────────────────────────────────────────────────────────────
type WalletState =
  | { stage: "idle" }
  | { stage: "loading"; message: string }
  | { stage: "ready"; account: SmartAccount; address: string; balance: bigint }
  | { stage: "error"; message: string };

// ─── Main component ──────────────────────────────────────────────────────────
export function PasskeyWalletPanel() {
  const [state, setState] = useState<WalletState>({ stage: "idle" });
  const [copied, setCopied] = useState(false);
  const [username, setUsername] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // ── Restore session on mount ─────────────────────────────────────────────
  useEffect(() => {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    if (!raw) return;
    try {
      const cred: P256Credential = JSON.parse(raw);
      void resumeSession(cred);
    } catch {
      localStorage.removeItem(CREDENTIAL_KEY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resumeSession(cred: P256Credential) {
    const t = getTransports();
    if (!t) return;
    setState({ stage: "loading", message: "Restoring session…" });
    try {
      const publicClient = createPublicClient({ chain: arc, transport: t.modular });
      const account = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({ credential: cred }),
      });
      const balance = await fetchBalance(publicClient, account.address as Hex);
      setState({ stage: "ready", account, address: account.address, balance });
    } catch {
      localStorage.removeItem(CREDENTIAL_KEY);
      setState({ stage: "idle" });
    }
  }

  async function fetchBalance(client: ReturnType<typeof createPublicClient>, addr: Hex): Promise<bigint> {
    try {
      const data = await client.readContract({
        address: ContractAddress.Arc_USDC as Hex,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "balanceOf",
        args: [addr],
      });
      return data as bigint;
    } catch {
      return 0n;
    }
  }

  // ── Register ─────────────────────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    const t = getTransports();
    if (!t) { setState({ stage: "error", message: "VITE_CLIENT_KEY ayarlanmamış. Lütfen Console kurulumunu tamamla." }); return; }
    if (!username.trim()) { setState({ stage: "error", message: "Kullanıcı adı gir." }); return; }

    setState({ stage: "loading", message: "Passkey oluşturuluyor…" });
    try {
      const cred = await toWebAuthnCredential({ transport: t.passkey, mode: WebAuthnMode.Register, username: username.trim() });
      localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(cred));
      setState({ stage: "loading", message: "Smart Account açılıyor…" });
      const publicClient = createPublicClient({ chain: arc, transport: t.modular });
      const account = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({ credential: cred }),
        name: username.trim(),
      });
      const balance = await fetchBalance(publicClient, account.address as Hex);
      setState({ stage: "ready", account, address: account.address, balance });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ stage: "error", message: msg });
    }
  }, [username]);

  // ── Login ─────────────────────────────────────────────────────────────────
  const handleLogin = useCallback(async () => {
    const t = getTransports();
    if (!t) { setState({ stage: "error", message: "VITE_CLIENT_KEY ayarlanmamış." }); return; }

    setState({ stage: "loading", message: "Passkey doğrulanıyor…" });
    try {
      const cred = await toWebAuthnCredential({ transport: t.passkey, mode: WebAuthnMode.Login });
      localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(cred));
      setState({ stage: "loading", message: "Smart Account yükleniyor…" });
      const publicClient = createPublicClient({ chain: arc, transport: t.modular });
      const account = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({ credential: cred }),
      });
      const balance = await fetchBalance(publicClient, account.address as Hex);
      setState({ stage: "ready", account, address: account.address, balance });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ stage: "error", message: msg });
    }
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(() => {
    localStorage.removeItem(CREDENTIAL_KEY);
    setState({ stage: "idle" });
    setTxHash(null);
  }, []);

  // ── Send USDC ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (state.stage !== "ready") return;
    if (!sendTo.match(/^0x[0-9a-fA-F]{40}$/)) { alert("Geçersiz adres."); return; }
    const amt = parseFloat(sendAmt);
    if (isNaN(amt) || amt <= 0) { alert("Geçersiz miktar."); return; }

    setSending(true);
    setTxHash(null);
    try {
      const t = getTransports()!;
      const modularTransport = t.modular;
      const bundler = createBundlerClient({ chain: arc, transport: modularTransport });
      const amount = parseUnits(sendAmt, USDC_DECIMALS);
      const callData = encodeTransfer(sendTo as Hex, ContractAddress.Arc_USDC as Hex, amount);
      const userOpHash = await bundler.sendUserOperation({
        account: state.account,
        calls: [callData],
        paymaster: true,
      });
      const { receipt } = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
      setTxHash(receipt.transactionHash);
      setSendTo("");
      setSendAmt("");
      // Refresh balance
      const publicClient = createPublicClient({ chain: arc, transport: modularTransport });
      const newBalance = await fetchBalance(publicClient, state.address as Hex);
      setState(prev => prev.stage === "ready" ? { ...prev, balance: newBalance } : prev);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Transfer hatası: ${msg}`);
    } finally {
      setSending(false);
    }
  }, [state, sendTo, sendAmt]);

  // ── Copy address ──────────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (state.stage !== "ready") return;
    copyText(state.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [state]);

  // ── Render ────────────────────────────────────────────────────────────────
  const cardStyle: React.CSSProperties = {
    background: "rgba(13,27,47,0.92)",
    border: "1px solid #1e3a52",
    borderRadius: 12,
    padding: "20px 18px",
    marginBottom: 12,
    backdropFilter: "blur(8px)",
  };

  // Not configured
  if (!CLIENT_KEY) {
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Fingerprint size={16} color="#acc6e9" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#acc6e9", letterSpacing: 1.1, textTransform: "uppercase" }}>Passkey Wallet</span>
        </div>
        <div style={{ fontSize: 11, color: "#f59e0b", display: "flex", gap: 6, alignItems: "flex-start" }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Console kurulumu bekleniyor. Aşağıdaki talimatları tamamla.</span>
        </div>
      </div>
    );
  }

  // Error state
  if (state.stage === "error") {
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Fingerprint size={16} color="#e86d7a" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#e86d7a", letterSpacing: 1.1, textTransform: "uppercase" }}>Passkey Wallet</span>
        </div>
        <div style={{ fontSize: 11, color: "#e86d7a", marginBottom: 10 }}>{state.message}</div>
        <button
          onClick={() => setState({ stage: "idle" })}
          style={{ fontSize: 11, padding: "5px 12px", background: "#1e3a52", border: "1px solid #2a5070", borderRadius: 6, color: "#acc6e9", cursor: "pointer" }}
        >
          Tekrar dene
        </button>
      </div>
    );
  }

  // Loading state
  if (state.stage === "loading") {
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={15} color="#acc6e9" style={{ animation: "spin 1s linear infinite" }} />
          <span style={{ fontSize: 11, color: "#8ba5c2" }}>{state.message}</span>
        </div>
      </div>
    );
  }

  // Ready state
  if (state.stage === "ready") {
    const usdcBalance = formatUnits(state.balance, USDC_DECIMALS);
    return (
      <div style={cardStyle}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Fingerprint size={15} color="#8dd89f" />
            <span style={{ fontSize: 11, fontWeight: 700, color: "#8dd89f", letterSpacing: 1, textTransform: "uppercase" }}>Smart Account</span>
          </div>
          <button
            onClick={handleLogout}
            title="Çıkış"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#4b6a8a", padding: 2 }}
          >
            <LogOut size={13} />
          </button>
        </div>

        {/* Address row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#acc6e9" }}>
            {truncate(state.address)}
          </span>
          <button
            onClick={handleCopy}
            style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "#8dd89f" : "#4b6a8a", padding: 2 }}
          >
            {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
          </button>
        </div>

        {/* Balance */}
        <div style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: "#e8f0f8", fontFamily: "Space Grotesk, sans-serif", letterSpacing: "-0.02em" }}>
            {parseFloat(usdcBalance).toFixed(2)}
          </span>
          <span style={{ fontSize: 11, color: "#4b6a8a", marginLeft: 5, fontWeight: 600 }}>USDC</span>
        </div>

        {/* Send form */}
        <div style={{ borderTop: "1px solid #1e3a52", paddingTop: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4b6a8a", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>
            USDC Gönder
          </div>
          <input
            placeholder="0x alıcı adres"
            value={sendTo}
            onChange={e => setSendTo(e.target.value)}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "#091624", border: "1px solid #1e3a52", borderRadius: 7,
              color: "#e8f0f8", fontSize: 11, padding: "7px 10px", marginBottom: 6,
              fontFamily: "JetBrains Mono, monospace", outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="Miktar"
              type="number"
              min="0"
              step="any"
              value={sendAmt}
              onChange={e => setSendAmt(e.target.value)}
              style={{
                flex: 1,
                background: "#091624", border: "1px solid #1e3a52", borderRadius: 7,
                color: "#e8f0f8", fontSize: 12, padding: "7px 10px",
                fontFamily: "Space Grotesk, sans-serif", outline: "none",
              }}
            />
            <button
              onClick={handleSend}
              disabled={sending || !sendTo || !sendAmt}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: sending ? "#1e3a52" : "#acc6e9",
                color: "#0d1b2f", border: "none", borderRadius: 7,
                padding: "7px 14px", fontSize: 11, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer",
                opacity: !sendTo || !sendAmt ? 0.5 : 1,
              }}
            >
              {sending ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={13} />}
              {sending ? "…" : "Gönder"}
            </button>
          </div>

          {/* Tx result */}
          {txHash && (
            <div style={{ marginTop: 8, fontSize: 10, color: "#8dd89f", display: "flex", alignItems: "center", gap: 5 }}>
              <CheckCircle size={11} />
              <a
                href={`https://explorer.arc.io/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#8dd89f", textDecoration: "none", fontFamily: "JetBrains Mono, monospace" }}
              >
                {truncate(txHash)}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Idle state — register or login
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <Fingerprint size={16} color="#acc6e9" />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#acc6e9", letterSpacing: 1.1, textTransform: "uppercase" }}>Passkey Wallet</span>
      </div>
      <div style={{ fontSize: 11, color: "#8ba5c2", marginBottom: 14, lineHeight: 1.5 }}>
        Circle Smart Account — şifresiz, passkey ile giriş. Arc Mainnet üzerinde gasless USDC transferi.
      </div>

      {/* Register */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#4b6a8a", letterSpacing: 1.1, textTransform: "uppercase", marginBottom: 6 }}>
          Yeni hesap oluştur
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            placeholder="Kullanıcı adı"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleRegister()}
            style={{
              flex: 1,
              background: "#091624", border: "1px solid #1e3a52", borderRadius: 7,
              color: "#e8f0f8", fontSize: 12, padding: "7px 10px",
              fontFamily: "DM Sans, sans-serif", outline: "none",
            }}
          />
          <button
            onClick={handleRegister}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "#acc6e9", color: "#0d1b2f",
              border: "none", borderRadius: 7, padding: "7px 14px",
              fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}
          >
            <Fingerprint size={13} />
            Oluştur
          </button>
        </div>
      </div>

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0" }}>
        <div style={{ flex: 1, height: 1, background: "#1e3a52" }} />
        <span style={{ fontSize: 10, color: "#2a4a6a" }}>veya</span>
        <div style={{ flex: 1, height: 1, background: "#1e3a52" }} />
      </div>

      {/* Login */}
      <button
        onClick={handleLogin}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          background: "none", border: "1px solid #1e3a52", borderRadius: 7,
          color: "#acc6e9", fontSize: 11, fontWeight: 700, padding: "8px 0",
          cursor: "pointer",
        }}
      >
        <LogIn size={13} />
        Mevcut hesabımla giriş yap
      </button>
    </div>
  );
}
