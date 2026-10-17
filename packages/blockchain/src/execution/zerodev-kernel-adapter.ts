import { KERNEL_V3_3, VALIDATOR_TYPE, getEntryPoint } from "@zerodev/sdk/constants";
import { createKernelAccount, createKernelAccountClient, KernelV3_3AccountAbi } from "@zerodev/sdk";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { CallPolicyVersion, toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner, toEmptyECDSASigner } from "@zerodev/permissions/signers";
import { deviceKeySignature } from "@kaada/contracts";
import {
  b64ToBytes,
  findQuoteIndices,
  parseAndNormalizeSig,
  uint8ArrayToHexString,
} from "@zerodev/webauthn-key";
import {
  concat,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  pad,
  parseAbiItem,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { createBundlerClient, getUserOperationHash } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { Chain } from "viem";

import { KaadaError, SecretValue } from "@kaada/domain";
import type {
  AccountCall,
  JsonObject,
  KernelExecutionPort,
  OperationReceipt,
  PermissionScope,
  PreparedRootOperation,
  RootCredential,
  RootProof,
} from "@kaada/domain";

import { deviceKeyStubSignature, toRootValidator } from "../wallet/root-validator.js";

/*
 * THE Kernel/bundler adapter. It is the only file that builds, signs or sends a UserOperation.
 *
 * STATUS: written against the pinned SDK versions and type-checked, but NEVER RUN against a real
 * bundler or chain from Kaada's test suite. Disabled unless EXECUTION_ENABLED is set. See
 * docs/execution.md ("What was and was not verified") before enabling it with any value.
 *
 * Authorities:
 *  - ROOT operations (deploy the account, install the restricted permission, rotate the root) are signed by
 *    the user's root credential: a passkey or a P-256 device key. The server prepares the UserOperation and
 *    its hash; the client returns a passkey assertion or a device-key signature over exactly that hash; this
 *    file encodes it for the validator of that type. No private key exists for the root on the server.
 *  - DELEGATED calls are signed by a per-permission session key that the permission restricts on chain
 *    (call policy: contracts, selectors, argument rules, native value 0; timestamp policy: window).
 */

const ENTRY_POINT = getEntryPoint("0.7");
const BIGINT_PREFIX = "bigint:";
const HEX = /^0x[0-9a-fA-F]*$/;
/** How far back a hash lookup on the chain looks (a day or so on a 1-second chain is ~86k blocks). */
const RECEIPT_LOOKBACK_BLOCKS = 50_000n;
const USER_OPERATION_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);
/** The Kernel ECDSA signer module that every session-key permission uses. */
const ECDSA_SIGNER_CONTRACT = "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF";

/**
 * Which chain the adapter talks to. The default is Celo mainnet. A testnet is a TEST FIXTURE: it carries
 * its own passkey-validator address (the SDK's pinned one exists on mainnet only) and says explicitly
 * whether the RIP-7212 P-256 precompile is available (the SDK's own list predates Celo Sepolia).
 */
export interface KernelNetwork {
  chain: Chain;
  passkeyValidatorAddress?: Address;
  p256Precompile: boolean;
}

export const CELO_MAINNET_KERNEL_NETWORK: KernelNetwork = { chain: celo, p256Precompile: true };

export interface ZeroDevKernelAdapterConfig {
  /** Defaults to Celo mainnet. */
  network?: KernelNetwork;
  /** Celo JSON-RPC (reads). */
  rpcUrl?: string;
  /** ERC-4337 bundler that supports Celo (writes). */
  bundlerUrl: string;
  /**
   * TESTNET HARNESS ONLY. Replaces how a signed UserOperation (root or delegated) is submitted: the
   * harness submits it through EntryPoint.handleOps when a bundler accepts operations but never bundles
   * them. Not wired into the application.
   */
  submitUserOperation?: (signedOperation: Record<string, unknown>) => Promise<Hex>;
  /**
   * An ERC-8021 attribution suffix (`toDataSuffix(code)` from @celo/attribution-tags), appended to the end of every
   * UserOperation's `callData`. For ERC-4337 the on-chain transaction is the bundler's `handleOps`, so the tag has to live
   * inside each operation's callData; the suffix follows the ABI-encoded `execute(mode, calldata)` and the Kernel ignores it.
   * It is appended BEFORE the operation is hashed, so every signature covers it. Absent: no tag.
   */
  attributionSuffix?: Hex;
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
  list.push({ target: scope.swapTarget, selector: scope.swapSelector, valueLimit: 0n });
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions }),
    toTimestampPolicy({ validAfter: unix(scope.validFrom), validUntil: unix(scope.expiresAt) }),
  ];
}

