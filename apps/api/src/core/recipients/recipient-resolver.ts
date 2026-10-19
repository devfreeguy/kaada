import { CELO_CHAIN_ID, evmAddressCodec } from "@kaada/domain";
import type {
  IdentityRepository,
  Recipient,
  RecipientReference,
  RecipientRepository,
  ResolvedRecipient,
  UserRepository,
  WalletRepository,
} from "@kaada/domain";

export type RecipientResolution =
  | { status: "RESOLVED"; recipient: ResolvedRecipient }
  | { status: "AMBIGUOUS"; candidates: ResolvedRecipient[] }
  | {
      status: "NOT_FOUND";
      reason: "NO_MATCH" | "INVALID_FORMAT" | "UNSUPPORTED_TYPE" | "NO_WALLET";
    };

/** Turns what the sender called the recipient into someone Kaada can pay. */
export interface RecipientResolver {
  resolve(userId: string, reference: RecipientReference): Promise<RecipientResolution>;
}

export interface RecipientLookupRepositories {
  users: UserRepository;
  identities: IdentityRepository;
  recipients: RecipientRepository;
  /** Where a Kaada person is paid: their own Celo wallet. Absent: a Kaada person cannot be paid by name. */
  wallets?: Pick<WalletRepository, "findEmbedded">;
}

const notFound = { status: "NOT_FOUND", reason: "NO_MATCH" } as const;

