import type { ChannelType, IdentityRepository, IdentityType } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import {
  recoveryCancelledMessage,
  recoveryCompletedMessage,
  recoveryStartedMessage,
} from "../recovery/messages.js";
import { describeProgress } from "./payment-status.js";
import type { PaymentProgress } from "./payment-status.js";
import type { ChannelAdapter, NotificationType, OutboundChannelMessage } from "./types.js";

/** A way to reach a person on one kind of linked account (a chat adapter, email...). */
export interface DeliveryChannel {
  supports(identityType: IdentityType): boolean;
  deliver(
    identity: { type: IdentityType; externalId: string },
    message: OutboundChannelMessage,
  ): Promise<void>;
}

const CHAT_IDENTITY_TYPES: Partial<Record<ChannelType, IdentityType>> = {
  TELEGRAM: "TELEGRAM",
  WHATSAPP: "WHATSAPP",
  DISCORD: "DISCORD",
  X: "X",
};

/**
 * Lets any chat adapter be a delivery channel. In a one-to-one chat the provider's account id is also the chat id, so a
 * linked identity is enough to reach the person without any conversation having to exist.
 */
export function adapterDelivery(adapter: ChannelAdapter): DeliveryChannel {
  const type = CHAT_IDENTITY_TYPES[adapter.channel];
  return {
    supports: (identityType) => identityType === type,
    deliver: async (identity, message) => {
      await adapter.send({ externalConversationId: identity.externalId }, message);
    },
  };
}

export type Notification =
  | { type: Exclude<NotificationType, `RECOVERY_${string}` | "PAYMENT_FAILED"> }
  | { type: "PAYMENT_FAILED"; code?: string }
  | { type: "RECOVERY_STARTED"; now: Date; executeAfter: Date; cancelLink: string }
  | { type: "RECOVERY_CANCELLED" }
  | { type: "RECOVERY_COMPLETED"; now: Date };

const PROGRESS_OF: Record<string, PaymentProgress> = {
  PAYMENT_AUTHORIZATION_REQUIRED: { state: "AWAITING_AUTHORIZATION" },
  PAYMENT_ROOT_ACTION_REQUIRED: { state: "ROOT_ACTION_REQUIRED" },
  PAYMENT_PROCESSING: { state: "PROCESSING" },
  PAYMENT_PENDING: { state: "PENDING" },
  PAYMENT_COMPLETED: { state: "COMPLETED" },
  PAYMENT_INSUFFICIENT_BALANCE: { state: "INSUFFICIENT_BALANCE" },
  PAYMENT_NO_ROUTE: { state: "NO_ROUTE" },
  PAYMENT_QUOTE_EXPIRED: { state: "AUTHORIZATION_EXPIRED" },
  PAYMENT_REAUTHORIZATION_REQUIRED: { state: "REAUTHORIZATION_REQUIRED" },
  PAYMENT_GAS_FUNDING_REQUIRED: { state: "GAS_FUNDING_REQUIRED" },
};

/** The words for a notification, in one place for every channel. */
export function renderNotification(notification: Notification): OutboundChannelMessage {
  switch (notification.type) {
    case "RECOVERY_STARTED": {
      const message = recoveryStartedMessage({
        now: notification.now,
        executeAfter: notification.executeAfter,
        cancelLink: notification.cancelLink,
      });
      return { text: `${message.subject}\n\n${message.text}` };
    }
    case "RECOVERY_CANCELLED": {
      const message = recoveryCancelledMessage();
      return { text: `${message.subject}\n\n${message.text}` };
    }
    case "RECOVERY_COMPLETED": {
      const message = recoveryCompletedMessage(notification.now);
      return { text: `${message.subject}\n\n${message.text}` };
    }
    case "PAYMENT_FAILED":
      return {
        text: describeProgress({
          state: "FAILED",
          ...(notification.code && { code: notification.code }),
        }),
      };
    default: {
      const progress = PROGRESS_OF[notification.type];
      return {
        text: progress ? describeProgress(progress) : "There is an update on your Kaada account.",
      };
    }
  }
}

/**
 * Tells a person something happened, on every account they have linked, without the caller knowing which channels exist.
 * Execution and recovery code say WHAT happened (`send(userId, { type, ... })`); adapters decide how it looks. A channel that
 * fails never blocks the others, and a failure is a count, never an exception.
 */
export class NotificationService {
  private readonly log: AgentLog;

  constructor(
    private readonly deps: {
      identities: Pick<IdentityRepository, "listForUser">;
      channels: DeliveryChannel[];
      log?: AgentLog;
    },
  ) {
    this.log = deps.log ?? noopLog;
  }

  async send(
    userId: string,
    notification: Notification,
  ): Promise<{ delivered: number; failed: number; unsupported: number }> {
    const message = renderNotification(notification);
    const result = { delivered: 0, failed: 0, unsupported: 0 };
    for (const identity of await this.deps.identities.listForUser(userId)) {
      const channel = this.deps.channels.find((candidate) => candidate.supports(identity.type));
      if (!channel) {
        result.unsupported += 1;
        continue;
      }
      try {
        await channel.deliver({ type: identity.type, externalId: identity.externalId }, message);
        result.delivered += 1;
      } catch {
        result.failed += 1;
        this.log("warn", "notification.delivery_failed", { userId, channel: identity.type });
      }
    }
    return result;
  }
}
