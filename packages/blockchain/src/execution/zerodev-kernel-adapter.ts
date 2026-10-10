import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import {
  createKernelAccount,
  createKernelAccountClient,
  getValidatorPluginInstallModuleData,
} from "@zerodev/sdk";
import { getPluginInstallCallData } from "@zerodev/sdk/accounts";
import { PasskeyValidatorContractVersion, toPasskeyValidator } from "@zerodev/passkey-validator";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { CallPolicyVersion, toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner, toEmptyECDSASigner } from "@zerodev/permissions/signers";
import {
  b64ToBytes,
  findQuoteIndices,
  isRIP7212SupportedNetwork,
  parseAndNormalizeSig,
  uint8ArrayToHexString,
} from "@zerodev/webauthn-key";
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";
import { createBundlerClient, getUserOperationHash } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

import { KaadaError, SecretValue } from "@kaada/domain";
import type {
  AccountCall,
  JsonObject,
  KernelExecutionPort,
  OperationReceipt,
  PermissionScope,
  PreparedRootOperation,
  RootCredential,
} from "@kaada/domain";

/*
 * THE Kernel/bundler adapter. It is the only file that builds, signs or sends a UserOperation.
 *
 * STATUS: written against the pinned SDK versions and type-checked, but NEVER RUN against a real
 * bundler or chain from Kaada's test suite. Disabled unless EXECUTION_ENABLED is set. See
 * docs/execution.md ("What was and was not verified") before enabling it with any value.
 *
 * Authorities:
 *  - ROOT operations (deploy the account, install the restricted permission) are signed by the user's
 *    passkey. The server prepares the UserOperation and its hash; the browser returns an assertion over
 *    exactly that hash; this file encodes it. No private key exists for the root.
 *  - DELEGATED calls are signed by a per-permission session key that the permission restricts on chain
 *    (call policy: contracts, selectors, argument rules, native value 0; timestamp policy: window).
 */

const ENTRY_POINT = getEntryPoint("0.7");
const CHAIN_ID = celo.id;
const BIGINT_PREFIX = "bigint:";
const HEX = /^0x[0-9a-fA-F]*$/;

export interface ZeroDevKernelAdapterConfig {
  /** Celo JSON-RPC (reads). */
  rpcUrl?: string;
  /** ERC-4337 bundler that supports Celo (writes). */
  bundlerUrl: string;
}

/** BigInt-safe JSON for a prepared UserOperation (no secrets are ever part of it). */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return `${BIGINT_PREFIX}${value.toString()}`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

function fromJsonSafe(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(BIGINT_PREFIX)) {
    return BigInt(value.slice(BIGINT_PREFIX.length));
  }
  if (Array.isArray(value)) return value.map(fromJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJsonSafe(v)]));
  }
  return value;
}

const word = (hex: string): Hex => pad(hex as Hex, { size: 32 });
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * The on-chain restrictions of ONE payment, from the validated plan scope:
 *   approve(spender, amount)  only on the sell token, only to the quote's spender, amount <= limit
 *   transfer(to, amount)      only on the buy token, only to the pinned recipient, amount <= limit
 *   the swap target           that one contract (any function), no native value
 *   native value              zero everywhere
 *   validity window           [validFrom, expiresAt]
 */
export function policiesForScope(scope: PermissionScope) {
  const permissions: Parameters<typeof toCallPolicy>[0]["permissions"] = [];
  const list = permissions as unknown as Record<string, unknown>[];
  if (scope.approval) {
    list.push({
      target: scope.approval.tokenAddress,
      selector: "0x095ea7b3",
      valueLimit: 0n,
      rules: [
        { condition: 0, offset: 0, params: [word(scope.approval.spender)] },
        {
          condition: 4,
          offset: 32,
          params: [word(toHex(BigInt(scope.approval.limit.amount)))],
        },
      ],
    });
  }
  if (scope.payout) {
    list.push({
      target: scope.payout.tokenAddress,
      selector: "0xa9059cbb",
      valueLimit: 0n,
      rules: [
        { condition: 0, offset: 0, params: [word(scope.payout.recipient)] },
        {
          condition: 4,
          offset: 32,
          params: [word(toHex(BigInt(scope.payout.limit.amount)))],
        },
      ],
    });
  }
  list.push({ target: scope.swapTarget, valueLimit: 0n });
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions }),
    toTimestampPolicy({ validAfter: unix(scope.validFrom), validUntil: unix(scope.expiresAt) }),
  ];
}

