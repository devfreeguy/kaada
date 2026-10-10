import { randomUUID } from "node:crypto";

import type {
  Asset,
  AssetRepository,
  AuditEvent,
  DelegatedPermission,
  DerivedAccount,
  PasskeyChallenge,
  PasskeyCredential,
  RootCredential,
  Wallet,
  WalletProvisioningAdapter,
  WalletSetupSession,
} from "@kaada/domain";
import { KernelPolicyAdapter } from "@kaada/blockchain";

import type { WalletRepositories, WalletUnitOfWork } from "../../src/core/wallets/ports.js";
import { WalletService } from "../../src/core/wallets/wallet-service.js";

/*
 * In-memory implementations of the wallet repository ports, and a counting fake provisioning adapter,
 * for fast offline tests. Transactions run one at a time (like the per-user row lock does), and the
 * "one non-revoked embedded wallet per user and chain" rule is enforced like the partial unique index.
 */

export interface WalletWorld {
  repositories: WalletRepositories;
  unitOfWork: WalletUnitOfWork;
  wallets: Map<string, Wallet>;
  credentials: PasskeyCredential[];
  challenges: PasskeyChallenge[];
  permissions: Map<string, DelegatedPermission>;
  audit: AuditEvent[];
  setupSessions: WalletSetupSession[];
  assets: Asset[];
  addCredential(userId: string, over?: Partial<PasskeyCredential>): PasskeyCredential;
}

