// Small building blocks shared by the action panels. Same dark palette as the board panels.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export const C = {
  text: "#c8d9ec", dim: "#7a94b0", muted: "#4b6a8a", line: "#0f2035",
  accent: "#acc6e9", ok: "#8dd89f", bad: "#e86d7a", warn: "#f59e0b", card: "rgba(15,32,53,0.8)",
};

export function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 8, color: C.muted, letterSpacing: 1.5, marginBottom: 3 }}>{children}</div>;
}

const field = {
  width: "100%", background: "rgba(5,12,23,0.9)", border: `1px solid ${C.line}`, borderRadius: 4,
  color: C.text, fontSize: 11, padding: "6px 8px", outline: "none", fontFamily: "inherit",
} as const;

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...field, ...props.style }} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} style={{ ...field, resize: "vertical", ...props.style }} />;
}

type Kind = "primary" | "ghost" | "danger";

export function Btn({ kind = "primary", busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind; busy?: boolean }) {
  const color = kind === "danger" ? C.bad : kind === "ghost" ? C.accent : "#050c17";
  const bg = kind === "primary" ? C.accent : "transparent";
  const border = kind === "danger" ? C.bad : C.accent;
  const disabled = rest.disabled || busy;
  return (
    <button {...rest} disabled={disabled} style={{
      width: "100%", padding: "7px 10px", fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
      borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
      color, background: bg, border: `1px solid ${border}`, ...rest.style,
    }}>{busy ? "Working…" : children}</button>
  );
}

export function Hint({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode }) {
  const color = tone === "warn" ? C.warn : tone === "bad" ? C.bad : tone === "ok" ? C.ok : C.dim;
  return (
    <div style={{ fontSize: 10, color, lineHeight: 1.5, border: `1px solid ${color}33`, borderRadius: 4, padding: "6px 8px", marginBottom: 8 }}>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
      <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.accent, fontWeight: 700, marginBottom: 8 }}>{title.toUpperCase()}</div>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ marginBottom: 8 }}><Label>{label}</Label>{children}</div>;
}
