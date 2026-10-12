import { randomBytes, randomUUID } from "node:crypto";

import type { ValidatorDeployments } from "@kaada/contracts";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import { KaadaError, SecretValue, createId } from "@kaada/domain";
import type {
  KernelExecutionPort,
  OperationReceipt,
  PasskeyVerifier,
  RootProof,
  RootValidatorDeployer,
  RootValidatorInstance,
  VerifiedRegistration,
  Wallet,
} from "@kaada/domain";
import { decodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";

import { DeviceKeyRootAdapter, PasskeyRootAdapter } from "../../src/core/roots/adapters.js";
import { RootChangeService } from "../../src/core/roots/root-change-service.js";
import type {
  NewCredentialInput,
  PreparedRootChange,
  RootChangeRepositories,
} from "../../src/core/roots/root-change-service.js";
import { RootAdapters, RootCredentialService } from "../../src/core/roots/root-credentials.js";
import { createMemoryRootChanges } from "./credential-memory.js";
import { createFirmStores } from "./firm-memory.js";
import { createRecoveryStores } from "./recovery-memory.js";
import { SoftDeviceKey } from "./soft-device-key.js";
import { createWalletWorld } from "./wallet-memory.js";

/*
 * A root-change world: a person with an ACTIVE wallet on a deployed account whose root is a passkey or a device key, the REAL
 * RootChangeService and root adapters, and a scripted account/bundler. It runs over in-memory stores, or over the real database
 * when one is given (then the SAME service runs over real repositories and real transactions).
 */

export const RP_ID = "kaada.test";
export const ORIGIN = "https://app.kaada.test";
export const CHAIN = 42220;

export const deployments: ValidatorDeployments = {
  passkey: {
    factory: "0x1000000000000000000000000000000000000f01",
    implementation: "0x1000000000000000000000000000000000000a01",
  },
  device: {
    factory: "0x1000000000000000000000000000000000000f02",
    implementation: "0x1000000000000000000000000000000000000a02",
  },
};

const kernelAbi = parseAbi([
  "function changeRootValidator(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData)",
  "function invalidateNonce(uint32 nonce)",
  "function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData)",
  "function grantAccess(bytes21 vId, bytes4 selector, bool allow)",
]);

/** A scripted account: its root, its validator nonce and the validator lanes installed on it. */
export class FakeAccount {
  deployed = true;
  rootValidator = "";
  nonce = 1;
  readonly lanes = new Set<string>();
}

/** The chain reads and the root-signed send of a Kernel account, with just enough semantics to decide what a change did. */
export class FakeNetwork {
  readonly accounts = new Map<string, FakeAccount>();
  readonly sent: { hash: string; proof: RootProof }[] = [];
  /** How the next send behaves. "ambiguous": the operation LANDS but the caller is told nothing definite. */
  mode: "ok" | "reject" | "ambiguous" | "revert" = "ok";
  private readonly prepared = new Map<
    string,
    { account: string; calls: { to: string; data: string }[] }
  >();
  readonly included = new Set<string>();

  account(address: string): FakeAccount {
    const key = address.toLowerCase();
    let account = this.accounts.get(key);
    if (!account) {
      account = new FakeAccount();
      this.accounts.set(key, account);
    }
    return account;
  }

  readonly chain = {
    accountState: (address: string) => {
      const account = this.account(address);
      return Promise.resolve({
        deployed: account.deployed,
        rootValidator: account.deployed ? account.rootValidator : null,
        currentNonce: account.nonce,
      });
    },
    laneVoided: (address: string, laneId: string) =>
      Promise.resolve(!this.account(address).lanes.has(laneId.toLowerCase())),
    validatorLaneId: (validator: string) => `0x01${validator.replace(/^0x/, "").toLowerCase()}`,
  };

  readonly kernel: Pick<
    KernelExecutionPort,
    "prepareRootOperation" | "sendRootOperation" | "getUserOperationReceipt"
  > = {
    prepareRootOperation: (input) => {
      const hash = `0x${randomBytes(32).toString("hex")}`;
      this.prepared.set(hash, {
        account: input.walletAddress.toLowerCase(),
        calls: input.calls.map((call) => ({ to: call.to, data: call.data })),
      });
      return Promise.resolve({ challenge: hash, prepared: { hash } });
    },
    sendRootOperation: (input) => {
      const hash = input.prepared["hash"];
      if (typeof hash !== "string") throw new Error("not a prepared operation");
      this.sent.push({ hash, proof: input.proof });
      if (this.mode === "reject") {
        return Promise.reject(new KaadaError("BUNDLER_REJECTED", "the bundler refused it"));
      }
      if (this.mode !== "revert") this.apply(hash);
      this.included.add(hash);
      if (this.mode === "ambiguous")
        return Promise.reject(new Error("socket closed after sending"));
      return Promise.resolve({ userOpHash: hash, approval: new SecretValue("unused") });
    },
    getUserOperationReceipt: (hash): Promise<OperationReceipt> =>
      Promise.resolve(
        this.included.has(hash)
          ? this.mode === "revert"
            ? { status: "INCLUDED", success: false, txHash: "0x01", blockNumber: "1" }
            : { status: "INCLUDED", success: true, txHash: "0x01", blockNumber: "1" }
          : { status: "NOT_FOUND" },
      ),
  };

  /** Applies a prepared operation the way the Kernel would: change the root, bump the nonce, install lanes. */
  private apply(hash: string): void {
    const op = this.prepared.get(hash);
    if (!op) throw new Error("unknown operation");
    const account = this.account(op.account);
    for (const call of op.calls) {
      const decoded = decodeFunctionData({ abi: kernelAbi, data: call.data as Hex });
      if (decoded.functionName === "changeRootValidator") {
        account.rootValidator = `0x${String(decoded.args[0]).slice(4)}`.toLowerCase();
      } else if (decoded.functionName === "invalidateNonce") {
        account.nonce = Number(decoded.args[0]);
        account.lanes.clear(); // every lane installed before is void
      } else if (decoded.functionName === "installValidations") {
        for (const lane of decoded.args[0]) account.lanes.add(String(lane).toLowerCase());
      }
    }
  }
}

export class FakeValidators implements RootValidatorDeployer {
  readonly deployed: RootValidatorInstance[] = [];
  ensureDeployed(instance: RootValidatorInstance) {
    this.deployed.push(instance);
    return Promise.resolve({ created: true });
  }
}

/** A WebAuthn verifier that accepts what the test constructed (the cryptography is covered elsewhere). */
export class FakeVerifier implements PasskeyVerifier {
  private counter = 0;
  verifyRegistration(input: { response: unknown }): Promise<VerifiedRegistration | null> {
    const response = input.response as { id?: string; x?: string; y?: string };
    if (!response.id || !response.x || !response.y) return Promise.resolve(null);
    return Promise.resolve({
      credentialId: response.id,
      publicKeyX: response.x,
      publicKeyY: response.y,
      signCount: 0,
    });
  }
  verifyAuthentication(input: { response: unknown }): Promise<{ newSignCount: number } | null> {
    return Promise.resolve(
      (input.response as { good?: boolean }).good ? { newSignCount: (this.counter += 1) } : null,
    );
  }
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function build(
  rootType: "PASSKEY" | "DEVICE_KEY",
  options: { database?: Database } = {},
) {
  let base = new Date("2026-10-21T12:00:00.000Z").getTime();
  const now = () => new Date(base);
  const advance = (ms: number) => {
    base += ms;
  };
  const wallet = createWalletWorld();
  const recovery = createRecoveryStores(now);
  const firm = createFirmStores();
  const rootChanges = createMemoryRootChanges(now);
  const memory: RootChangeRepositories = {
    wallets: wallet.repositories.wallets,
    passkeys: wallet.repositories.passkeys,
    walletCredentials: recovery.repositories.walletCredentials,
    rootChanges,
    delegatedPermissions: wallet.repositories.delegatedPermissions,
    executionSecrets: firm.repositories.executionSecrets,
    recoveryCleanup: recovery.repositories.recoveryCleanup,
    walletSetupSessions: wallet.repositories.walletSetupSessions,
    audit: wallet.repositories.audit,
  };
  const database = options.database;
  const db = database ? createRepositories(database) : null;
  const repositories: RootChangeRepositories = db ?? memory;
  const network = new FakeNetwork();
  const validators = new FakeValidators();
  const verifier = new FakeVerifier();
  const device = new DeviceKeyRootAdapter();
  const roots = new RootCredentialService({ repositories, rpId: RP_ID });
  const service = new RootChangeService({
    unitOfWork: database
      ? {
          read: repositories,
          transaction: (work) => withTransaction(database, work, { timeoutMs: 60_000 }),
        }
      : { read: repositories, transaction: (work) => work(repositories) },
    kernel: network.kernel,
    chain: network.chain,
    roots,
    adapters: new RootAdapters(
      new PasskeyRootAdapter({
        verifier,
        passkeys: repositories.passkeys,
        rpId: RP_ID,
        origin: ORIGIN,
        now,
      }),
      device,
    ),
    validators,
    deployments,
    onChainId: CHAIN,
    passkeyVerifier: verifier,
    rpId: RP_ID,
    origin: ORIGIN,
    inclusionWaitMs: 0,
    sleep: () => Promise.resolve(),
    now,
  });

  // A person with an ACTIVE wallet on a deployed account whose root is `rootType`.
  const userId = randomUUID();
  if (db) await db.users.create({ id: userId });
  const created = await repositories.wallets.create({
    id: randomUUID(),
    userId,
    chainId: CHAIN,
    isPrimary: true,
    type: "EMBEDDED",
    status: "PROVISIONING",
    deployment: "NOT_APPLICABLE",
  });
  const address = `0x${randomBytes(20).toString("hex")}`;
  const active = (await repositories.wallets.activate(created.id, {
    address,
    deployment: "DEPLOYED",
    provider: "test",
    at: now(),
  })) as Wallet & { address: string };
  const rootKey = new SoftDeviceKey();
  const passkeyRef = randomBytes(24).toString("base64url");
  const rootValidator = `0x${randomBytes(20).toString("hex")}`;
  if (rootType === "PASSKEY") {
    await repositories.passkeys.create({
      id: randomUUID(),
      userId,
      credentialId: passkeyRef,
      publicKeyX: rootKey.publicKeyX,
      publicKeyY: rootKey.publicKeyY,
      rpId: RP_ID,
    });
  }
  await repositories.walletCredentials.create({
    id: randomUUID(),
    userId,
    walletId: active.id,
    kind: rootType,
    role: "PRIMARY",
    status: "ACTIVE",
    isRoot: true,
    validatorAddress: rootValidator,
    validatorPurpose: 0,
    deploymentSalt: `0x${"00".repeat(32)}`,
    credentialRef: rootType === "PASSKEY" ? passkeyRef : rootKey.keyId,
    publicKeyX: rootKey.publicKeyX,
    publicKeyY: rootKey.publicKeyY,
    ...(rootType === "PASSKEY" && { rpId: RP_ID }),
    securityTier: rootType === "PASSKEY" ? "UNKNOWN" : "WEB_NON_EXTRACTABLE",
  });
  network.account(address).rootValidator = rootValidator;

  /** What the CURRENT root must produce for a prepared change. */
  const sign = (prepared: PreparedRootChange, good = true): RootProof => {
    if (prepared.challenge.type === "PASSKEY") {
      return { type: "PASSKEY", assertion: { id: passkeyRef, good } };
    }
    return rootKey.proof(prepared.challenge.payload, { highS: !good });
  };

  /** A NEW device key, enrolled the way the browser does it (challenge, then a proof of possession). */
  const newDevice = async (): Promise<{ input: NewCredentialInput; key: SoftDeviceKey }> => {
    const key = new SoftDeviceKey();
    const challenge = await service.beginDeviceKey(userId, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    return {
      key,
      input: {
        type: "DEVICE_KEY",
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        ...key.sign(challenge.payload),
      },
    };
  };

  /** A NEW passkey, registered on this device. */
  const newPasskey = async (): Promise<NewCredentialInput> => {
    const options = await service.beginPasskey(userId);
    const fresh = new SoftDeviceKey(); // any valid P-256 point
    return {
      type: "PASSKEY",
      response: {
        id: randomBytes(24).toString("base64url"),
        x: fresh.publicKeyX,
        y: fresh.publicKeyY,
        response: { clientDataJSON: b64({ challenge: options.challenge }) },
      },
    };
  };

  return {
    userId,
    wallet: active,
    address,
    rootKey,
    passkeyRef,
    repositories,
    network,
    validators,
    service,
    roots,
    now,
    advance,
    sign,
    newDevice,
    newPasskey,
    root: () => roots.activeRoot(active),
    credentials: () => repositories.walletCredentials.listForWallet(active.id),
  };
}

/** A permission with a stored session key, so a rotation has something to retire. */
export async function withPermission(
  w: Awaited<ReturnType<typeof build>>,
  assetId: string = createId(),
) {
  const keyId = createId();
  await w.repositories.executionSecrets.put({
    id: keyId,
    purpose: "SESSION_KEY",
    keyVersion: 1,
    ciphertext: "v1.abc.def",
    now: w.now(),
  });
  const permission = await w.repositories.delegatedPermissions.create({
    id: createId(),
    userId: w.userId,
    walletId: w.wallet.id,
    provider: "test",
    chainId: CHAIN,
    status: "PENDING",
    allowedOperations: ["TRANSFER_TOKEN"],
    allowedContracts: [`0x${"11".repeat(20)}`],
    allowedAssetIds: [assetId],
    perTransactionLimit: { assetId, amount: "1" },
    enforcement: {
      contracts: "ONCHAIN",
      operations: "ONCHAIN",
      assets: "ONCHAIN",
      perTransactionLimit: "ONCHAIN",
      cumulativeLimit: "KAADA_POLICY",
      validity: "ONCHAIN",
    },
    validFrom: w.now(),
    expiresAt: new Date(w.now().getTime() + 3_600_000),
  });
  await w.repositories.delegatedPermissions.attachSessionKey(permission.id, {
    address: `0x${"aa".repeat(20)}`,
    sessionKeySecretId: keyId,
  });
  await w.repositories.delegatedPermissions.activate(permission.id, "perm-1");
  return { permission, secretId: keyId };
}
