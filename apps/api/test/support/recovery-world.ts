import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

import {
  deriveRecoveryKey,
  generateRecoveryCode,
  recoveryDomain,
  recoveryInitiateTypes,
} from "@kaada/contracts";
import type { RecoveryCode } from "@kaada/contracts";
import { KERNEL_ENFORCEMENT } from "@kaada/blockchain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import { KaadaError } from "@kaada/domain";
import type {
  ChannelMessage,
  ChannelMessenger,
  IdentityType,
  PasskeyVerifier,
  RecoveryAttempt,
  RecoveryEmailSender,
  RecoveryTypedData,
  VerifiedRegistration,
  Wallet,
} from "@kaada/domain";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import type { AuthorizationUnitOfWork } from "../../src/core/authorization/ports.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import type { RecoveryContext } from "../../src/core/recovery/context.js";
import { RecoveryNotifier } from "../../src/core/recovery/notifier.js";
import { DEFAULT_RECOVERY_POLICY } from "../../src/core/recovery/ports.js";
import type {
  RecoveryPolicy,
  RecoveryRepositories,
  RecoveryUnitOfWork,
} from "../../src/core/recovery/ports.js";
import { RecoveryCleanup } from "../../src/core/recovery/recovery-cleanup.js";
import { RecoveryConfigurationService } from "../../src/core/recovery/recovery-configuration.js";
import { RecoveryFinalizer } from "../../src/core/recovery/recovery-finalizer.js";
import { RecoveryFlowService } from "../../src/core/recovery/recovery-flow.js";
import { RecoveryTotpService } from "../../src/core/recovery/recovery-totp.js";
import { stepAt, totpAtStep } from "../../src/core/recovery/totp.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";
import { DefaultRecoveryRiskPolicy } from "../../src/core/recovery/risk-policy.js";
import { createAuthorizationStores } from "./authorization-memory.js";
import { createFirmStores } from "./firm-memory.js";
import { TestPinHasher } from "./payment-world.js";
import { FakeRecoveryChain } from "./recovery-chain.js";
import { createRecoveryStores } from "./recovery-memory.js";
import { createWalletWorld } from "./wallet-memory.js";

export const SHARED_VALIDATOR = "0x6cf0c0a61f0a3aa76d4886b455eed781aa8f9cb6";
const WEB_URL = "https://app.kaada.test";

export class OutboxEmailSender implements RecoveryEmailSender {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  fail = false;

  send(input: { to: string; subject: string; text: string }): Promise<void> {
    if (this.fail) return Promise.reject(new Error("smtp down"));
    this.sent.push({ ...input });
    return Promise.resolve();
  }

  /** The newest 6-digit code sent to `to`. */
  codeFor(to: string): string {
    const mail = [...this.sent]
      .reverse()
      .find((m) => m.to === to && /verification code is \d{6}/.test(m.text));
    const code = /verification code is (\d{6})/.exec(mail?.text ?? "")?.[1];
    if (!code) throw new Error(`no code was sent to ${to}`);
    return code;
  }
}

export class RecordingMessenger implements ChannelMessenger {
  readonly sent: { type: IdentityType; externalId: string; message: ChannelMessage }[] = [];
  fail = false;

  constructor(private readonly types: IdentityType[]) {}

  supports(type: IdentityType): boolean {
    return this.types.includes(type);
  }

  send(
    identity: { type: IdentityType; externalId: string },
    message: ChannelMessage,
  ): Promise<void> {
    if (this.fail) return Promise.reject(new Error("channel down"));
    this.sent.push({ ...identity, message });
    return Promise.resolve();
  }
}

/** A passkey verifier that accepts a registration the test constructed (the WebAuthn crypto is covered elsewhere). */
class FakePasskeyVerifier implements PasskeyVerifier {
  verifyRegistration(input: { response: unknown }): Promise<VerifiedRegistration | null> {
    const response = input.response as { id?: string; x?: string; y?: string; reject?: boolean };
    if (response.reject || !response.id || !response.x || !response.y) return Promise.resolve(null);
    return Promise.resolve({
      credentialId: response.id,
      publicKeyX: response.x,
      publicKeyY: response.y,
      signCount: 0,
    });
  }

