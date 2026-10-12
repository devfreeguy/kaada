import { createHash, randomBytes } from "node:crypto";

import {
  buildPrimaryRoot,
  classifyDeviceKey,
  deviceKeyIdFromPoint,
  deviceProofPayload,
  isOnP256Curve,
  primaryRootDeploymentSalt,
} from "@kaada/contracts";
import type { AttestationVerifier, ValidatorDeployments } from "@kaada/contracts";
import {
  CELO_CHAIN_ID,
  KaadaError,
  WALLET_AUDIT_EVENTS,
  createId,
  isKaadaError,
  isSetupSessionOpen,
  isSetupSessionViewable,
} from "@kaada/domain";
import type {
  DeviceSecurityTier,
  RootType,
  RootValidatorDeployer,
  UserRepository,
  Wallet,
  WalletSetupSession,
} from "@kaada/domain";
import type { Address, Hex } from "viem";

import { verifyP256 } from "../roots/p256.js";
import type { PasskeyService } from "./passkey-service.js";
import type { WalletRepositories, WalletUnitOfWork } from "./ports.js";
import type { WalletService } from "./wallet-service.js";

/** A setup link is good for this long: enough to open a link and touch an authenticator. */
export const SETUP_SESSION_TTL_MS = 15 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The one hash used for tokens: tokens are 256 random bits, so a fast hash is the right tool. */
export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface WalletSetupServiceDeps {
  unitOfWork: WalletUnitOfWork;
  users: Pick<UserRepository, "findById">;
  passkeys: PasskeyService;
  wallets: WalletService;
  /** The exact web origin that serves the setup page; the link is `${origin}/setup/${token}`. */
  origin: string;
  rpId: string;
  rpName: string;
  /**
   * Device-key onboarding. Absent: a person without passkeys cannot create a wallet here (the route answers "not enabled").
   * `onChainId` is the chain the validator clones run on; `attestationVerifier` stays absent until a real verifier exists,
   * so no device key can be classified TRUSTED_DEVICE.
   */
  deviceKeys?: {
    deployments: ValidatorDeployments;
    onChainId: number;
    attestationVerifier?: AttestationVerifier;
    /**
     * Puts the device key's FRESH clone on chain before the account is derived: the account is derived by simulating its
     * creation, which installs the validator, so the clone must exist first. Anyone may deploy a clone and it holds no
     * authority (its address is fixed by the key), so this is paid by the relayer and is idempotent.
     */
    validators?: RootValidatorDeployer;
  };
  ttlMs?: number;
  now?: () => Date;
}

/** What the client signs to prove it holds a device key it is enrolling. */
export interface DeviceKeyEnrollmentChallenge {
  keyId: string;
  /** The exact bytes to sign with ECDSA P-256 / SHA-256 (domain `KaadaRootProof/v1`, purpose ROOT_ENROLLMENT). */
  payload: string;
  algorithm: "ECDSA_P256_SHA256";
  format: "KaadaRootProof/v1";
  /** Send this back, unchanged, with the signature. Single use. */
  challenge: string;
}

export interface DeviceKeyRegistration {
  publicKeyX: string;
  publicKeyY: string;
  challenge: string;
  r: string;
  s: string;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const toTier = (tier: "trusted-device" | "web-non-extractable" | "unknown"): DeviceSecurityTier =>
  tier === "trusted-device"
    ? "TRUSTED_DEVICE"
    : tier === "web-non-extractable"
      ? "WEB_NON_EXTRACTABLE"
      : "UNKNOWN";

/** What a channel hands to the user. The token appears here and nowhere else. */
export interface CreatedSetupSession {
  sessionId: string;
  userId: string;
  token: string;
  url: string;
  expiresAt: Date;
}

/**
 * The browser-ready WebAuthn creation options (the JSON form `navigator.credentials.create` takes
 * after parsing). ES256 only, a discoverable credential, and user verification required.
 */
export interface RegistrationOptions {
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: -7 }[];
  timeout: number;
  attestation: "none";
  excludeCredentials: { type: "public-key"; id: string }[];
  authenticatorSelection: {
    residentKey: "required";
    requireResidentKey: true;
    userVerification: "required";
  };
}

/** The read-only view a setup token may see. No credential data beyond "there is one". */
export interface SetupView {
  status: "PENDING" | "COMPLETED";
  expiresAt: Date;
  /** Whether the wallet has a root (of either type), and which. */
  rootRegistered: boolean;
  rootType: RootType | null;
  /** True only for a passkey root. */
  passkeyRegistered: boolean;
  wallet: Wallet | null;
}