const oneLine = (value: unknown): string => (typeof value === "string" ? value.slice(0, 200) : "");

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
    ? new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
        // The node's own one-line reason (e.g. "AA23 reverted"): no calldata, no keys.
        details: {
          rpc: oneLine((error as { details?: unknown } | null)?.details),
        },
      })
    : error;
}

/** The WebAuthn assertion, encoded as the passkey validator expects it. */
export function encodePasskeyAssertion(assertion: unknown, usePrecompiled = true): Hex {
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
      usePrecompiled,
    ],
  );
}

/** A device key's proof as `userOp.signature`: keyId || r || s, low-s only (the validator refuses a high-s signature). */
export function encodeDeviceProof(proof: { keyId: string; r: string; s: string }): Hex {
  if (![proof.r, proof.s].every((part) => /^[0-9a-f]{64}$/.test(part))) {
    throw new KaadaError("CREDENTIAL_REJECTED", "the device signature is malformed");
  }
  const r = BigInt(`0x${proof.r}`);
  const s = BigInt(`0x${proof.s}`);
  if (r === 0n || s === 0n) {
    throw new KaadaError("CREDENTIAL_REJECTED", "the device signature is malformed");
  }
  try {
    return deviceKeySignature(proof.keyId as Hex, r, s);
  } catch {
    throw new KaadaError("CREDENTIAL_REJECTED", "the device signature is not low-s");
  }
}

/** The SDK's stub assertion, with an explicit choice of P-256 verification path. */
export function stubPasskeySignature(usePrecompiled: boolean): Hex {
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
      "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000",
      '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false, "other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}',
      1n,
      44941127272049826721201904734628716258498742255959991581049806490182030242267n,
      9910254599581058084911561569808925251374718953855182016200087235935345969636n,
      usePrecompiled,
    ],
  );
}

/**
 * The calls that install a PERMISSION validator on a Kernel v3.3 account, as the SDK's own `toInitConfig`
 * builds them: `installValidations` for validation id `0x02 ++ permissionId`, then `grantAccess` so that
 * validator may be used for the `execute` selector. (The SDK's `getValidatorPluginInstallModuleData` is
 * for ordinary validators; used for a permission it reverts with no reason. Observed live on Celo Sepolia.)
 * `nonce` must equal the account's current validator nonce: 1 on a fresh account, read from the chain
 * otherwise.
 */
export async function permissionInstallCalls(
  account: Address,
  plugin: { getIdentifier(): Hex; getEnableData(): Promise<Hex> },
  currentNonce: number,
): Promise<{ to: Address; data: Hex; value: bigint }[]> {
  const validationId = pad(concat([VALIDATOR_TYPE.PERMISSION, plugin.getIdentifier()]), {
    size: 21,
    dir: "right",
  });
  return [
    {
      to: account,
      value: 0n,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "installValidations",
        args: [
          [validationId],
          [{ nonce: currentNonce, hook: zeroAddress }],
          [await plugin.getEnableData()],
          ["0x"],
        ],
      }),
    },
    {
      to: account,
      value: 0n,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "grantAccess",
        args: [validationId, toFunctionSelector("execute(bytes32,bytes)"), true],
      }),
    },
  ];
}