export function createWalletWorld(): WalletWorld {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 10) + tick++ * 1000);

  const wallets = new Map<string, Wallet>();
  const credentials: PasskeyCredential[] = [];
  const challenges: PasskeyChallenge[] = [];
  const permissions = new Map<string, DelegatedPermission>();
  const audit: AuditEvent[] = [];
  const assets: Asset[] = [];
  const setupSessions: WalletSetupSession[] = [];

  const assetRepository: AssetRepository = {
    findById: (id) => Promise.resolve(assets.find((a) => a.id === id) ?? null),
    findBySymbol: (symbol) =>
      Promise.resolve(assets.filter((a) => a.symbol.toLowerCase() === symbol.toLowerCase())),
    findByFiatCode: () => Promise.resolve([]),
    findByDenomination: () => Promise.resolve([]),
    listActive: () => Promise.resolve(assets.filter((a) => a.isActive)),
    listAll: () => Promise.resolve([...assets]),
  };

  const repositories: WalletRepositories = {
    assets: assetRepository,

    walletSetupSessions: {
      create: (input) => {
        if (setupSessions.some((x) => x.tokenHash === input.tokenHash)) {
          return Promise.reject(new Error("duplicate token hash"));
        }
        const session: WalletSetupSession = { ...input, status: "PENDING", createdAt: stamp() };
        setupSessions.push(session);
        return Promise.resolve({ ...session });
      },
      findByTokenHash: (hash) => {
        const found = setupSessions.find((x) => x.tokenHash === hash);
        return Promise.resolve(found ? { ...found } : null);
      },
      revokePending: (userId) => {
        let count = 0;
        for (const x of setupSessions) {
          if (x.userId === userId && x.status === "PENDING") {
            x.status = "REVOKED";
            count += 1;
          }
        }
        return Promise.resolve(count);
      },
      complete: (id, now) => {
        const found = setupSessions.find((x) => x.id === id);
        if (!found || found.status !== "PENDING" || found.expiresAt.getTime() <= now.getTime()) {
          return Promise.resolve(null);
        }
        found.status = "COMPLETED";
        found.usedAt = now;
        return Promise.resolve({ ...found });
      },
    },

    wallets: {
      findById: (id) => Promise.resolve(wallets.get(id) ?? null),
      findEmbedded: (userId, chainId) =>
        Promise.resolve(
          [...wallets.values()].find(
            (w) =>
              w.userId === userId &&
              w.chainId === chainId &&
              w.type === "EMBEDDED" &&
              w.status !== "REVOKED",
          ) ?? null,
        ),
      lockUser: () => Promise.resolve(),
      create: (input) => {
        if (
          input.type === "EMBEDDED" &&
          [...wallets.values()].some(
            (w) =>
              w.userId === input.userId &&
              w.chainId === input.chainId &&
              w.type === "EMBEDDED" &&
              w.status !== "REVOKED",
          )
        ) {
          return Promise.reject(
            new Error("unique violation: one embedded wallet per user and chain"),
          );
        }
        const wallet: Wallet = { ...input, createdAt: stamp(), updatedAt: stamp() };
        wallets.set(wallet.id, wallet);
        return Promise.resolve(wallet);
      },
      activate: (id, account) => {
        const current = wallets.get(id);
        if (!current || current.status !== "PROVISIONING") return Promise.resolve(null);
        const { statusReason: _cleared, ...rest } = current;
        const wallet: Wallet = {
          ...rest,
          status: "ACTIVE",
          address: account.address,
          deployment: account.deployment,
          provider: account.provider,
          ...(account.providerAccountId && { providerAccountId: account.providerAccountId }),
          provisionedAt: account.at,
          updatedAt: stamp(),
        };
        wallets.set(id, wallet);
        return Promise.resolve(wallet);
      },
      recordFailure: (id, reason) => {
        const current = wallets.get(id);
        if (current?.status === "PROVISIONING")
          wallets.set(id, { ...current, statusReason: reason });
        return Promise.resolve();
      },
      setStatus: (id, status, reason) => {
        const current = wallets.get(id);
        if (!current) return Promise.reject(new Error("wallet not found"));
        const { statusReason: _old, ...rest } = current;
        const updated: Wallet = {
          ...rest,
          status,
          ...(reason && { statusReason: reason }),
          updatedAt: stamp(),
        };
        wallets.set(id, updated);
        return Promise.resolve(updated);
      },
      setDeployment: (id, deployment) => {
        const current = wallets.get(id);
        if (!current) return Promise.reject(new Error("wallet not found"));
        const updated = { ...current, deployment };
        wallets.set(id, updated);
        return Promise.resolve(updated);
      },
      listByUser: (userId) =>
        Promise.resolve([...wallets.values()].filter((w) => w.userId === userId)),
    },

    passkeys: {
      create: (input) => {
        if (credentials.some((c) => c.credentialId === input.credentialId)) {
          return Promise.reject(new Error("unique violation: credentialId"));
        }
        const credential: PasskeyCredential = { signCount: 0, ...input, createdAt: stamp() };
        credentials.push(credential);
        return Promise.resolve(credential);
      },
      findByCredentialId: (credentialId) =>
        Promise.resolve(credentials.find((c) => c.credentialId === credentialId) ?? null),
      listActiveForUser: (userId) =>
        Promise.resolve(credentials.filter((c) => c.userId === userId && !c.revokedAt)),
      advanceCounter: (id, signCount, at) => {
        const index = credentials.findIndex((c) => c.id === id && !c.revokedAt);
        const current = credentials[index];
        if (!current || current.signCount >= signCount) return Promise.resolve(false);
        credentials[index] = { ...current, signCount, lastUsedAt: at };
        return Promise.resolve(true);
      },
      revoke: (id, at) => {
        const index = credentials.findIndex((c) => c.id === id && !c.revokedAt);
        const current = credentials[index];
        if (!current) return Promise.resolve(false);
        credentials[index] = { ...current, revokedAt: at };
        return Promise.resolve(true);
      },
      issueChallenge: (challenge) => {
        const created: PasskeyChallenge = { ...challenge, createdAt: stamp() };
        challenges.push(created);
        return Promise.resolve(created);
      },
      consumeChallenge: ({ userId, purpose, challenge, now }) => {
        const index = challenges.findIndex(
          (c) =>
            c.userId === userId &&
            c.purpose === purpose &&
            c.challenge === challenge &&
            !c.usedAt &&
            c.expiresAt.getTime() > now.getTime(),
        );
        const current = challenges[index];
        if (!current) return Promise.resolve(null);
        const used = { ...current, usedAt: now };
        challenges[index] = used;
        return Promise.resolve(used);
      },
    },

    delegatedPermissions: {
      create: (input) => {
        const permission: DelegatedPermission = { ...input, createdAt: stamp() };
        permissions.set(permission.id, permission);
        return Promise.resolve(permission);
      },
      findById: (id) => Promise.resolve(permissions.get(id) ?? null),
      listForWallet: (walletId) =>
        Promise.resolve([...permissions.values()].filter((p) => p.walletId === walletId)),
      activate: (id, providerPermissionId) => {
        const current = permissions.get(id);
        if (!current || current.status !== "PENDING") return Promise.resolve(null);
        const updated: DelegatedPermission = { ...current, status: "ACTIVE", providerPermissionId };
        permissions.set(id, updated);
        return Promise.resolve(updated);
      },
      revoke: (id, reason, at) => {
        const current = permissions.get(id);
        if (!current || !["PENDING", "ACTIVE"].includes(current.status))
          return Promise.resolve(null);
        const updated: DelegatedPermission = {
          ...current,
          status: "REVOKED",
          revokedAt: at,
          revocationReason: reason,
        };
        permissions.set(id, updated);
        return Promise.resolve(updated);
      },
      expireDue: (now) => {
        let count = 0;
        for (const [id, permission] of permissions) {
          if (["PENDING", "ACTIVE"].includes(permission.status) && permission.expiresAt <= now) {
            permissions.set(id, { ...permission, status: "EXPIRED" });
            count += 1;
          }
        }
        return Promise.resolve(count);
      },
    },

    audit: {
      append: (event) => {
        const entry: AuditEvent = { ...event, createdAt: stamp() };
        audit.push(entry);
        return Promise.resolve(entry);
      },
      listForUser: (userId) => Promise.resolve(audit.filter((a) => a.userId === userId).reverse()),
    },
  };

  let chain: Promise<unknown> = Promise.resolve();
  const unitOfWork: WalletUnitOfWork = {
    read: repositories,
    transaction: <T>(work: (repos: WalletRepositories) => Promise<T>): Promise<T> => {
      const run = chain.then(() => work(repositories));
      chain = run.catch(() => undefined);
      return run;
    },
  };

  return {
    repositories,
    unitOfWork,
    wallets,
    credentials,
    challenges,
    permissions,
    audit,
    setupSessions,
    assets,
    addCredential(userId, over = {}) {
      const credential: PasskeyCredential = {
        id: randomUUID(),
        userId,
        credentialId: randomUUID().replaceAll("-", ""),
        publicKeyX: "11".repeat(32),
        publicKeyY: "22".repeat(32),
        rpId: "kaada.test",
        signCount: 0,
        createdAt: stamp(),
        ...over,
      };
      credentials.push(credential);
      return credential;
    },
  };
}

