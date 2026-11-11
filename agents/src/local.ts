// Runs the reference agents against a throwaway local chain (anvil). Nothing is sent to a
// real network. Requires `forge build` in ../contracts first.
//
//   cd agents && bun install && bun run demo:local
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient, createWalletClient, http, parseUnits, zeroAddress,
  type Abi, type Address, type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ACP_ABI, MOCK_USDC_ABI } from "./abi";
import { Agent, type Pub, type Wallet } from "./agent";
import { runDemo } from "./demo";

const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's well-known public test mnemonic. These accounts only hold play money on a local chain.
const MNEMONIC = "test test test test test test test test test test test junk";
const OUT = resolve(import.meta.dir, "../../contracts/out");

interface Artifact { abi: Abi; bytecode: { object: Hex } }

function artifact(file: string): Artifact {
  const path = resolve(OUT, file);
  if (!existsSync(path)) throw new Error(`missing ${path}. Run \`forge build\` in contracts/ first.`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

async function main(): Promise<void> {
  const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "inherit" });
  try {
    await waitForRpc();
    const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
    const pub = createPublicClient({ chain, transport: http(RPC) }) as Pub;
    const mk = (i: number, name: string): Agent => {
      const account = mnemonicToAccount(MNEMONIC, { addressIndex: i });
      return new Agent(name, createWalletClient({ account, chain, transport: http(RPC) }) as Wallet, pub);
    };
    const owner = mk(0, "owner"), client = mk(1, "client"), provider = mk(2, "provider"), evaluator = mk(3, "evaluator");
    const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 4 }).address;

    async function deploy(a: Artifact, args: readonly unknown[]): Promise<Address> {
      const hash = await owner.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("deployment failed");
      return receipt.contractAddress;
    }

    console.log("== Deploying to a local chain");
    const usdc = await deploy(artifact("AgenticCommerce.t.sol/MockUSDC.json"), []);
    const acp = await deploy(artifact("AgenticCommerce.sol/AgenticCommerce.json"), [usdc, treasury]);
    const hook = await deploy(artifact("BondHook.sol/BondHook.json"), [usdc, acp, zeroAddress, zeroAddress]);
    await owner.write(acp, ACP_ABI, "setHookWhitelist", [hook, true]);
    await owner.write(acp, ACP_ABI, "setPlatformFee", [200n, treasury]);
    await owner.write(acp, ACP_ABI, "setEvaluatorFee", [100n]);
    for (const a of [client, provider]) await owner.write(usdc, MOCK_USDC_ABI, "mint", [a.address, parseUnits("1000", 6)]);
    console.log(`MockUSDC ${usdc}\nAgenticCommerce ${acp}\nBondHook ${hook}`);

    await runDemo({ usdc, acp, hook }, { client, provider, evaluator, treasury });
  } finally {
    anvil.kill();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
