import type {
  RootChange,
  RootChangeRepository,
  WalletCredential,
  WalletCredentialRepository,
} from "@kaada/domain";

/*
 * An in-memory WalletCredentialRepository. Every method is synchronous inside, so each conditional transition is atomic like the
 * single SQL statement it stands in for; "one validator instance per wallet" and "one ACTIVE root per wallet" are enforced like the
 * unique indexes.
 */

const copy = <T extends object>(value: T): T => ({ ...value });
const copyOrNull = <T extends object>(value: T | undefined): T | null =>
  value ? copy(value) : null;
const DUPLICATE = (what: string) => new Error(`unique violation: ${what}`);

export function createMemoryWalletCredentials(
  now: () => Date,
  credentials: WalletCredential[] = [],
): WalletCredentialRepository {
  return {
    create: (input) => {
      if (
        credentials.some(
          (c) => c.walletId === input.walletId && c.validatorAddress === input.validatorAddress,
        )
      ) {
        return Promise.reject(DUPLICATE("validator instance per wallet"));
      }
      if (
        input.isRoot &&
        credentials.some((c) => c.walletId === input.walletId && c.isRoot && c.status === "ACTIVE")
      ) {
        return Promise.reject(DUPLICATE("one root per wallet"));
      }
      const credential: WalletCredential = {
        ...input,
        createdAt: now(),
        ...(input.status === "ACTIVE" && { activatedAt: now() }),
      };
      credentials.push(credential);
      return Promise.resolve(copy(credential));
    },
    findById: (id) => Promise.resolve(copyOrNull(credentials.find((c) => c.id === id))),
    validatorEverUsed: (walletId, validatorAddress) =>
      Promise.resolve(
        credentials.some(
          (c) => c.walletId === walletId && c.validatorAddress === validatorAddress.toLowerCase(),
        ),
      ),
    findRoot: (walletId) =>
      Promise.resolve(
        copyOrNull(
          credentials.find((c) => c.walletId === walletId && c.isRoot && c.status === "ACTIVE"),
        ),
      ),
    listForWallet: (walletId) =>
      Promise.resolve(
        credentials
          .filter((c) => c.walletId === walletId)
          .map(copy)
          .reverse(),
      ),
    promoteToRoot: ({ walletId, newId, at }) => {
      const candidate = credentials.find(
        (c) => c.id === newId && c.walletId === walletId && c.status === "PENDING",
      );
      if (!candidate) return Promise.resolve(null);
      const current = credentials.find(
        (c) => c.walletId === walletId && c.isRoot && c.status === "ACTIVE",
      );
      if (current) {
        current.isRoot = false;
        current.status = "REPLACED";
        current.replacedAt = at;
        current.replacedByCredentialId = newId;
      }
      candidate.isRoot = true;
      candidate.status = "ACTIVE";
      candidate.activatedAt = at;
      return Promise.resolve({
        promoted: copy(candidate),
        replaced: current ? copy(current) : null,
      });
    },
    activate: (id, at) => {
      const found = credentials.find((c) => c.id === id && c.status === "PENDING");
      if (!found) return Promise.resolve(null);
      found.status = "ACTIVE";
      found.activatedAt = at;
      return Promise.resolve(copy(found));
    },
    linkPasskey: (id, passkeyCredentialId) => {
      const found = credentials.find((c) => c.id === id);
      if (found) found.passkeyCredentialId = passkeyCredentialId;
      return Promise.resolve();
    },
    revoke: (id, at) => {
      const found = credentials.find(
        (c) => c.id === id && (c.status === "PENDING" || c.status === "ACTIVE"),
      );
      if (!found) return Promise.resolve(null);
      found.status = "REVOKED";
      found.isRoot = false;
      found.revokedAt = at;
      return Promise.resolve(copy(found));
    },
  };
}

/** An in-memory RootChangeRepository: one live (PREPARED or SUBMITTED) change per wallet, every move one conditional step. */
export function createMemoryRootChanges(now: () => Date): RootChangeRepository {
  const changes: RootChange[] = [];
  const isLive = (c: RootChange) => c.status === "PREPARED" || c.status === "SUBMITTED";
  return {
    create: (input, at) => {
      for (const c of changes) {
        if (c.walletId === input.walletId && isLive(c) && c.expiresAt.getTime() <= at.getTime()) {
          c.status = "EXPIRED";
        }
      }
      if (changes.some((c) => c.walletId === input.walletId && isLive(c))) {
        return Promise.resolve(null);
      }
      const change: RootChange = { ...input, status: "PREPARED", createdAt: at, updatedAt: at };
      changes.push(change);
      return Promise.resolve(copy(change));
    },
    findById: (id) => Promise.resolve(copyOrNull(changes.find((c) => c.id === id))),
    findLive: (walletId) =>
      Promise.resolve(copyOrNull(changes.find((c) => c.walletId === walletId && isLive(c)))),
    advance: ({ id, from, to, patch }) => {
      const found = changes.find((c) => c.id === id && from.includes(c.status));
      if (!found) return Promise.resolve(null);
      found.status = to;
      found.updatedAt = now();
      if (patch?.userOpHash) found.userOpHash = patch.userOpHash;
      if (patch?.failureCode) found.failureCode = patch.failureCode;
      if (patch?.completedAt) found.completedAt = patch.completedAt;
      return Promise.resolve(copy(found));
    },
    listExpired: (at, limit) =>
      Promise.resolve(
        changes
          .filter((c) => isLive(c) && c.expiresAt.getTime() <= at.getTime())
          .slice(0, limit)
          .map(copy),
      ),
  };
}
