import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ACP_ABI, BOND_ABI, ERC20_ABI, JOB_SUBMITTED, STATUS } from "./abi";
import type { Agent } from "./agent";

export interface Deployment {
  usdc: Address;
  acp: Address;
  /** BondHook address, or zeroAddress for plain jobs without a bond. */
  hook: Address;
}

export interface Job {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
}

/**
 * Where deliverables live. Production agents would use IPFS or any content-addressed
 * store; the evaluator only needs `get(uri)` and then checks keccak256(content) against
 * the hash the provider committed to onchain.
 */
export interface DeliverableStore {
  put(content: string): string; // returns the uri
  get(uri: string): string | undefined;
}

export class MemoryStore implements DeliverableStore {
  private readonly items = new Map<string, string>();
  put(content: string): string {
    const uri = `mem://${keccak256(toHex(content))}`;
    this.items.set(uri, content);
    return uri;
  }
  get(uri: string): string | undefined {
    return this.items.get(uri);
  }
}

export const hashContent = (content: string): Hex => keccak256(toHex(content));
const reasonOf = (text: string): Hex => stringToHex(text.slice(0, 31), { size: 32 });
const gasFor = (hook: Address): bigint | undefined => (hook === zeroAddress ? undefined : 600_000n);

/** Pays for work. Never funds a job before checking who the provider and evaluator are. */
export class ClientAgent {
  constructor(readonly agent: Agent, readonly d: Deployment) {}

  async createJob(provider: Address, evaluator: Address, description: string, ttlSeconds: bigint): Promise<bigint> {
    const block = await this.agent.pub.getBlock();
    const receipt = await this.agent.write(this.d.acp, ACP_ABI, "createJob", [
      provider, evaluator, block.timestamp + ttlSeconds, description, this.d.hook,
    ]);
    const [created] = parseEventLogs({ abi: ACP_ABI, eventName: "JobCreated", logs: receipt.logs });
    if (!created) throw new Error("JobCreated event not found");
    return created.args.jobId;
  }

  /** Approves exactly the budget (never more), then funds. The budget is passed so a change reverts. */
  async fund(jobId: bigint, trustedEvaluator: Address): Promise<void> {
    const job = await this.agent.read<Job>(this.d.acp, ACP_ABI, "getJob", [jobId]);
    if (job.evaluator.toLowerCase() !== trustedEvaluator.toLowerCase()) {
      throw new Error(`refusing to fund job ${jobId}: evaluator ${job.evaluator} is not the one I trust`);
    }
    await this.agent.write(this.d.usdc, ERC20_ABI, "approve", [this.d.acp, job.budget]);
    const optParams = encodeAbiParameters(parseAbiParameters("uint256"), [job.budget]);
    await this.agent.write(this.d.acp, ACP_ABI, "fund", [jobId, optParams]);
  }
}

/** Does the work. Posts a bond first when the job uses the bond hook. */
export class ProviderAgent {
  constructor(readonly agent: Agent, readonly d: Deployment, readonly store: DeliverableStore) {}

  async stakeBond(amount: bigint): Promise<void> {
    await this.agent.write(this.d.usdc, ERC20_ABI, "approve", [this.d.hook, amount]);
    await this.agent.write(this.d.hook, BOND_ABI, "stakeBond", [amount]);
  }

  async setBudget(jobId: bigint, amount: bigint): Promise<void> {
    await this.agent.write(this.d.acp, ACP_ABI, "setBudget", [jobId, amount, "0x"]);
  }

  /** Commits to the content by hash and publishes where to fetch it. */
  async submit(jobId: bigint, content: string): Promise<Hex> {
    const uri = this.store.put(content);
    const hash = hashContent(content);
    const optParams = encodeAbiParameters(parseAbiParameters("address, uint256, string"), [zeroAddress, 0n, uri]);
    await this.agent.write(this.d.acp, ACP_ABI, "submit", [jobId, hash, optParams]);
    return hash;
  }
}

export interface Verdict {
  approved: boolean;
  reason: string;
}

/** Judges a deliverable. `check` is the task-specific part; the hash check is always done. */
export class EvaluatorAgent {
  constructor(readonly agent: Agent, readonly d: Deployment, readonly store: DeliverableStore) {}

  async review(jobId: bigint, check: (content: string) => Verdict): Promise<Verdict> {
    const job = await this.agent.read<Job>(this.d.acp, ACP_ABI, "getJob", [jobId]);
    if (job.evaluator.toLowerCase() !== this.agent.address.toLowerCase()) throw new Error("not the evaluator of this job");
    if (STATUS[job.status] !== "Submitted") throw new Error(`job ${jobId} is ${STATUS[job.status]}, nothing to review`);

    const logs = await this.agent.pub.getLogs({
      address: this.d.acp, event: JOB_SUBMITTED, args: { jobId }, fromBlock: 0n,
    });
    const submitted = logs[logs.length - 1];
    if (!submitted?.args.deliverable || submitted.args.uri === undefined) throw new Error("no submission event found");

    const content = this.store.get(submitted.args.uri);
    let verdict: Verdict;
    if (content === undefined) verdict = { approved: false, reason: "deliverable not found" };
    else if (hashContent(content) !== submitted.args.deliverable) verdict = { approved: false, reason: "hash mismatch" };
    else verdict = check(content);

    await this.agent.write(
      this.d.acp, ACP_ABI, verdict.approved ? "complete" : "reject",
      [jobId, reasonOf(verdict.reason), "0x"], gasFor(job.hook),
    );
    return verdict;
  }
}