  verifyAuthentication(): Promise<{ newSignCount: number } | null> {
    return Promise.resolve(null);
  }
}

export interface TestUser {
  email: string;
  userId: string;
  wallet: Wallet & { address: string };
  account: string;
  /** The person Recovery Code. In tests only; the server never sees it. */
  code: RecoveryCode;
  recoveryKey: { privateKey: Hex; address: Address };
  rootCredentialId: string;
  /** The base32 secret in the person's authenticator app. In tests only; the server keeps it encrypted. */
  authenticatorSecret?: string;
}

export interface NewRoot {
  kind: "PASSKEY" | "DEVICE_KEY";
  /** What the NEW device holds. */
  credentialRef: string;
  publicKeyX: string;
  publicKeyY: string;
}

export function newPasskeyRoot(): NewRoot {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kind: "PASSKEY",
    credentialRef: randomBytes(32).toString("base64url"),
    publicKeyX: Buffer.from(jwk.x ?? "", "base64url").toString("hex"),
    publicKeyY: Buffer.from(jwk.y ?? "", "base64url").toString("hex"),
  };
}

import type { DeviceTierResolver } from "../../src/core/attestation/device-tier-service.js";

export async function newDeviceRoot(): Promise<NewRoot> {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = {
    x: BigInt(`0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`),
    y: BigInt(`0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`),
  };
  const { deviceKeyIdFromPoint } = await import("@kaada/contracts");
  return {
    kind: "DEVICE_KEY",
    credentialRef: deviceKeyIdFromPoint(point),
    publicKeyX: point.x.toString(16).padStart(64, "0"),
    publicKeyY: point.y.toString(16).padStart(64, "0"),
  };
}

export const TEST_POLICY: RecoveryPolicy = {
  ...DEFAULT_RECOVERY_POLICY,
  inclusionWaitMs: 40,
  emailResendCooldownMs: 1_000,
};

