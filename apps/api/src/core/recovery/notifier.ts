import { RECOVERY_AUDIT_EVENTS, createId } from "@kaada/domain";
import type {
  ChannelMessage,
  ChannelMessenger,
  IdentityRepository,
  AuditRepository,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";

export interface NotificationResult {
  delivered: number;
  failed: number;
  /** How many linked identities had no messenger that supports them (for example WhatsApp for now). */
  unsupported: number;
}

/**
 * Tells EVERY linked channel of a user (email, Telegram, WhatsApp when it exists) that something happened to their
 * recovery. A failing channel never blocks the others, and nothing about a failure is allowed to stop the recovery.
 */
export class RecoveryNotifier {
  constructor(
    private readonly deps: {
      identities: Pick<IdentityRepository, "listForUser">;
      audit: Pick<AuditRepository, "append">;
      messengers: ChannelMessenger[];
      log?: AgentLog;
    },
  ) {}

  async notify(
    userId: string,
    entityId: string,
    message: ChannelMessage,
  ): Promise<NotificationResult> {
    const log = this.deps.log ?? noopLog;
    const identities = await this.deps.identities.listForUser(userId);
    const result: NotificationResult = { delivered: 0, failed: 0, unsupported: 0 };
    for (const identity of identities) {
      const messenger = this.deps.messengers.find((candidate) => candidate.supports(identity.type));
      if (!messenger) {
        result.unsupported += 1;
        continue;
      }
      try {
        await messenger.send({ type: identity.type, externalId: identity.externalId }, message);
        result.delivered += 1;
      } catch {
        result.failed += 1;
        log("warn", "recovery.notification_failed", { userId, channel: identity.type });
      }
    }
    await this.deps.audit.append({
      id: createId(),
      userId,
      type:
        result.failed > 0
          ? RECOVERY_AUDIT_EVENTS.notificationFailed
          : RECOVERY_AUDIT_EVENTS.notificationSent,
      entityType: "recovery_attempt",
      entityId,
      // Counts only: never an address, a handle or the message.
      data: { ...result },
    });
    return result;
  }
}
