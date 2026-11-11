import {
  encodeFunctionData,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";

export type Pub = PublicClient<Transport, Chain>;
export type Wallet = WalletClient<Transport, Chain, Account>;

/** One agent identity: a name, a signing wallet and a read client. */
export class Agent {
  constructor(
    readonly name: string,
    readonly wallet: Wallet,
    readonly pub: Pub,
  ) {}

  get address(): Address {
    return this.wallet.account.address;
  }

  /** Sends a contract write and waits for it. Throws when the transaction reverts. */
  async write(
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    gas?: bigint,
  ): Promise<TransactionReceipt> {
    const data = encodeFunctionData({ abi, functionName, args });
    const hash = await this.wallet.sendTransaction({ to, data, gas });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${this.name}: ${functionName} reverted (${hash})`);
    return receipt;
  }

  async read<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.pub.readContract({ address: to, abi, functionName, args })) as T;
  }
}

export type Hash32 = Hex;
