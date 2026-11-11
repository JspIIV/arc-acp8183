// Makes the three agent keys for the Arc Testnet demo and saves them to .env.testnet
// (ignored by git). Prints addresses only; the keys are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const FILE = resolve(import.meta.dir, "../.env.testnet");
const NAMES = ["AGENT_CLIENT_KEY", "AGENT_PROVIDER_KEY", "AGENT_EVALUATOR_KEY"] as const;

if (!existsSync(FILE)) {
  const body = NAMES.map((n) => `${n}=${generatePrivateKey()}`).join("\n") + "\n";
  writeFileSync(FILE, body, { mode: 0o600 });
  console.log(`Created ${FILE}`);
} else {
  console.log(`${FILE} already exists; keeping its keys.`);
}

const values = new Map(
  readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)] as const;
  }),
);
console.log("\nFund these addresses with test USDC (gas on Arc is paid in USDC):");
for (const n of NAMES) {
  const key = values.get(n);
  if (!key) throw new Error(`${n} is missing in ${FILE}`);
  console.log(`${n.replace("AGENT_", "").replace("_KEY", "").toLowerCase().padEnd(10)} ${privateKeyToAccount(key as Hex).address}`);
}
