import { randomBytes } from "node:crypto";

import { createId } from "@kaada/domain";
import type {
  ChannelAction,
  ChannelActionKind,
  ChannelActionRejection,
  ChannelActionRepository,
  ChannelType,
} from "@kaada/domain";

/** Buttons stay valid for as long as the question they answer (the agent's options expire after 30 minutes). */
export const DEFAULT_ACTION_TTL_MS = 30 * 60 * 1000;

/**
 * Issues and claims the opaque handles that buttons carry. A provider (Telegram callback_data) sees only a random 22-character
 * handle; the meaning (which option, which payment) lives on the server, bound to the person it was shown to, their chat, an
 * expiry and, unless reusable, a single use. A handle copied to another account is useless.
 */
export class ChannelActionService {
  private readonly now: () => Date;

  constructor(
    private readonly actions: ChannelActionRepository,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the opaque handle to put on a button. */
  async issue(input: {
    userId: string;
    channel: ChannelType;
    externalUserId: string;
    conversationId: string;
    kind: ChannelActionKind;
    payload?: Record<string, string>;
    reusable?: boolean;
    ttlMs?: number;
  }): Promise<string> {
    const handle = randomBytes(16).toString("base64url");
    const now = this.now();
    await this.actions.create(
      {
        id: createId(),
        handle,
        userId: input.userId,
        channel: input.channel,
        externalUserId: input.externalUserId,
        conversationId: input.conversationId,
        kind: input.kind,
        payload: input.payload ?? {},
        reusable: input.reusable ?? false,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_ACTION_TTL_MS)),
      },
      now,
    );
    return handle;
  }

  /** The action behind a pressed button, if this account may use it right now. */
  async claim(input: {
    handle: string;
    channel: ChannelType;
    externalUserId: string;
  }): Promise<{ ok: true; action: ChannelAction } | { ok: false; reason: ChannelActionRejection }> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(input.handle)) return { ok: false, reason: "UNKNOWN" };
    return this.actions.consume({ ...input, now: this.now() });
  }
}