/** A bundler's refusal is definite ("not sent"); anything else may have reached it. */
function classify(error: unknown): unknown {
  if (error instanceof KaadaError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  const rpcRejection =
    typeof code === "number" && code <= -32500 && code >= -32507
      ? true
      : name === "UserOperationExecutionError" ||
        name === "UserOperationRevertedError" ||
        name === "InvalidParamsRpcError";
  return rpcRejection
    ? new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation")
    : error;
}

/** The WebAuthn assertion, encoded as the passkey validator expects it. */
export function encodePasskeyAssertion(assertion: unknown): Hex {
  const response = (assertion as { response?: Record<string, unknown> } | null)?.response;
  const authenticatorData = response?.["authenticatorData"];
  const clientDataJSON = response?.["clientDataJSON"];
  const signature = response?.["signature"];
  if (
    typeof authenticatorData !== "string" ||
    typeof clientDataJSON !== "string" ||
    typeof signature !== "string"
  ) {
    throw new KaadaError("CREDENTIAL_REJECTED", "the passkey assertion is malformed");
  }
  const clientData = Buffer.from(clientDataJSON, "base64url").toString("utf8");
  const { beforeType } = findQuoteIndices(clientData);
  const { r, s } = parseAndNormalizeSig(uint8ArrayToHexString(b64ToBytes(signature)));
  return encodeAbiParameters(
    [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
      { name: "responseTypeLocation", type: "uint256" },
      { name: "r", type: "uint256" },
      { name: "s", type: "uint256" },
      { name: "usePrecompiled", type: "bool" },
    ],
    [
      uint8ArrayToHexString(b64ToBytes(authenticatorData)),
      clientData,
      BigInt(beforeType),
      BigInt(r),
      BigInt(s),
      isRIP7212SupportedNetwork(CHAIN_ID),
    ],
  );
}

export function createZeroDevKernelAdapter(
  config: ZeroDevKernelAdapterConfig,
): KernelExecutionPort {
  const client = createPublicClient({ chain: celo, transport: http(config.rpcUrl) });
  const bundler = createBundlerClient({ client, transport: http(config.bundlerUrl) });

  /** The Kernel account whose root validator is the user's passkey, optionally with a permission. */
  async function rootAccount(
    credential: RootCredential,
    signature: { value: Hex },
    permission?: { scope: PermissionScope; sessionKeyAddress: Address },
  ) {
    const validator = await toPasskeyValidator(client, {
      webAuthnKey: {
        pubX: BigInt(`0x${credential.publicKeyX}`),
        pubY: BigInt(`0x${credential.publicKeyY}`),
        authenticatorId: credential.credentialId,
        authenticatorIdHash: keccak256(toHex(Buffer.from(credential.credentialId, "base64url"))),
        rpID: credential.rpId,
      },
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_3,
      validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
    });
    // The signature is supplied from outside (the browser's assertion); the SDK never opens a prompt.
    const sudo = { ...validator, signUserOperation: () => Promise.resolve(signature.value) };
    const account = await createKernelAccount(client, {
      plugins: { sudo },
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_3,
    });
    const permissionPlugin = permission
      ? await toPermissionValidator(client, {
          signer: toEmptyECDSASigner(permission.sessionKeyAddress),
          policies: policiesForScope(permission.scope),
          entryPoint: ENTRY_POINT,
          kernelVersion: KERNEL_V3_3,
        })
      : undefined;
    return { account, validator, permissionPlugin };
  }

  const toCredential = (value: unknown): RootCredential => {
    const c = value as Partial<RootCredential> | null;
    if (!c?.credentialId || !c.publicKeyX || !c.publicKeyY || !c.rpId) {
      throw new Error("the prepared operation has no credential");
    }
    return {
      credentialId: c.credentialId,
      publicKeyX: c.publicKeyX,
      publicKeyY: c.publicKeyY,
      rpId: c.rpId,
    };
  };

  return {
    async isDeployed(address) {
      const code = await client.getCode({ address: address as Address });
      return code !== undefined && code !== "0x";
    },

    nativeBalance: (address) => client.getBalance({ address: address as Address }),

    async prepareRootOperation(input): Promise<PreparedRootOperation> {
      if (!input.permission) throw new Error("a root operation needs a permission to install");
      // A fresh key for THIS permission. Its private half leaves this function once, wrapped.
      const key = generatePrivateKey();
      const sessionKeyAddress = privateKeyToAccount(key).address;
      const stub = { value: "0x" as Hex };
      const { account, validator, permissionPlugin } = await rootAccount(input.credential, stub, {
        scope: input.permission.scope,
        sessionKeyAddress,
      });
      if (account.address.toLowerCase() !== input.walletAddress.toLowerCase()) {
        throw new Error("the rebuilt account does not match the wallet address");
      }
      if (!permissionPlugin) throw new Error("no permission plugin");
      stub.value = await validator.getStubSignature({} as never);
      const installData = await getValidatorPluginInstallModuleData({
        plugin: permissionPlugin,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_3,
      });
      const install = getPluginInstallCallData(account.address, installData);
      const calls = [
        { to: install.to, data: install.data, value: install.value },
        ...input.calls.map((call) => ({
          to: call.to as Address,
          data: call.data as Hex,
          value: BigInt(call.value),
        })),
      ];
      const accountClient = createKernelAccountClient({
        account,
        chain: celo,
        bundlerTransport: http(config.bundlerUrl),
        client,
      });
      const userOperation = await accountClient.prepareUserOperation({
        callData: await account.encodeCalls(calls),
      });
      const hash = getUserOperationHash({
        userOperation: { ...userOperation, signature: "0x" },
        entryPointAddress: ENTRY_POINT.address,
        entryPointVersion: ENTRY_POINT.version,
        chainId: CHAIN_ID,
      });
      return {
        challenge: hash,
        prepared: {
          credential: { ...input.credential },
          scope: JSON.parse(JSON.stringify(input.permission.scope)) as JsonObject,
          sessionKeyAddress,
          userOperation: toJsonSafe({ ...userOperation, signature: "0x" }) as JsonObject,
        },
        sessionKey: { address: sessionKeyAddress, privateKey: new SecretValue(key) },
      };
    },

    async sendRootOperation(input) {
      try {
        const credential = toCredential(input.prepared["credential"]);
        const rawScope = input.prepared["scope"] as unknown as PermissionScope & {
          validFrom: string;
          expiresAt: string;
        };
        const scope: PermissionScope = {
          ...rawScope,
          validFrom: new Date(rawScope.validFrom),
          expiresAt: new Date(rawScope.expiresAt),
        };
        const sessionKeyAddress = input.prepared["sessionKeyAddress"] as Address;
        const signature = { value: encodePasskeyAssertion(input.assertion) };
        const { account, permissionPlugin } = await rootAccount(credential, signature, {
          scope,
          sessionKeyAddress,
        });
        if (!permissionPlugin) throw new Error("no permission plugin");
        const userOperation = fromJsonSafe(input.prepared["userOperation"]) as Record<
          string,
          unknown
        >;
        // The operation hash was fixed when the challenge was issued; the signature covers exactly it.
        const userOpHash = await bundler.sendUserOperation({
          ...(userOperation as object),
          signature: signature.value,
          entryPointAddress: ENTRY_POINT.address,
        } as never);
        // The enable data for the later, session-key-signed UserOperations. The permission is
        // already installed by the operation above, so the serialization is marked pre-installed.
        const approval = await serializePermissionAccount(
          account,
          undefined,
          undefined,
          undefined,
          permissionPlugin,
          false,
        );
        return { userOpHash, approval: new SecretValue(approval) };
      } catch (error) {
        throw classify(error);
      }
    },

    async isPermissionInstalled(input) {
      // Rebuild the permission exactly as installed and read its configuration from the account.
      const plugin = await toPermissionValidator(client, {
        signer: toEmptyECDSASigner(input.sessionKeyAddress as Address),
        policies: policiesForScope(input.scope),
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_3,
      });
      // Kernel v3 identifies a permission by 4 bytes derived from its policies and its signer.
      const permissionId = plugin.getIdentifier();
      if (!HEX.test(permissionId) || permissionId.length !== 10) return false;
      try {
        const config = await client.readContract({
          address: input.walletAddress as Address,
          abi: [
            {
              type: "function",
              name: "permissionConfig",
              stateMutability: "view",
              inputs: [{ name: "permissionId", type: "bytes4" }],
              outputs: [
                { name: "", type: "bytes2" },
                { name: "", type: "address" },
                { name: "", type: "address" },
              ],
            },
          ] as const,
          functionName: "permissionConfig",
          args: [permissionId],
        });
        // A permission that is not installed has no signer module configured.
        return config[1] !== "0x0000000000000000000000000000000000000000";
      } catch {
        return false;
      }
    },

    async sendDelegatedCalls(input) {
      try {
        const signer = await toECDSASigner({
          signer: privateKeyToAccount(input.sessionKey.reveal() as Hex),
        });
        const account = await deserializePermissionAccount(
          client,
          ENTRY_POINT,
          KERNEL_V3_3,
          input.approval.reveal(),
          signer,
        );
        const accountClient = createKernelAccountClient({
          account,
          chain: celo,
          bundlerTransport: http(config.bundlerUrl),
          client,
        });
        const userOpHash = await accountClient.sendUserOperation({
          callData: await account.encodeCalls(
            input.calls.map((call: AccountCall) => ({
              to: call.to as Address,
              data: call.data as Hex,
              value: BigInt(call.value),
            })),
          ),
        });
        return { userOpHash };
      } catch (error) {
        throw classify(error);
      }
    },

    async getUserOperationReceipt(userOpHash): Promise<OperationReceipt> {
      try {
        const receipt = await bundler.getUserOperationReceipt({ hash: userOpHash as Hex });
        return {
          status: "INCLUDED",
          success: receipt.success,
          txHash: receipt.receipt.transactionHash,
          blockNumber: receipt.receipt.blockNumber.toString(),
        };
      } catch (error) {
        // "Not found yet" is the normal state of a pending operation. Anything else is an outage.
        if ((error as { name?: unknown } | null)?.name === "UserOperationReceiptNotFoundError") {
          return { status: "PENDING" };
        }
        throw error;
      }
    },

    async getTransactionReceipt(txHash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        return {
          status: receipt.status === "success" ? "SUCCESS" : "REVERTED",
          blockNumber: receipt.blockNumber.toString(),
        };
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === "TransactionReceiptNotFoundError") {
          return { status: "PENDING" };
        }
        throw error;
      }
    },
  };
}
