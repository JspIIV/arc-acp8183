// Makes the agent keys for the Arc Testnet runs and saves them to .env.testnet (ignored by
// git). Keeps keys that already exist, adds missing ones. Prints addresses only; the keys
// are never printed.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const KEY_NAMES = [
  "AGENT_CLIENT_KEY", "AGENT_CLIENT_2_KEY",
  "AGENT_PROVIDER_KEY", "AGENT_PROVIDER_2_KEY", "AGENT_PROVIDER_3_KEY",
  "AGENT_EVALUATOR_KEY", "AGENT_EVALUATOR_2_KEY",
  "CCTP_TESTER_KEY",   // deploys and owns the test CCTP funders, and plays the client in the CCTP tests
] as const;

const FILE = resolve(import.meta.dir, "../.env.testnet");
if (!existsSync(FILE)) writeFileSync(FILE, "", { mode: 0o600 });

const read = () => new Map(
  readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)] as const;
  }),
);
const have = read();
const added: string[] = [];
for (const n of KEY_NAMES) {
  if (!have.has(n)) { appendFileSync(FILE, `${n}=${generatePrivateKey()}\n`); added.push(n); }
}
console.log(added.length ? `Added ${added.length} key(s) to ${FILE}: ${added.join(", ")}` : `${FILE} already has every key.`);

const values = read();
console.log("\nAddresses (gas on Arc is paid in USDC):");
for (const n of KEY_NAMES) {
  console.log(`${n.replace("AGENT_", "").replace("_KEY", "").toLowerCase().padEnd(12)} ${privateKeyToAccount(values.get(n) as Hex).address}`);
}