/**
 * Turns "this person asked to set up their wallet" into a registered passkey and an activated
 * counterfactual wallet, without ever letting a browser name a user.
 *
 *   channel (knows the user) --createSession--> opaque token --> browser
 *   browser --token--> resolve --> userId --> PasskeyService / WalletService
 *
 * Nothing here holds, derives or sees a private key: the authenticator does the signing, the server
 * verifies the PUBLIC result, and the wallet address is computed from the public key. Nothing here
 * can spend: a setup token is not a payment authorization.
 */
export class WalletSetupService {
  private readonly uow: WalletUnitOfWork;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly deps: WalletSetupServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? SETUP_SESSION_TTL_MS;
  }

  /**
   * Called by a trusted channel that has already identified the user. Retires the user's earlier
   * unused links so only the newest works. Refuses a user whose wallet is already set up.
   */
  async createSession(
    userId: string,
    options: { existingWallet?: boolean } = {},
  ): Promise<CreatedSetupSession> {
    if (!(await this.deps.users.findById(userId))) {
      throw new KaadaError("SETUP_SESSION_INVALID", "no such user");
    }
    const wallet = await this.deps.wallets.getWallet(userId);
    // `existingWallet` is for a security link (set or change the PIN) for someone whose wallet is
    // already active. It still cannot register a passkey: that path refuses an active wallet.
    if (wallet?.status === "ACTIVE" && !options.existingWallet) {
      throw new KaadaError("WALLET_ALREADY_SETUP", "this user's wallet is already set up");
    }

    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const session = await this.uow.transaction(async (repositories) => {
      // Serialised per user (the same lock provisioning uses), so concurrent requests leave one live link.
      await repositories.wallets.lockUser(userId);
      await repositories.walletSetupSessions.revokePending(userId);
      const created = await repositories.walletSetupSessions.create({
        id: createId(),
        userId,
        tokenHash: hashSetupToken(token),
        expiresAt: new Date(now.getTime() + this.ttlMs),
      });
      await this.audit(repositories, userId, WALLET_AUDIT_EVENTS.setupSessionCreated, created.id);
      return created;
    });
    return {
      sessionId: session.id,
      userId,
      token,
      url: `${this.deps.origin.replace(/\/$/, "")}/setup/${token}`,
      expiresAt: session.expiresAt,
    };
  }

  /** The setup link's current state and, once there is one, the wallet. Read only. */
  async view(token: string): Promise<SetupView> {
    const session = await this.resolve(token, "view");
    const wallet = await this.deps.wallets.getWallet(session.userId);
    const rootType = await this.rootTypeOf(session.userId, wallet);
    return {
      status: session.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      expiresAt: session.expiresAt,
      rootRegistered: rootType !== null,
      rootType,
      passkeyRegistered: rootType === "PASSKEY",
      wallet,
    };
  }

  /** The user a viewable token belongs to. For read-only wallet endpoints; never writes. */
  async userForView(token: string): Promise<string> {
    return (await this.resolve(token, "view")).userId;
  }

  async beginRegistration(token: string): Promise<RegistrationOptions> {
    const session = await this.resolve(token, "open");
    await this.assertCanRegister(session.userId);

    const challenge = await this.deps.passkeys.beginRegistration(session.userId);
    await this.uow.transaction((repositories) =>
      this.audit(
        repositories,
        session.userId,
        WALLET_AUDIT_EVENTS.passkeyRegistrationStarted,
        session.id,
      ),
    );
    return {
      rp: { name: this.deps.rpName, id: challenge.rpId },
      // A stable, opaque handle for the user; it is not their name, email or Kaada id in clear.
      user: {
        id: createHash("sha256").update(`kaada-user:${session.userId}`).digest("base64url"),
        name: `kaada-${session.userId.slice(0, 8)}`,
        displayName: "Kaada wallet",
      },
      challenge: challenge.challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 5 * 60 * 1000,
      attestation: "none",
      excludeCredentials: challenge.existingCredentialIds.map((id) => ({
        type: "public-key" as const,
        id,
      })),
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
    };
  }

  /**
   * Verifies the browser's registration response, stores the public credential, activates the
   * counterfactual wallet and consumes the setup link. Safe to retry after a provisioning failure
   * through `finalize`.
   */
  async completeRegistration(token: string, response: unknown): Promise<SetupView> {
    const session = await this.resolve(token, "open");
    await this.assertCanRegister(session.userId);
    try {
      await this.deps.passkeys.completeRegistration(session.userId, response);
    } catch (error) {
      await this.recordFailure(session, error);
      throw error;
    }
    return this.finalizeSession(session);
  }

  /**
   * Step 1 of a device-key enrolment: the server validates the public key, derives the key id itself (it never accepts one)
   * and issues a single-use challenge. The client proves it holds the private half by signing the returned payload.
   */
  async beginDeviceKeyRegistration(
    token: string,
    key: { publicKeyX: string; publicKeyY: string },
  ): Promise<DeviceKeyEnrollmentChallenge> {
    const config = this.requireDeviceKeys();
    const session = await this.resolve(token, "open");
    await this.assertCanRegister(session.userId);
    const { keyId } = this.checkedPoint(key);
    const challenge = `0x${randomBytes(32).toString("hex")}`;
    await this.uow.read.passkeys.issueChallenge({
      id: createId(),
      userId: session.userId,
      purpose: "REGISTRATION",
      challenge,
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000),
    });
    await this.uow.transaction((repositories) =>
      this.audit(
        repositories,
        session.userId,
        WALLET_AUDIT_EVENTS.passkeyRegistrationStarted,
        session.id,
        { rootType: "DEVICE_KEY" },
      ),
    );
    return {
      keyId,
      payload: deviceProofPayload({
        chainId: config.onChainId,
        validator: ZERO_ADDRESS,
        account: ZERO_ADDRESS,
        keyId,
        purpose: "ROOT_ENROLLMENT",
        challenge: challenge as Hex,
      }),
      algorithm: "ECDSA_P256_SHA256",
      format: "KaadaRootProof/v1",
      challenge,
    };
  }

  /**
   * Step 2: verifies the signature over the issued challenge, records the device key as the root of a new wallet (a FRESH
   * clone, scoped to this wallet's owner and never used before), derives the counterfactual account and consumes the setup
   * link. Only public data crosses this call. The security tier is decided here from the route (web) and attestation
   * evidence, never from anything the client claims: without a verifier no key is ever TRUSTED_DEVICE.
   */
  async completeDeviceKeyRegistration(
    token: string,
    input: DeviceKeyRegistration,
  ): Promise<SetupView> {
    const config = this.requireDeviceKeys();
    const session = await this.resolve(token, "open");
    await this.assertCanRegister(session.userId);
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    const { keyId, point } = this.checkedPoint(input);
    if (!/^0x[0-9a-f]{64}$/.test(input.challenge)) throw reject("the challenge is malformed");

    const consumed = await this.uow.read.passkeys.consumeChallenge({
      userId: session.userId,
      purpose: "REGISTRATION",
      challenge: input.challenge,
      now: this.now(),
    });
    if (!consumed) throw reject("the challenge is unknown, expired or already used");
    const payload = deviceProofPayload({
      chainId: config.onChainId,
      validator: ZERO_ADDRESS,
      account: ZERO_ADDRESS,
      keyId,
      purpose: "ROOT_ENROLLMENT",
      challenge: input.challenge as Hex,
    });
    const proven = verifyP256({
      x: input.publicKeyX,
      y: input.publicKeyY,
      message: Buffer.from(payload.slice(2), "hex"),
      r: input.r,
      s: input.s,
    });
    if (!proven) {
      await this.recordFailure(session, reject("the device key could not be verified"));
      throw reject("the device key could not be verified");
    }

    const tier = toTier(
      await classifyDeviceKey({
        // This route is the WEB enrolment path: the server, not the client, decides the channel.
        channel: "web",
        point,
        verifier: config.attestationVerifier,
      }),
    );
    const primary = buildPrimaryRoot({
      deployments: config.deployments,
      credential: {
        kind: "DEVICE_KEY",
        keyId,
        publicKeyX: input.publicKeyX,
        publicKeyY: input.publicKeyY,
      },
      deploymentSalt: primaryRootDeploymentSalt(session.userId),
    });
    try {
      await this.deps.wallets.beginDeviceKeyWallet(session.userId, {
        keyId,
        publicKeyX: input.publicKeyX,
        publicKeyY: input.publicKeyY,
        validatorAddress: primary.instance,
        deploymentSalt: primary.deploymentSalt,
        securityTier: tier,
      });
    } catch (error) {
      await this.recordFailure(session, error);
      throw error;
    }
    return this.finalizeSession(session);
  }

  /**
   * Finishes a setup whose passkey is already registered (for instance after a provisioning
   * failure). Idempotent: it creates nothing that already exists.
   */
  async finalize(token: string): Promise<SetupView> {
    return this.finalizeSession(await this.resolve(token, "open"));
  }

  private async finalizeSession(session: WalletSetupSession): Promise<SetupView> {
    let wallet: Wallet;
    try {
      await this.ensureRootValidator(session.userId);
      wallet = await this.deps.wallets.ensureEmbeddedWallet(session.userId);
    } catch (error) {
      await this.recordFailure(session, error);
      throw error;
    }
    const consumed = await this.uow.transaction(async (repositories) => {
      const done = await repositories.walletSetupSessions.complete(session.id, this.now());
      if (done) {
        await this.audit(
          repositories,
          session.userId,
          WALLET_AUDIT_EVENTS.setupSessionConsumed,
          session.id,
        );
      }
      return done;
    });
    const rootType = await this.rootTypeOf(session.userId, wallet);
    return {
      status: "COMPLETED",
      expiresAt: (consumed ?? session).expiresAt,
      rootRegistered: true,
      rootType,
      passkeyRegistered: rootType === "PASSKEY",
      wallet,
    };
  }

  /** A user with an ACTIVE wallet, or one who already has a passkey, registers nothing more here. */
  private async assertCanRegister(userId: string): Promise<void> {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (wallet?.status === "ACTIVE" && wallet.chainId === CELO_CHAIN_ID) {
      throw new KaadaError("WALLET_ALREADY_SETUP", "this user's wallet is already set up");
    }
    if (wallet && (await this.uow.read.walletCredentials.findRoot(wallet.id))) {
      throw new KaadaError(
        "WALLET_ALREADY_SETUP",
        "a root is already registered; finish the setup instead",
      );
    }
    if ((await this.uow.read.passkeys.listActiveForUser(userId)).length > 0) {
      throw new KaadaError(
        "WALLET_ALREADY_SETUP",
        "a passkey is already registered; finish the setup instead",
      );
    }
  }

  /** A device-key root lives in a clone that must exist before the account that names it can be derived or created. */
  private async ensureRootValidator(userId: string): Promise<void> {
    const validators = this.deps.deviceKeys?.validators;
    if (!validators) return;
    const wallet = await this.uow.read.wallets.findEmbedded(userId, CELO_CHAIN_ID);
    const root = wallet ? await this.uow.read.walletCredentials.findRoot(wallet.id) : null;
    if (!root || root.kind !== "DEVICE_KEY") return;
    await validators.ensureDeployed({
      type: "DEVICE_KEY",
      account: null,
      purpose: root.validatorPurpose,
      deploymentSalt: root.deploymentSalt,
      validatorAddress: root.validatorAddress,
      publicKeyX: root.publicKeyX,
      publicKeyY: root.publicKeyY,
      credentialRef: root.credentialRef,
    });
  }

  /** Whether this deployment can create wallets whose root is a device key. */
  get deviceKeysEnabled(): boolean {
    return this.deps.deviceKeys !== undefined;
  }

  private requireDeviceKeys() {
    if (!this.deps.deviceKeys) {
      throw new KaadaError("WALLET_PROVISIONING_FAILED", "device-key wallets are not enabled");
    }
    return this.deps.deviceKeys;
  }

  /** Validates a submitted public key and derives its key id. The client never supplies the id. */
  private checkedPoint(key: { publicKeyX: string; publicKeyY: string }) {
    const hex64 = /^[0-9a-f]{64}$/;
    if (!hex64.test(key.publicKeyX) || !hex64.test(key.publicKeyY)) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the public key is malformed");
    }
    const point = { x: BigInt(`0x${key.publicKeyX}`), y: BigInt(`0x${key.publicKeyY}`) };
    if (!isOnP256Curve(point)) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the public key is not a valid P-256 point");
    }
    return { point, keyId: deviceKeyIdFromPoint(point) };
  }

  /** The type of the wallet's root: the recorded root, else a registered passkey, else none yet. */
  private async rootTypeOf(userId: string, wallet: Wallet | null): Promise<RootType | null> {
    const recorded = wallet ? await this.uow.read.walletCredentials.findRoot(wallet.id) : null;
    if (recorded) return recorded.kind;
    return (await this.uow.read.passkeys.listActiveForUser(userId)).length > 0 ? "PASSKEY" : null;
  }

  /**
   * One generic failure for an unknown, malformed, expired, used or replaced token, so a caller
   * learns nothing about which it was.
   */
  private async resolve(token: string, mode: "open" | "view"): Promise<WalletSetupSession> {
    const invalid = () => new KaadaError("SETUP_SESSION_INVALID", "this setup link is not valid");
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw invalid();
    const session = await this.uow.read.walletSetupSessions.findByTokenHash(hashSetupToken(token));
    if (!session) throw invalid();
    const now = this.now();
    const ok =
      mode === "open" ? isSetupSessionOpen(session, now) : isSetupSessionViewable(session, now);
    if (!ok) throw invalid();
    return session;
  }

  private async recordFailure(session: WalletSetupSession, error: unknown): Promise<void> {
    const reason = isKaadaError(error) ? error.code : "UNEXPECTED";
    // Reason code only: never the response, a challenge or the token.
    await this.uow
      .transaction((repositories) =>
        this.audit(repositories, session.userId, WALLET_AUDIT_EVENTS.setupFailed, session.id, {
          reason,
        }),
      )
      .catch(() => undefined);
  }

  private async audit(
    repositories: WalletRepositories,
    userId: string,
    type: string,
    entityId: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await repositories.audit.append({
      id: createId(),
      userId,
      type,
      entityType: "wallet_setup_session",
      entityId,
      ...(data && { data }),
    });
  }
}
