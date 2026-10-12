import { readFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

import { recoveryDomain, recoveryInitiateTypes } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import type { RecoveryAttestor, RecoveryTypedMessage } from "@kaada/domain";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from "viem";
import type { Address, Chain, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { AttestorSigner } from "./attestor-signer.js";

export interface KeyAttestorOptions {
  /**
   * Who holds the attestor key. Production passes a KMS/HSM-backed `AttestorSigner` (see `createExternalSigner`); the
   * file-key adapter (`privateKey`, development and tests) is the alternative. Exactly one of the two.
   */
  signer?: AttestorSigner;
  /** DEV/TEST ONLY: a key held in memory. Production refuses it in configuration. */
  privateKey?: Hex;
  chainId: number;
  /** The one recovery validator this attestor attests for. */
  recoveryValidator: Address;
  /** Sends `attestorCancel(account)` FROM the attestor address and resolves with the transaction hash once included. */
  sendVeto(input: { account: Address }): Promise<Hex>;
}

/**
 * The Kaada attestor boundary. It can do exactly two things:
 *
 *  1. sign the typed EIP-712 `Initiate` message of ONE recovery validator on ONE chain (its shape is fixed here: there is no
 *     method that signs bytes, calldata, a transaction, a transfer, a PaymentAuthorization or a UserOperation), and
 *  2. veto a pending recovery of that validator (`attestorCancel`).
 *
 * It holds no wallet authority: on its own it can neither start nor complete a recovery, and it is never an account root.
 * The checks that decide WHETHER to attest (email verified, risk policy, Recovery Code proof, commitment match, no conflict)
 * belong to the recovery service and run before this is ever called; this class only refuses anything that is not the exact
 * message shape for its own chain and validator.
 */
export class KeyAttestor implements RecoveryAttestor {
  private readonly account: AttestorSigner;

  constructor(private readonly options: KeyAttestorOptions) {
    if ((options.signer === undefined) === (options.privateKey === undefined)) {
      throw new Error("the attestor needs exactly one of a signer or a development private key");
    }
    this.account = options.signer ?? privateKeyToAccount(options.privateKey as Hex);
  }

  address(): Promise<string> {
    return Promise.resolve(this.account.address.toLowerCase());
  }

  async signInitiate(message: RecoveryTypedMessage): Promise<string> {
    if (message.chainId !== this.options.chainId) {
      throw new KaadaError("RECOVERY_REJECTED", "the attestor only signs for its own chain");
    }
    if (getAddress(message.verifyingContract) !== getAddress(this.options.recoveryValidator)) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the attestor only signs for its own recovery validator",
      );
    }
    return this.account.signTypedData({
      domain: recoveryDomain(message.chainId, getAddress(message.verifyingContract)),
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message: {
        account: getAddress(message.account),
        nonce: BigInt(message.nonce),
        rootId: message.rootId as Hex,
        hook: getAddress(message.hook),
        validatorDataHash: message.validatorDataHash as Hex,
        hookDataHash: message.hookDataHash as Hex,
        deadline: BigInt(message.deadline),
      },
    });
  }

  async veto(input: { recoveryValidator: string; account: string }): Promise<{ txHash: string }> {
    if (getAddress(input.recoveryValidator) !== getAddress(this.options.recoveryValidator)) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the attestor only vetoes for its own recovery validator",
      );
    }
    const txHash = await this.options.sendVeto({ account: getAddress(input.account) });
    return { txHash };
  }
}

/**
 * Reads a dedicated key from a file that must live OUTSIDE the repository checkout (a secret never sits next to the code).
 * The file holds the 0x-prefixed 32-byte hex key and nothing else.
 */
export function readKeyFileOutsideRepo(path: string, repositoryRoot: string): Hex {
  const absolute = resolve(path);
  const rel = relative(resolve(repositoryRoot), absolute);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error("a signing key file must be stored outside the repository");
  }
  const text = readFileSync(absolute, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error("the key file must hold one 0x-prefixed 32-byte hex key");
  return text as Hex;
}

/** What `createVetoSender` needs: the chain, an RPC and the attestor key (the veto is sent from the attestor address). */
export interface VetoSenderOptions {
  chain: Chain;
  rpcUrl: string;
  /** The attestor's signer (KMS/HSM in production) or, for development and tests, its key. Exactly one. */
  signer?: AttestorSigner;
  privateKey?: Hex;
  recoveryValidator: Address;
}

/**
 * The attestor veto transaction: `attestorCancel(account)` on the recovery validator, sent from the attestor key and awaited
 * until it is included and successful. It can only stop a pending recovery; the contract offers the attestor nothing else.
 */
export function createVetoSender(
  options: VetoSenderOptions,
): (input: { account: Address }) => Promise<Hex> {
  if ((options.signer === undefined) === (options.privateKey === undefined)) {
    throw new Error("the veto sender needs exactly one of a signer or a development private key");
  }
  const account = options.signer ?? privateKeyToAccount(options.privateKey as Hex);
  const wallet = createWalletClient({
    account,
    chain: options.chain,
    transport: http(options.rpcUrl),
  });
  const client = createPublicClient({ chain: options.chain, transport: http(options.rpcUrl) });
  const abi = parseAbi(["function attestorCancel(address account)"]);
  return async ({ account: target }) => {
    const hash = await wallet.writeContract({
      address: options.recoveryValidator,
      abi,
      functionName: "attestorCancel",
      args: [target],
      gas: 200_000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new KaadaError("RECOVERY_REJECTED", "the veto transaction failed");
    return hash;
  };
}
