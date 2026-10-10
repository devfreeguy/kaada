import { createHash, randomBytes } from "node:crypto";

import {
  CELO_CHAIN_ID,
  KaadaError,
  WALLET_AUDIT_EVENTS,
  createId,
  isKaadaError,
  isSetupSessionOpen,
  isSetupSessionViewable,
} from "@kaada/domain";
import type { UserRepository, Wallet, WalletSetupSession } from "@kaada/domain";

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
  ttlMs?: number;
  now?: () => Date;
}

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
    const credentials = await this.uow.read.passkeys.listActiveForUser(session.userId);
    return {
      status: session.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      expiresAt: session.expiresAt,
      passkeyRegistered: credentials.length > 0,
      wallet: await this.deps.wallets.getWallet(session.userId),
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
   * Finishes a setup whose passkey is already registered (for instance after a provisioning
   * failure). Idempotent: it creates nothing that already exists.
   */
  async finalize(token: string): Promise<SetupView> {
    return this.finalizeSession(await this.resolve(token, "open"));
  }

  private async finalizeSession(session: WalletSetupSession): Promise<SetupView> {
    let wallet: Wallet;
    try {
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
    return {
      status: "COMPLETED",
      expiresAt: (consumed ?? session).expiresAt,
      passkeyRegistered: true,
      wallet,
    };
  }

  /** A user with an ACTIVE wallet, or one who already has a passkey, registers nothing more here. */
  private async assertCanRegister(userId: string): Promise<void> {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (wallet?.status === "ACTIVE" && wallet.chainId === CELO_CHAIN_ID) {
      throw new KaadaError("WALLET_ALREADY_SETUP", "this user's wallet is already set up");
    }
    if ((await this.uow.read.passkeys.listActiveForUser(userId)).length > 0) {
      throw new KaadaError(
        "WALLET_ALREADY_SETUP",
        "a passkey is already registered; finish the setup instead",
      );
    }
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