/** A counting provisioning adapter. The address is a pure function of the credential, like the real one. */
export class FakeProvisioningAdapter implements WalletProvisioningAdapter {
  readonly provider = "fake-kernel";
  calls = 0;
  /** Reject the next N derivations. */
  failNext = 0;
  delayMs = 0;
  /** Override what the adapter returns (for malformed-address tests). */
  override?: (root: RootCredential) => DerivedAccount;

  async deriveAccount(input: { chainId: number; root: RootCredential }): Promise<DerivedAccount> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("provider exploded: secret-looking text that must never reach a user");
    }
    if (this.override) return this.override(input.root);
    const hex = (input.root.publicKeyX + input.root.credentialId).replace(/[^0-9a-f]/g, "0");
    return {
      address: `0x${hex.padEnd(40, "0").slice(0, 40)}`,
      provider: this.provider,
      deployment: "COUNTERFACTUAL",
    };
  }
}

export function createWalletService(
  world: WalletWorld,
  options: { adapter?: FakeProvisioningAdapter; now?: () => Date } = {},
) {
  const adapter = options.adapter ?? new FakeProvisioningAdapter();
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const service = new WalletService({
    unitOfWork: world.unitOfWork,
    provisioning: adapter,
    policy: new KernelPolicyAdapter(),
    ...(options.now && { now: options.now }),
    log: (level, event, fields) => void logs.push({ level, event, fields }),
  });
  return { service, adapter, logs };
}
