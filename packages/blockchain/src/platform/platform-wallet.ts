import { createWalletClient, getAddress, http } from "viem";
import type { Address, Chain, Hex, Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";

import { attributionSuffix, withAttribution } from "../attribution.js";
import { readKeyFileOutsideRepo } from "../recovery/key-file.js";

/*
 * Kaada's ONE platform / agent wallet: a plain EOA that is Kaada's public identity on Celo (hackathon agent, the future
 * recipient of platform service fees, the sender of platform-owned transactions). It is deliberately small:
 *
 *   - it is NOT a user wallet, a Kernel, the recovery relayer, a passkey root or a paymaster, and user payments never go through it;
 *   - it exposes its PUBLIC address and one operation, "send this platform-owned transaction", which always carries the Celo
 *     attribution tag;
 *   - its key is read once from a file outside the repository (in production a read-only mount), never stored on this object,
 *     never serialised, never logged, and never part of an error.
 */

export interface PlatformTransactionRequest {
  to: Address;
  /** Wei. */
  value?: bigint;
  data?: Hex;
}

export interface PlatformWalletOptions {
  /** A file holding one 0x-prefixed 32-byte key, OUTSIDE the repository. */
  keyFile: string;
  /** The PUBLIC address the deployment expects (PLATFORM_WALLET_ADDRESS). The wallet refuses to exist if the key derives to any other. */
  expectedAddress: string;
  repositoryRoot: string;
  chain: Chain;
  rpcUrl?: string | undefined;
  /** Tests only: replaces the HTTP transport. */
  transport?: Transport;
  /** Defaults to the project's Celo attribution code. */
  attributionCode?: string;
}

export class PlatformWallet {
  readonly address: Address;
  private readonly account: LocalAccount;
  private readonly wallet;
  private readonly suffix: Hex;

  private constructor(account: LocalAccount, chain: Chain, transport: Transport, suffix: Hex) {
    this.account = account;
    this.address = account.address;
    this.suffix = suffix;
    this.wallet = createWalletClient({ account, chain, transport });
  }

  /**
   * Reads the key, derives its address and compares it with the expected one. A mismatch throws naming only the two PUBLIC
   * addresses; production therefore never silently runs with a different (or newly generated) platform wallet.
   */
  static load(options: PlatformWalletOptions): PlatformWallet {
    const account = privateKeyToAccount(
      readKeyFileOutsideRepo(options.keyFile, options.repositoryRoot),
    );
    const expected = options.expectedAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(expected) || /^0x0{40}$/.test(expected)) {
      throw new Error("PLATFORM_WALLET_ADDRESS is not a valid address");
    }
    if (getAddress(expected) !== account.address) {
      throw new Error(
        `PLATFORM_WALLET_KEY_FILE derives to ${account.address.toLowerCase()}, but PLATFORM_WALLET_ADDRESS is ${expected.toLowerCase()}. Refusing to start.`,
      );
    }
    return new PlatformWallet(
      account,
      options.chain,
      options.transport ?? http(options.rpcUrl),
      attributionSuffix(options.attributionCode),
    );
  }

  /** The exact transaction that will be signed: the request with the Celo attribution suffix at the end of its calldata. */
  prepare(request: PlatformTransactionRequest): { to: Address; value: bigint; data: Hex } {
    return {
      to: getAddress(request.to),
      value: request.value ?? 0n,
      data: withAttribution(request.data, this.suffix),
    };
  }

  /** Signs and broadcasts a platform-owned transaction (always tagged). Returns the hash; confirmation is the caller's concern. */
  async send(request: PlatformTransactionRequest): Promise<{ txHash: Hex }> {
    const prepared = this.prepare(request);
    const txHash = await this.wallet.sendTransaction({
      account: this.account,
      chain: this.wallet.chain,
      to: prepared.to,
      value: prepared.value,
      data: prepared.data,
    });
    return { txHash };
  }

  /** Serialising the wallet gives its public address and nothing else. */
  toJSON(): { address: Address } {
    return { address: this.address };
  }
}
