import { createId } from "@kaada/domain";
import type { IdentityRepository, IdentityType, JsonObject, UserRepository } from "@kaada/domain";

import type { ChannelIdentity } from "./types.js";

const IDENTITY_TYPES: Partial<Record<ChannelIdentity["channel"], IdentityType>> = {
  TELEGRAM: "TELEGRAM",
  WHATSAPP: "WHATSAPP",
  DISCORD: "DISCORD",
  X: "X",
};

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

export interface ResolvedChannelUser {
  userId: string;
  /** True when this call created the Kaada account (the person's first contact). */
  created: boolean;
}

/**
 * Maps a channel account to a Kaada user. A channel identity is attached to a user; it is not the user, and it is not a wallet.
 *
 *  - The key is the provider's stable id (Telegram: the numeric user id). Usernames and names are metadata that follow the
 *    person around and can change without ever creating a second account.
 *  - One provider account belongs to exactly one Kaada user (the database enforces it with a unique (type, externalId)), and
 *    two simultaneous first messages resolve to the same user.
 *  - No wallet, key or secret is created here.
 */
export class ChannelIdentityService {
  constructor(private readonly deps: { users: UserRepository; identities: IdentityRepository }) {}

  async resolve(identity: ChannelIdentity): Promise<ResolvedChannelUser> {
    const type = IDENTITY_TYPES[identity.channel];
    if (!type) throw new Error(`channel ${identity.channel} has no identity type`);
    if (!identity.externalUserId) throw new Error("a channel identity needs a stable external id");

    const existing = await this.deps.identities.findByExternalId(type, identity.externalUserId);
    if (existing) {
      await this.refreshProfile(existing, identity);
      return { userId: existing.userId, created: false };
    }

    const userId = createId();
    try {
      await this.deps.users.createWithIdentity({
        user: {
          id: userId,
          ...(identity.displayName && { displayName: identity.displayName.slice(0, 120) }),
        },
        identity: {
          id: createId(),
          userId,
          type,
          externalId: identity.externalUserId,
          ...(identity.username && { username: identity.username }),
          metadata: profileOf(identity),
        },
      });
      return { userId, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Someone else created this account an instant ago: it is theirs, and ours.
      const winner = await this.deps.identities.findByExternalId(type, identity.externalUserId);
      if (!winner) throw error;
      return { userId: winner.userId, created: false };
    }
  }

  private async refreshProfile(
    existing: { id: string; username?: string | undefined; metadata?: JsonObject | undefined },
    identity: ChannelIdentity,
  ): Promise<void> {
    const metadata = profileOf(identity);
    const changed =
      (identity.username ?? undefined) !== (existing.username ?? undefined) ||
      JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(metadata);
    if (!changed) return;
    try {
      await this.deps.identities.updateProfile(existing.id, {
        username: identity.username ?? "",
        metadata,
      });
    } catch {
      // Display metadata is a convenience: never let it fail a message.
    }
  }
}

const profileOf = (identity: ChannelIdentity): JsonObject => ({
  ...(identity.displayName && { displayName: identity.displayName.slice(0, 120) }),
  ...(identity.languageCode && { languageCode: identity.languageCode.slice(0, 16) }),
});