export interface FeePair {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * The fee floor a bundler publishes with `pimlico_getUserOperationGasPrice` (its "standard" tier), or null. Pimlico on Celo refuses a
 * maxFeePerGas below its own price, which is well above the node's estimate. A bundler without the method (Alchemy, ZeroDev), an
 * error, a timeout, a non-JSON answer or a malformed price all give null, so preparing an operation is never broken by this extension
 * and nothing about the request or the failure (the URL carries the API key) is thrown, logged or returned.
 */
export async function readBundlerFeeFloor(
  bundlerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FeePair | null> {
  try {
    const response = await fetchImpl(bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "pimlico_getUserOperationGasPrice",
        params: [],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as {
      result?: { standard?: { maxFeePerGas?: unknown; maxPriorityFeePerGas?: unknown } };
    };
    const standard = body.result?.standard;
    const hex = /^0x[0-9a-fA-F]{1,32}$/;
    if (
      typeof standard?.maxFeePerGas !== "string" ||
      typeof standard.maxPriorityFeePerGas !== "string" ||
      !hex.test(standard.maxFeePerGas) ||
      !hex.test(standard.maxPriorityFeePerGas)
    ) {
      return null;
    }
    const floor = {
      maxFeePerGas: BigInt(standard.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas),
    };
    return floor.maxFeePerGas > 0n ? floor : null;
  } catch {
    return null;
  }
}

/** The higher of the chain's fee and the bundler's floor, each field on its own. */
export function pickFees(chain: FeePair, floor: FeePair | null): FeePair {
  if (!floor) {
    return { maxFeePerGas: chain.maxFeePerGas, maxPriorityFeePerGas: chain.maxPriorityFeePerGas };
  }
  return {
    maxFeePerGas: floor.maxFeePerGas > chain.maxFeePerGas ? floor.maxFeePerGas : chain.maxFeePerGas,
    maxPriorityFeePerGas:
      floor.maxPriorityFeePerGas > chain.maxPriorityFeePerGas
        ? floor.maxPriorityFeePerGas
        : chain.maxPriorityFeePerGas,
  };
}

export function createZeroDevKernelAdapter(
  config: ZeroDevKernelAdapterConfig,
): KernelExecutionPort {
  const network = config.network ?? CELO_MAINNET_KERNEL_NETWORK;
  const { chain } = network;
  const client = createPublicClient({ chain, transport: http(config.rpcUrl) });
  // Fees come from the chain, not from a bundler-specific method: the SDK's default asks the bundler for
  // `zd_getUserOperationGasPrice`, which only ZeroDev's own bundler implements (Alchemy's answers
  // "Unsupported method"). Observed live on Celo Sepolia.
  // A bundler may enforce a higher floor than the chain's own estimate (see `readBundlerFeeFloor`). The operation uses the HIGHER of
  // the two; a bundler that does not publish a price changes nothing.
  const estimateFeesPerGas = async () => {
    const chainFees = await client.estimateFeesPerGas();
    return pickFees(chainFees, await readBundlerFeeFloor(config.bundlerUrl));
  };
  const bundler = createBundlerClient({ client, transport: http(config.bundlerUrl) });
  const tagged = (callData: Hex): Hex =>
    config.attributionSuffix ? concat([callData, config.attributionSuffix]) : callData;

  /** The Kernel account whose root validator is the user's root credential, optionally with a permission. */
  async function rootAccount(
    credential: RootCredential,
    signature: { value: Hex },
    permission?: { scope: PermissionScope; sessionKeyAddress: Address },
    /**
     * The address of a DEPLOYED account. A wallet whose root was rotated or recovered no longer has the root it was created
     * with, so its address cannot be derived from its root: it is taken as given (the chain is the authority on a deployed
     * account), and the SDK only needs the current root to sign for it.
     */
    existing?: Address,
  ) {
    const validator = await toRootValidator(client, credential, {
      ...(network.passkeyValidatorAddress && {
        passkeyValidatorAddress: network.passkeyValidatorAddress,
      }),
    });
    // The signature is supplied from outside (the client's proof); the SDK never opens a prompt or signs.
    const sudo = {
      ...validator,
      signUserOperation: () => Promise.resolve(signature.value),
      // Gas is estimated with a stub signature of the same SHAPE as the real one. For a passkey the SDK's stub
      // selects the on-chain fallback P-256 verifier, which does not exist on every chain (e.g. Celo Sepolia):
      // validation then reverts (AA23) before any estimate. The stub must take the same verification path.
      getStubSignature: () =>
        Promise.resolve(
          credential.type === "PASSKEY"
            ? stubPasskeySignature(network.p256Precompile)
            : deviceKeyStubSignature(credential.keyId as Hex),
        ),
    };
    const account = await createKernelAccount(client, {
      plugins: { sudo: sudo as never },
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_3,
      ...(existing && { address: existing }),
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
    const c = value as Partial<Record<string, unknown>> | null;
    const text = (key: string): string | undefined => {
      const field = c?.[key];
      return typeof field === "string" && field.length > 0 ? field : undefined;
    };
    const x = text("publicKeyX");
    const y = text("publicKeyY");
    if (!x || !y) throw new Error("the prepared operation has no credential");
    if (c?.["type"] === "DEVICE_KEY") {
      const keyId = text("keyId");
      const validatorAddress = text("validatorAddress");
      if (!keyId || !validatorAddress) throw new Error("the prepared operation has no credential");
      return {
        type: "DEVICE_KEY",
        keyId,
        publicKeyX: x,
        publicKeyY: y,
        validatorAddress,
        purpose: typeof c["purpose"] === "number" ? c["purpose"] : 0,
        deploymentSalt: text("deploymentSalt") ?? `0x${"00".repeat(32)}`,
      };
    }
    const credentialId = text("credentialId");
    const rpId = text("rpId");
    if (!credentialId || !rpId) throw new Error("the prepared operation has no credential");
    const validatorAddress = text("validatorAddress");
    return {
      type: "PASSKEY",
      credentialId,
      publicKeyX: x,
      publicKeyY: y,
      rpId,
      ...(validatorAddress && { validatorAddress }),
    };
  };

  /** Encodes a root's proof for the validator of its type. A proof of the other type is refused. */
  const encodeProof = (credential: RootCredential, proof: RootProof): Hex => {
    if (credential.type !== proof.type) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the proof is not for this wallet's root type");
    }
    if (proof.type === "PASSKEY") {
      return encodePasskeyAssertion(proof.assertion, network.p256Precompile);
    }
    if (
      credential.type !== "DEVICE_KEY" ||
      proof.keyId.toLowerCase() !== credential.keyId.toLowerCase()
    ) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the proof is not for this device key");
    }
    return encodeDeviceProof(proof);
  };

  return {
    async isDeployed(address) {
      const code = await client.getCode({ address: address as Address });
      return code !== undefined && code !== "0x";
    },

    nativeBalance: (address) => client.getBalance({ address: address as Address }),

    async prepareRootOperation(input): Promise<PreparedRootOperation> {
      try {
        // A fresh key for THIS permission, when one is installed. Its private half leaves this function once, wrapped.
        const key = input.permission ? generatePrivateKey() : undefined;
        const sessionKeyAddress = key ? privateKeyToAccount(key).address : undefined;
        const stub = { value: "0x" as Hex };
        const walletAddress = input.walletAddress as Address;
        const code = await client.getCode({ address: walletAddress });
        const deployed = code !== undefined && code !== "0x";
        const { account, permissionPlugin } = await rootAccount(
          input.credential,
          stub,
          input.permission && sessionKeyAddress
            ? { scope: input.permission.scope, sessionKeyAddress }
            : undefined,
          // A deployed account is taken as it is on chain; an undeployed one MUST derive from its root.
          deployed ? walletAddress : undefined,
        );
        if (account.address.toLowerCase() !== input.walletAddress.toLowerCase()) {
          throw new Error("the rebuilt account does not match the wallet address");
        }
        if (input.permission && !permissionPlugin) throw new Error("no permission plugin");
        stub.value =
          input.credential.type === "PASSKEY"
            ? stubPasskeySignature(network.p256Precompile)
            : deviceKeyStubSignature(input.credential.keyId as Hex);
        // A fresh account's validator nonce is 1; a deployed one is read from the chain.
        const nonce = deployed
          ? Number(
              await client.readContract({
                address: account.address,
                abi: KernelV3_3AccountAbi,
                functionName: "currentNonce",
              }),
            )
          : 1;
        const installCalls = permissionPlugin
          ? await permissionInstallCalls(account.address, permissionPlugin, nonce)
          : [];
        const calls = [
          ...installCalls,
          ...input.calls.map((call) => ({
            to: call.to as Address,
            data: call.data as Hex,
            value: BigInt(call.value),
          })),
        ];
        const accountClient = createKernelAccountClient({
          account,
          chain,
          bundlerTransport: http(config.bundlerUrl),
          client,
          userOperation: { estimateFeesPerGas },
        });
        const userOperation = await accountClient.prepareUserOperation({
          callData: tagged(await account.encodeCalls(calls)),
        });
        const hash = getUserOperationHash({
          userOperation: { ...userOperation, signature: "0x" },
          entryPointAddress: ENTRY_POINT.address,
          entryPointVersion: ENTRY_POINT.version,
          chainId: chain.id,
        });
        return {
          challenge: hash,
          prepared: {
            credential: { ...input.credential },
            ...(input.permission && {
              scope: JSON.parse(JSON.stringify(input.permission.scope)) as JsonObject,
            }),
            ...(sessionKeyAddress && { sessionKeyAddress }),
            userOperation: toJsonSafe({ ...userOperation, signature: "0x" }) as JsonObject,
          },
          ...(key &&
            sessionKeyAddress && {
              sessionKey: { address: sessionKeyAddress, privateKey: new SecretValue(key) },
            }),
        };
      } catch (error) {
        throw classify(error);
      }
    },

    async sendRootOperation(input) {
      try {
        const credential = toCredential(input.prepared["credential"]);
        const rawScope = input.prepared["scope"] as
          (PermissionScope & { validFrom: string; expiresAt: string }) | undefined;
        const scope: PermissionScope | undefined = rawScope && {
          ...rawScope,
          validFrom: new Date(rawScope.validFrom),
          expiresAt: new Date(rawScope.expiresAt),
        };
        const sessionKeyAddress = input.prepared["sessionKeyAddress"] as Address | undefined;
        const signature = { value: encodeProof(credential, input.proof) };
        const userOperation = fromJsonSafe(input.prepared["userOperation"]) as Record<
          string,
          unknown
        >;
        const sender = userOperation["sender"] as Address;
        const senderCode = await client.getCode({ address: sender });
        const { account, permissionPlugin } = await rootAccount(
          credential,
          signature,
          scope && sessionKeyAddress ? { scope, sessionKeyAddress } : undefined,
          senderCode && senderCode !== "0x" ? sender : undefined,
        );
        // The operation hash was fixed when the challenge was issued; the signature covers exactly it.
        const signed = { ...userOperation, signature: signature.value };
        const userOpHash = config.submitUserOperation
          ? await config.submitUserOperation(signed)
          : await bundler.sendUserOperation({
              ...signed,
              entryPointAddress: ENTRY_POINT.address,
            } as never);
        if (!permissionPlugin) return { userOpHash };
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
      // Rebuild the permission exactly as it was installed, then read the account's own record of it.
      const policies = policiesForScope(input.scope);
      const plugin = await toPermissionValidator(client, {
        signer: toEmptyECDSASigner(input.sessionKeyAddress as Address),
        policies,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_3,
      });
      // Kernel v3 identifies a permission by 4 bytes derived from its policy contracts and its signer.
      const permissionId = plugin.getIdentifier();
      if (!HEX.test(permissionId) || permissionId.length !== 10) return false;
      try {
        const config = await client.readContract({
          address: input.walletAddress as Address,
          abi: KernelV3_3AccountAbi,
          functionName: "permissionConfig",
          args: [permissionId],
        });
        // What the chain records: the signer module and the ordered list of policy contracts (flag ++
        // address). Both must be exactly what this scope builds. The policies' PARAMETERS are held inside
        // the policy contracts and are bound by the enable data the passkey signed in the same operation;
        // they are proven by behaviour (refusals), not by this read.
        const expected = policies.map((policy) => policy.getPolicyInfoInBytes().toLowerCase());
        const actual = config.policyData.map((entry) => entry.toLowerCase());
        return (
          config.signer.toLowerCase() === ECDSA_SIGNER_CONTRACT.toLowerCase() &&
          actual.length === expected.length &&
          actual.every((entry, index) => entry === expected[index])
        );
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
          chain,
          bundlerTransport: http(config.bundlerUrl),
          client,
          userOperation: { estimateFeesPerGas },
        });
        const callData = tagged(
          await account.encodeCalls(
            input.calls.map((call: AccountCall) => ({
              to: call.to as Address,
              data: call.data as Hex,
              value: BigInt(call.value),
            })),
          ),
        );
        // Prepare and sign first, so the hash is KNOWN before anything is submitted.
        const prepared = await accountClient.prepareUserOperation({ callData });
        const signature = await account.signUserOperation(prepared);
        const signed = { ...prepared, signature };
        const userOpHash = getUserOperationHash({
          userOperation: signed,
          entryPointAddress: ENTRY_POINT.address,
          entryPointVersion: ENTRY_POINT.version,
          chainId: chain.id,
        });
        await input.beforeSubmit?.(userOpHash);
        if (config.submitUserOperation) {
          await config.submitUserOperation(signed);
        } else {
          await bundler.sendUserOperation({
            ...signed,
            entryPointAddress: ENTRY_POINT.address,
          });
        }
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
        if ((error as { name?: unknown } | null)?.name !== "UserOperationReceiptNotFoundError") {
          throw error;
        }
      }
      // The bundler does not (yet) know it. The chain does not depend on any bundler's index: the
      // EntryPoint emits UserOperationEvent with the hash as an indexed topic. Observed live: an operation
      // that was mined (by another submitter) while the bundler still reported it pending.
      const latest = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: ENTRY_POINT.address,
        event: USER_OPERATION_EVENT,
        args: { userOpHash: userOpHash as Hex },
        fromBlock: latest > RECEIPT_LOOKBACK_BLOCKS ? latest - RECEIPT_LOOKBACK_BLOCKS : 0n,
        toBlock: latest,
      });
      const found = logs[0];
      if (!found?.transactionHash || found.blockNumber === null) return { status: "PENDING" };
      return {
        status: "INCLUDED",
        success: found.args.success === true,
        txHash: found.transactionHash,
        blockNumber: found.blockNumber.toString(),
      };
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
