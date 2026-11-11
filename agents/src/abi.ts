import { parseAbi, parseAbiItem } from "viem";

// Minimal ABIs for the calls the reference agents make. The full ABI is in
// frontend/src/abis.ts (generated from the build output).

export const ACP_ABI = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function withdraw()",
  "function owed(address recipient) view returns (uint256)",
  "function jobCount() view returns (uint256)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "function getJob(uint256 jobId) view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))",
  // admin, used only by the local deploy helper
  "function setHookWhitelist(address hook, bool allowed)",
  "function setPlatformFee(uint256 feeBP, address treasury)",
  "function setEvaluatorFee(uint256 bps)",
]);

export const BOND_ABI = parseAbi([
  "function stakeBond(uint256 amount)",
  "function withdrawSlash()",
  "function slashOwed(address recipient) view returns (uint256)",
  "function bondBalance(address provider) view returns (uint256)",
  "function bondLocked(address provider) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export const MOCK_USDC_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

export const JOB_SUBMITTED = parseAbiItem(
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable, string uri)",
);

export const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