function normalizeName(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

/** A username-like token is safe to show to tell two people apart; a phone number or address is not. */
function publicHandle(identifier: string | undefined): string | undefined {
  if (!identifier) return undefined;
  const bare = identifier.trim().replace(/^@/, "");
  const looksLikeHandle =
    /^[A-Za-z0-9_.]{2,32}$/.test(bare) && !/^\d+$/.test(bare) && !/^0x/i.test(bare);
  return looksLikeHandle ? bare : undefined;
}

function fromSaved(reference: RecipientReference, saved: Recipient): ResolvedRecipient {
  const handle =
    saved.type === "WALLET_ADDRESS" || saved.type === "PHONE_NUMBER"
      ? undefined
      : publicHandle(saved.identifier);
  return {
    reference,
    recipientId: saved.id,
    ...(saved.linkedUserId && { linkedUserId: saved.linkedUserId }),
    ...(saved.displayName && { displayName: saved.displayName }),
    ...(handle && { handle }),
    ...(saved.walletAddress && { walletAddress: saved.walletAddress }),
    ...(saved.destinationCountry && { destinationCountry: saved.destinationCountry }),
    ...(saved.preferredAssetId && { preferredAssetId: saved.preferredAssetId }),
  };
}

/** The resolution of a reference that was already resolved and stored, rebuilt without any lookup. */
export function resolvedFromStored(
  reference: RecipientReference,
  stored: Recipient,
): ResolvedRecipient {
  return fromSaved(reference, stored);
}

function pick(candidates: ResolvedRecipient[]): RecipientResolution {
  const [only, ...rest] = candidates;
  if (!only) return notFound;
  return rest.length === 0
    ? { status: "RESOLVED", recipient: only }
    : { status: "AMBIGUOUS", candidates };
}

/**
 * Resolves recipients using only data Kaada already stores. There are no network lookups: Telegram
 * users must already have an Identity, and phone numbers are not looked up at all yet.
 *
 * Usernames are matched case-insensitively. A generic USERNAME is looked for among the sender's own
 * saved contacts first; only if none match is it tried as a Kaada username, so a stranger's account
 * never competes with someone the sender has saved.
 */
export function createRepositoryRecipientResolver(
  repos: RecipientLookupRepositories,
): RecipientResolver {
  async function savedMatches(
    userId: string,
    reference: RecipientReference,
  ): Promise<ResolvedRecipient[]> {
    const wanted = normalizeName(reference.value);
    const saved = await repos.recipients.listSavedByOwner(userId);
    return saved
      .filter((recipient) => {
        const name = recipient.displayName?.toLowerCase();
        const words = name?.split(/\s+/) ?? [];
        return (
          name === wanted ||
          words.includes(wanted) ||
          recipient.identifier?.toLowerCase().replace(/^@/, "") === wanted
        );
      })
      .map((recipient) => fromSaved(reference, recipient));
  }

  async function kaadaUser(reference: RecipientReference): Promise<RecipientResolution> {
    const user = await repos.users.findByUsername(normalizeName(reference.value));
    if (!user) return notFound;
    const displayName = user.displayName ?? user.username;
    const handle = publicHandle(user.username);
    return {
      status: "RESOLVED",
      recipient: {
        reference,
        linkedUserId: user.id,
        ...(displayName && { displayName }),
        ...(handle && { handle }),
      },
    };
  }

  /**
   * A person on Kaada is paid at their own wallet: the address is read from THEIR active Celo wallet here, never typed or guessed.
   * Someone who has not finished setting up has nowhere to receive, which is said plainly (NO_WALLET) instead of "not found".
   */
  async function deliverable(
    senderId: string,
    candidates: ResolvedRecipient[],
  ): Promise<RecipientResolution> {
    const others = candidates.filter((candidate) => candidate.linkedUserId !== senderId);
    const withWallet: ResolvedRecipient[] = [];
    let anyWithoutWallet = false;
    for (const candidate of others) {
      // No wallet lookup wired (a test world, a deployment without wallets): the candidate is returned as it was found.
      if (!candidate.linkedUserId || candidate.walletAddress || !repos.wallets) {
        withWallet.push(candidate);
        continue;
      }
      const wallet = await repos.wallets.findEmbedded(candidate.linkedUserId, CELO_CHAIN_ID);
      if (wallet?.status === "ACTIVE" && wallet.address) {
        withWallet.push({ ...candidate, walletAddress: wallet.address.toLowerCase() });
      } else {
        anyWithoutWallet = true;
      }
    }
    if (withWallet.length === 0 && anyWithoutWallet) {
      return { status: "NOT_FOUND", reason: "NO_WALLET" };
    }
    return pick(withWallet);
  }

  /** People whose Telegram @username is this one. Usernames are captured from every message a person sends (case-insensitive). */
  async function telegramMatches(
    reference: RecipientReference,
    raw: string,
  ): Promise<ResolvedRecipient[]> {
    const value = raw.trim().replace(/^@/, "");
    const identities = /^\d+$/.test(value)
      ? [await repos.identities.findByExternalId("TELEGRAM", value)].filter((i) => i !== null)
      : await repos.identities.findByUsername("TELEGRAM", value);
    return Promise.all(
      identities.map(async (identity): Promise<ResolvedRecipient> => {
        const user = await repos.users.findById(identity.userId);
        const displayName =
          user?.displayName ?? (identity.username ? `@${identity.username}` : undefined);
        const handle = publicHandle(identity.username);
        return {
          reference,
          linkedUserId: identity.userId,
          ...(displayName && { displayName }),
          ...(handle && { handle }),
        };
      }),
    );
  }

  /** The Kaada user with this username, as candidates (zero or one). */
  async function kaadaMatches(reference: RecipientReference): Promise<ResolvedRecipient[]> {
    const found = await kaadaUser(reference);
    return found.status === "RESOLVED" ? [found.recipient] : [];
  }

  return {
    async resolve(userId, reference) {
      switch (reference.type) {
        case "KAADA_USER":
          return deliverable(userId, await kaadaMatches(reference));

        case "SAVED_BENEFICIARY":
          return pick(await savedMatches(userId, reference));

        case "USERNAME": {
          const saved = await savedMatches(userId, reference);
          if (saved.length > 0) return pick(saved);
          // A name or @handle that is not a saved contact: a Kaada username, or a Telegram @username of someone on Kaada. The
          // same person is never listed twice (they may match both ways).
          const found = new Map<string, ResolvedRecipient>();
          for (const candidate of [
            ...(await kaadaMatches(reference)),
            ...(await telegramMatches(reference, reference.value)),
          ]) {
            const key =
              candidate.linkedUserId ?? candidate.recipientId ?? candidate.displayName ?? "";
            if (!found.has(key)) found.set(key, candidate);
          }
          return deliverable(userId, [...found.values()]);
        }

        case "TELEGRAM_USER":
          return deliverable(userId, await telegramMatches(reference, reference.value));

        case "WALLET_ADDRESS": {
          const address = reference.value.trim();
          if (!evmAddressCodec.isValid(address)) {
            return { status: "NOT_FOUND", reason: "INVALID_FORMAT" };
          }
          const normalized = evmAddressCodec.normalize(address);
          const saved = await repos.recipients.findByIdentifier(
            userId,
            "WALLET_ADDRESS",
            normalized,
          );
          return {
            status: "RESOLVED",
            recipient: saved
              ? { ...fromSaved(reference, saved), walletAddress: normalized }
              : { reference, walletAddress: normalized },
          };
        }

        case "PHONE_NUMBER":
        case "EXTERNAL_PAYMENT_ADDRESS":
          return { status: "NOT_FOUND", reason: "UNSUPPORTED_TYPE" };
      }
    },
  };
}