export function createRecoveryWorld(
  options: {
    policy?: Partial<RecoveryPolicy>;
    webUrl?: string;
    database?: Database;
    deviceTiers?: DeviceTierResolver;
    totpLimiter?: { allow(key: string): boolean | Promise<boolean> };
  } = {},
) {
  // Fake time that still advances in real time, so bounded waits end; tests jump it with `advance`.
  let base = new Date("2026-10-20T12:00:00.000Z").getTime();
  let realAtBase = Date.now();
  const now = () => new Date(base + (Date.now() - realAtBase));
  const advance = (ms: number) => {
    base = now().getTime() + ms;
    realAtBase = Date.now();
  };

  const wallet = createWalletWorld();
  const auth = createAuthorizationStores(now);
  const firm = createFirmStores();
  const recovery = createRecoveryStores(now);
  const chain = new FakeRecoveryChain(now);

  const database = options.database;
  const db = database ? createRepositories(database) : null;
  const memoryRepositories: RecoveryRepositories = {
    identities: recovery.repositories.identities,
    wallets: wallet.repositories.wallets,
    passkeys: wallet.repositories.passkeys,
    walletCredentials: recovery.repositories.walletCredentials,
    recoveryConfigurations: recovery.repositories.recoveryConfigurations,
    recoveryAttempts: recovery.repositories.recoveryAttempts,
    recoveryEmailChallenges: recovery.repositories.recoveryEmailChallenges,
    recoveryTotps: recovery.repositories.recoveryTotps,
    recoveryCleanup: recovery.repositories.recoveryCleanup,
    delegatedPermissions: wallet.repositories.delegatedPermissions,
    executionSecrets: firm.repositories.executionSecrets,
    transactionPins: auth.repositories.transactionPins,
    walletSetupSessions: wallet.repositories.walletSetupSessions,
    audit: wallet.repositories.audit,
  };
  // With a database the SAME services run over the real repositories and real transactions.
  const repositories: RecoveryRepositories = db ?? memoryRepositories;
  const uow: RecoveryUnitOfWork = database
    ? {
        read: repositories,
        transaction: (work) => withTransaction(database, work, { timeoutMs: 60_000 }),
      }
    : {
        read: repositories,
        transaction: (work) => work(repositories),
      };

  const email = new OutboxEmailSender();
  const telegram = new RecordingMessenger(["TELEGRAM"]);
  const emailMessenger: ChannelMessenger = {
    supports: (type) => type === "EMAIL",
    send: (identity, message) => email.send({ to: identity.externalId, ...message }),
  };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const log = (level: string, event: string, fields: Record<string, unknown>) =>
    void logs.push({ level, event, fields });
  const notifier = new RecoveryNotifier({
    identities: repositories.identities,
    audit: repositories.audit,
    messengers: [emailMessenger, telegram],
    log: log,
  });

  // A DEDICATED key for the authenticator secrets, exactly as production configures it.
  const totpKey = randomBytes(32).toString("base64");
  const totpCipher = new AesGcmSecretCipher([{ version: 1, key: totpKey }]);
  const totp = new RecoveryTotpService({
    totps: repositories.recoveryTotps,
    audit: repositories.audit,
    cipher: totpCipher,
    now,
    ...(options.totpLimiter && { limiter: options.totpLimiter }),
  });

  const policy: RecoveryPolicy = { ...TEST_POLICY, ...options.policy };
  const context: RecoveryContext = {
    uow,
    chain,
    totp,
    email,
    notifier,
    risk: new DefaultRecoveryRiskPolicy(policy),
    policy,
    passkeyVerifier: new FakePasskeyVerifier(),
    rpId: "kaada.test",
    origin: "https://app.kaada.test",
    webUrl: options.webUrl ?? WEB_URL,
    challengeSecret: randomBytes(32),
    now,
    log: log,
  };

  const pins = new TransactionPinService({
    // The PIN rows are the same ones cleanup marks: in memory or in Postgres, whichever the world runs on.
    unitOfWork: {
      read: repositories,
      transaction: (work: (r: typeof repositories) => Promise<unknown>) => work(repositories),
    } as unknown as AuthorizationUnitOfWork,
    hasher: new TestPinHasher(),
    now,
  });

  const flow = new RecoveryFlowService({
    context,
    ...(options.deviceTiers && { deviceTiers: options.deviceTiers }),
  });
  const cleanup = new RecoveryCleanup(context);
  const finalizer = (owner?: string) =>
    new RecoveryFinalizer({ context, flow, cleanup, pins, pollMs: 2, ...(owner && { owner }) });
  const configuration = new RecoveryConfigurationService(context);

  // ───────────────────────────── people ─────────────────────────────

  let counter = 0;
  /**
   * A person with an email, an ACTIVE wallet whose root is a passkey (or a device key) on a deployed account, and an ARMED
   * recovery whose Recovery Code only the test knows.
   */
  async function createUser(
    input: {
      email?: string;
      rootKind?: "PASSKEY" | "DEVICE_KEY";
      armed?: boolean;
      telegram?: boolean;
      delay?: number;
      /** Armed recovery normally has an authenticator app too; false builds a wallet that never set one up. */
      authenticator?: boolean;
    } = {},
  ): Promise<TestUser> {
    counter += 1;
    const userId = randomUUID();
    const unique = randomUUID().replace(/-/g, "");
    const email = input.email ?? `person${counter}.${unique.slice(0, 8)}@example.com`;
    const address = `0x${unique}${randomBytes(4).toString("hex")}`.toLowerCase();
    if (db) await db.users.create({ id: userId });
    await repositories.identities.add({
      id: randomUUID(),
      userId,
      type: "EMAIL",
      externalId: email,
    });
    if (input.telegram) {
      await repositories.identities.add({
        id: randomUUID(),
        userId,
        type: "TELEGRAM",
        externalId: `tg${randomUUID().slice(0, 8)}`,
      });
    }
    const created = await repositories.wallets.create({
      id: randomUUID(),
      userId,
      chainId: 42220,
      isPrimary: true,
      type: "EMBEDDED",
      status: "PROVISIONING",
      deployment: "NOT_APPLICABLE",
    });
    const active = await repositories.wallets.activate(created.id, {
      address,
      deployment: "DEPLOYED",
      provider: "test",
      at: now(),
    });
    if (!active?.address) throw new Error("wallet was not activated");
    const rootKind = input.rootKind ?? "PASSKEY";
    const rootRef =
      rootKind === "PASSKEY"
        ? randomBytes(32).toString("base64url")
        : `0x${randomBytes(32).toString("hex")}`;
    const root = rootKind === "PASSKEY" ? newPasskeyRoot() : await newDeviceRoot();
    if (rootKind === "PASSKEY") {
      await repositories.passkeys.create({
        id: randomUUID(),
        userId,
        credentialId: root.credentialRef,
        publicKeyX: root.publicKeyX,
        publicKeyY: root.publicKeyY,
        rpId: "kaada.test",
      });
    }
    const code = generateRecoveryCode();
    const recoveryKey = deriveRecoveryKey(code, {
      chainId: chain.chainId,
      account: address as Address,
    });
    const armed = input.armed ?? true;
    const validator =
      rootKind === "PASSKEY" ? SHARED_VALIDATOR : `0x${counter.toString(16).padStart(40, "d")}`;
    chain.seedAccount({
      address,
      root: { validator, kind: rootKind, credentialRef: root.credentialRef },
      ...(armed && {
        recovery: { recoveryKey: recoveryKey.address, delay: input.delay ?? 72 * 3600 },
      }),
    });
    const credential = await repositories.walletCredentials.create({
      id: randomUUID(),
      userId,
      walletId: active.id,
      kind: rootKind,
      role: "PRIMARY",
      status: "ACTIVE",
      isRoot: true,
      validatorAddress: validator,
      validatorPurpose: 0,
      deploymentSalt: `0x${"0".repeat(64)}`,
      credentialRef: root.credentialRef,
      publicKeyX: root.publicKeyX,
      publicKeyY: root.publicKeyY,
      ...(rootKind === "PASSKEY" && { rpId: "kaada.test" }),
      securityTier: "UNKNOWN",
    });
    void rootRef;
    if (armed) {
      const configurationRow = await repositories.recoveryConfigurations.create({
        id: randomUUID(),
        userId,
        walletId: active.id,
        chainId: chain.chainId,
        validatorAddress: chain.recoveryValidator,
        recoveryAddress: recoveryKey.address.toLowerCase(),
        delaySeconds: input.delay ?? 72 * 3600,
        status: "ACTIVE",
        armedByCredentialId: credential.id,
        recoveryNonce: "0",
      });
      void configurationRow;
    }
    let authenticatorSecret: string | undefined;
    if (input.authenticator ?? armed) {
      // Enrolled exactly as a person does: begin, read the secret, enter a code from the app.
      const enrolment = await totp.begin({
        userId,
        walletId: active.id,
        accountName: email,
      });
      authenticatorSecret = enrolment.secret;
      await totp.confirm({
        userId,
        walletId: active.id,
        code: totpAtStep(enrolment.secret, stepAt(now().getTime())),
      });
      // The enrolment spent this time step. A person waits for the app's next code; so does the test world.
      advance(31_000);
    }
    return {
      ...(authenticatorSecret && { authenticatorSecret }),
      email,
      userId,
      wallet: active as Wallet & { address: string },
      account: address,
      code,
      recoveryKey,
      rootCredentialId: credential.id,
    };
  }

  // ───────────────────────── the person on the new device ─────────────────────────

  /** start -> email code -> verify. Returns the session token. */
  async function startAndVerify(email: string): Promise<string> {
    const { token } = await flow.start({ email });
    await flow.verifyEmail(token, email_code(email));
    return token;
  }
  const email_code = (to: string) => email_outbox.codeFor(to);
  const email_outbox = email;

  /** The person registers the NEW credential and signs the commitment with their Recovery Code. */
  async function proposeAndSign(
    user: TestUser,
    token: string,
    root: NewRoot,
    options: { code?: RecoveryCode; channel?: "web" | "native-ios" | "unknown" } = {},
  ) {
    const proposal =
      root.kind === "PASSKEY"
        ? await (async () => {
            const begin = await flow.beginNewPasskey(token);
            return flow.proposePasskeyRoot(token, {
              id: root.credentialRef,
              x: root.publicKeyX,
              y: root.publicKeyY,
              response: {
                clientDataJSON: Buffer.from(
                  JSON.stringify({ challenge: begin.challenge }),
                ).toString("base64url"),
              },
            });
          })()
        : await flow.proposeDeviceRoot(token, {
            publicKeyX: root.publicKeyX,
            publicKeyY: root.publicKeyY,
            channel: options.channel ?? "web",
          });
    const signature = await signProposal(
      proposal.typedData,
      options.code ?? user.code,
      user.account as Address,
    );
    return { proposal, signature };
  }

  /** What the page does: derive the key from the typed Recovery Code and sign the typed data it was given. */
  async function signProposal(
    typedData: RecoveryTypedData,
    code: RecoveryCode,
    account: Address,
  ): Promise<Hex> {
    const { privateKey } = deriveRecoveryKey(code, { chainId: chain.chainId, account });
    return privateKeyToAccount(privateKey).signTypedData({
      domain: recoveryDomain(
        typedData.domain.chainId,
        typedData.domain.verifyingContract as Address,
      ),
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message: {
        account: typedData.message["account"] as Address,
        nonce: BigInt(typedData.message["nonce"] ?? "0"),
        rootId: typedData.message["rootId"] as Hex,
        hook: typedData.message["hook"] as Address,
        validatorDataHash: typedData.message["validatorDataHash"] as Hex,
        hookDataHash: typedData.message["hookDataHash"] as Hex,
        deadline: BigInt(typedData.message["deadline"] ?? "0"),
      },
    });
  }

  /**
   * The code the person's authenticator app shows now (or `steps` time steps away). A code can be used once: a second use needs
   * the clock to have moved on to the next time step (`advance`).
   */
  function authenticatorCode(user: TestUser, steps = 0): string {
    if (!user.authenticatorSecret) throw new Error("this user has no authenticator app");
    return totpAtStep(user.authenticatorSecret, stepAt(now().getTime()) + steps);
  }

  /** A code is single use: if this wallet's current time step was already spent, wait for the app's next code. */
  function nextAuthenticatorStep(user: TestUser): void {
    const row = recovery.totps.find((t) => t.walletId === user.wallet.id && t.status === "ACTIVE");
    const last = row?.lastUsedStep;
    const current = stepAt(now().getTime());
    if (last !== undefined && last >= current) advance((last + 1 - current) * 30_000 + 1_000);
  }

  /** The whole happy path up to a PENDING recovery on chain. */
  async function startRecovery(user: TestUser, root: NewRoot = newPasskeyRoot()) {
    nextAuthenticatorStep(user);
    const token = await startAndVerify(user.email);
    const { proposal, signature } = await proposeAndSign(user, token, root);
    const view = await flow.submitProof(token, signature, authenticatorCode(user));
    const attempt = await attemptOf(token);
    return { token, proposal, signature, view, attempt, root };
  }

  async function attemptOf(token: string): Promise<RecoveryAttempt> {
    const { hashOpaqueToken } = await import("../../src/core/authorization/token.js");
    const found = await repositories.recoveryAttempts.findByTokenHash(hashOpaqueToken(token));
    if (!found) throw new Error("no attempt for token");
    return found;
  }

  /** The cancel token the notification carried (the only place it exists). */
  function cancelTokenFrom(user: TestUser): string {
    const mail = [...email.sent]
      .reverse()
      .find((m) => m.to === user.email && m.text.includes("/recovery/cancel#"));
    const token = /\/recovery\/cancel#([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1];
    if (!token) throw new Error("no cancel link was sent");
    return token;
  }

  /** An ACTIVE delegated permission with an encrypted session key and approval, installed as a lane on chain. */
  async function addPermission(user: TestUser, providerPermissionId = "0xabcdef01") {
    const sessionSecretId = randomUUID();
    const approvalSecretId = randomUUID();
    for (const [id, purpose] of [
      [sessionSecretId, "SESSION_KEY"],
      [approvalSecretId, "PERMISSION_APPROVAL"],
    ] as const) {
      await repositories.executionSecrets.put({
        id,
        purpose,
        keyVersion: 1,
        ciphertext: "v1.abc.def",
        now: now(),
      });
    }
    const permissionId = randomUUID();
    // A real asset when a database is attached (the limit references one).
    const assetId = db ? ((await db.assets.listActive())[0]?.id ?? randomUUID()) : randomUUID();
    await repositories.delegatedPermissions.create({
      id: permissionId,
      userId: user.userId,
      walletId: user.wallet.id,
      provider: "test",
      chainId: 42220,
      status: "PENDING",
      allowedOperations: ["TRANSFER_TOKEN"],
      allowedContracts: ["0x00000000000000000000000000000000000000aa"],
      allowedAssetIds: [assetId],
      perTransactionLimit: { amount: "100", assetId },
      enforcement: KERNEL_ENFORCEMENT,
      validFrom: new Date(now().getTime() - 1000),
      expiresAt: new Date(now().getTime() + 86_400_000),
    } as never);
    // Exactly the production sequence: keys are attached to a PENDING permission, then it is read back and activated.
    await repositories.delegatedPermissions.attachSessionKey(permissionId, {
      address: "0x00000000000000000000000000000000000000bb",
      sessionKeySecretId: sessionSecretId,
      approvalSecretId,
    });
    await repositories.delegatedPermissions.activate(permissionId, providerPermissionId);
    chain.installPermissionLane(user.account, providerPermissionId);
    return { permissionId, sessionSecretId, approvalSecretId, providerPermissionId };
  }

  /** The payment and session objects a wallet may hold, so cleanup has something to retire. */
  function addPaymentArtifacts(user: TestUser) {
    recovery.extras.authorizationSessions.push({
      id: randomUUID(),
      walletId: user.wallet.id,
      status: "PENDING",
    });
    recovery.extras.paymentAuthorizations.push({
      id: randomUUID(),
      walletId: user.wallet.id,
      status: "ACTIVE",
    });
    recovery.extras.paymentAuthorizations.push({
      id: randomUUID(),
      walletId: user.wallet.id,
      status: "CONSUMED",
    });
    recovery.extras.rootActions.push({ walletId: user.wallet.id, status: "PENDING" });
    recovery.extras.webSessions.push({ userId: user.userId });
    recovery.extras.webSessions.push({ userId: user.userId });
  }

  /** A root signature the fake chain accepts for credential `ref` over `hash`. */
  const rootSigns = (ref: string, hash: string) => ({ credentialRef: ref, signs: hash });

  return {
    now,
    advance,
    wallet,
    auth,
    firm,
    recovery,
    chain,
    repositories,
    uow,
    email,
    telegram,
    logs,
    context,
    policy,
    flow,
    cleanup,
    finalizer,
    configuration,
    pins,
    totp,
    totpCipher,
    authenticatorCode,
    nextAuthenticatorStep,
    createUser,
    startAndVerify,
    proposeAndSign,
    signProposal,
    startRecovery,
    attemptOf,
    cancelTokenFrom,
    rootSigns,
    addPermission,
    addPaymentArtifacts,
  };
}

export type RecoveryWorld = ReturnType<typeof createRecoveryWorld>;

export const expectKaada = async (promise: Promise<unknown>, code: string): Promise<KaadaError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KaadaError) {
      if (error.code !== code)
        throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
      return error;
    }
    throw error;
  }
  throw new Error(`expected a KaadaError ${code}, but the call succeeded`);
};
