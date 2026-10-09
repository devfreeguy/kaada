import { evmAddressCodec } from "@kaada/domain";
import type {
  IdentityRepository,
  Recipient,
  RecipientReference,
  RecipientRepository,
  ResolvedRecipient,
  UserRepository,
} from "@kaada/domain";

export type RecipientResolution =
  | { status: "RESOLVED"; recipient: ResolvedRecipient }
  | { status: "AMBIGUOUS"; candidates: ResolvedRecipient[] }
  | {
      status: "NOT_FOUND";
      reason: "NO_MATCH" | "INVALID_FORMAT" | "UNSUPPORTED_TYPE";
    };

/** Turns what the sender called the recipient into someone Kaada can pay. */
export interface RecipientResolver {
  resolve(userId: string, reference: RecipientReference): Promise<RecipientResolution>;
}

export interface RecipientLookupRepositories {
  users: UserRepository;
  identities: IdentityRepository;
  recipients: RecipientRepository;
}

const notFound = { status: "NOT_FOUND", reason: "NO_MATCH" } as const;

function normalizeName(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function fromSaved(reference: RecipientReference, saved: Recipient): ResolvedRecipient {
  return {
    reference,
    recipientId: saved.id,
    ...(saved.linkedUserId && { linkedUserId: saved.linkedUserId }),
    ...(saved.displayName && { displayName: saved.displayName }),
    ...(saved.walletAddress && { walletAddress: saved.walletAddress }),
    ...(saved.destinationCountry && { destinationCountry: saved.destinationCountry }),
    ...(saved.preferredAssetId && { preferredAssetId: saved.preferredAssetId }),
  };
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
          recipient.identifier?.toLowerCase() === wanted
        );
      })
      .map((recipient) => fromSaved(reference, recipient));
  }

  async function kaadaUser(reference: RecipientReference): Promise<RecipientResolution> {
    const user = await repos.users.findByUsername(normalizeName(reference.value));
    if (!user) return notFound;
    const displayName = user.displayName ?? user.username;
    return {
      status: "RESOLVED",
      recipient: { reference, linkedUserId: user.id, ...(displayName && { displayName }) },
    };
  }

  return {
    async resolve(userId, reference) {
      switch (reference.type) {
        case "KAADA_USER":
          return kaadaUser(reference);

        case "SAVED_BENEFICIARY":
          return pick(await savedMatches(userId, reference));

        case "USERNAME": {
          const saved = await savedMatches(userId, reference);
          return saved.length > 0 ? pick(saved) : kaadaUser(reference);
        }

        case "TELEGRAM_USER": {
          const value = reference.value.trim().replace(/^@/, "");
          const identities = /^\d+$/.test(value)
            ? [await repos.identities.findByExternalId("TELEGRAM", value)].filter((i) => i !== null)
            : await repos.identities.findByUsername("TELEGRAM", value);
          const candidates = await Promise.all(
            identities.map(async (identity): Promise<ResolvedRecipient> => {
              const user = await repos.users.findById(identity.userId);
              const displayName =
                user?.displayName ?? (identity.username ? `@${identity.username}` : undefined);
              return {
                reference,
                linkedUserId: identity.userId,
                ...(displayName && { displayName }),
              };
            }),
          );
          return pick(candidates);
        }

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
