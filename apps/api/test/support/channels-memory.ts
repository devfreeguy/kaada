import { createId } from "@kaada/domain";
import type {
  ChannelAction,
  ChannelActionRepository,
  ChannelInboundEventRepository,
  ChannelPaymentStatus,
  ChannelPaymentStatusRepository,
  ChannelType,
  UserNotification,
  UserNotificationRepository,
} from "@kaada/domain";

import type {
  ChannelAdapter,
  ChannelTarget,
  InboundChannelMessage,
  OutboundChannelMessage,
  SentMessage,
} from "../../src/core/channels/types.js";

/** The same contracts as the Prisma repositories, including the atomic single-use and compare-and-set behaviour. */
export function createMemoryChannelStores(now: () => Date = () => new Date()) {
  const actions = new Map<string, ChannelAction>();
  const events = new Map<string, { status: "RECEIVED" | "PROCESSED"; receivedAt: Date }>();
  const statuses = new Map<string, ChannelPaymentStatus>();

  const channelActions: ChannelActionRepository = {
    create: (action, at) => {
      const created: ChannelAction = { ...action, createdAt: at };
      actions.set(created.handle, created);
      return Promise.resolve(created);
    },
    findByHandle: (handle) => Promise.resolve(actions.get(handle) ?? null),
    consume: (input) => {
      const action = actions.get(input.handle);
      if (!action || action.channel !== input.channel) {
        return Promise.resolve({ ok: false, reason: "UNKNOWN" });
      }
      if (action.externalUserId !== input.externalUserId) {
        return Promise.resolve({ ok: false, reason: "WRONG_USER" });
      }
      if (action.expiresAt <= input.now) return Promise.resolve({ ok: false, reason: "EXPIRED" });
      if (!action.reusable) {
        // Synchronous check-and-set: of concurrent presses exactly one gets past here.
        if (action.usedAt) return Promise.resolve({ ok: false, reason: "USED" });
        actions.set(action.handle, { ...action, usedAt: input.now });
      }
      return Promise.resolve({ ok: true, action });
    },
    deleteExpiredBefore: (before) => {
      let removed = 0;
      for (const [handle, action] of actions) {
        if (action.expiresAt < before) {
          actions.delete(handle);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };

  const inboundEvents: ChannelInboundEventRepository = {
    claim: (input) => {
      const key = `${input.channel}:${input.externalEventId}`;
      const existing = events.get(key);
      if (!existing) {
        events.set(key, { status: "RECEIVED", receivedAt: input.now });
        return Promise.resolve("NEW");
      }
      if (existing.status === "PROCESSED") return Promise.resolve("DUPLICATE");
      if (existing.receivedAt.getTime() < input.now.getTime() - input.staleMs) {
        events.set(key, { status: "RECEIVED", receivedAt: input.now });
        return Promise.resolve("RECLAIMED");
      }
      return Promise.resolve("IN_PROGRESS");
    },
    markProcessed: (channel, id) => {
      events.set(`${channel}:${id}`, { status: "PROCESSED", receivedAt: now() });
      return Promise.resolve();
    },
    release: (channel, id) => {
      if (events.get(`${channel}:${id}`)?.status === "RECEIVED") events.delete(`${channel}:${id}`);
      return Promise.resolve();
    },
    deleteOlderThan: () => Promise.resolve(0),
  };

  const channelPaymentStatuses: ChannelPaymentStatusRepository = {
    create: (status) => {
      const existing = [...statuses.values()].find(
        (row) => row.authorizationSessionId === status.authorizationSessionId,
      );
      if (existing) return Promise.resolve(existing);
      const created: ChannelPaymentStatus = { ...status, createdAt: now(), updatedAt: now() };
      statuses.set(created.id, created);
      return Promise.resolve(created);
    },
    findBySession: (sessionId) =>
      Promise.resolve(
        [...statuses.values()].find((row) => row.authorizationSessionId === sessionId) ?? null,
      ),
    listActive: (limit) =>
      Promise.resolve([...statuses.values()].filter((row) => !row.terminal).slice(0, limit)),
    transition: (input) => {
      const row = statuses.get(input.id);
      if (!row || row.lastState !== input.from || row.terminal) return Promise.resolve(null);
      const next: ChannelPaymentStatus = {
        ...row,
        lastState: input.to,
        ...(input.terminal !== undefined && { terminal: input.terminal }),
        ...(input.externalStatusMessageId !== undefined && {
          externalStatusMessageId: input.externalStatusMessageId,
        }),
        updatedAt: now(),
      };
      statuses.set(row.id, next);
      return Promise.resolve(next);
    },
    attachStatusMessage: (id, externalStatusMessageId) => {
      const row = statuses.get(id);
      if (row) statuses.set(id, { ...row, externalStatusMessageId });
      return Promise.resolve();
    },
    revert: (input) => {
      const row = statuses.get(input.id);
      if (row && row.lastState === input.to) {
        statuses.set(row.id, { ...row, lastState: input.from, terminal: false });
      }
      return Promise.resolve();
    },
  };

  return { actions, events, statuses, channelActions, inboundEvents, channelPaymentStatuses };
}

export interface SentRecord {
  kind: "send" | "update" | "remove" | "typing" | "ack";
  target?: ChannelTarget;
  externalMessageId?: string;
  message?: OutboundChannelMessage;
}

/** A recording adapter for tests. Behaves like a provider that can edit messages. */
export class FakeAdapter implements ChannelAdapter {
  readonly channel: ChannelType;
  readonly log: SentRecord[] = [];
  private counter = 100;
  failNextSend = false;

  constructor(channel: ChannelType = "TELEGRAM") {
    this.channel = channel;
  }

  verifyWebhook(): boolean {
    return true;
  }
  parseWebhook(): InboundChannelMessage | null {
    return null;
  }
  send(target: ChannelTarget, message: OutboundChannelMessage): Promise<SentMessage> {
    if (this.failNextSend) {
      this.failNextSend = false;
      return Promise.reject(new Error("provider down"));
    }
    this.counter += 1;
    const externalMessageId = String(this.counter);
    this.log.push({ kind: "send", target, message, externalMessageId });
    return Promise.resolve({ externalMessageId });
  }
  update(
    target: ChannelTarget,
    externalMessageId: string,
    message: OutboundChannelMessage,
  ): Promise<SentMessage> {
    this.log.push({ kind: "update", target, externalMessageId, message });
    return Promise.resolve({ externalMessageId });
  }
  acknowledge(): Promise<void> {
    this.log.push({ kind: "ack" });
    return Promise.resolve();
  }
  indicateTyping(): Promise<void> {
    this.log.push({ kind: "typing" });
    return Promise.resolve();
  }
  remove(target: ChannelTarget, externalMessageId: string): Promise<void> {
    this.log.push({ kind: "remove", target, externalMessageId });
    return Promise.resolve();
  }

  get sent(): OutboundChannelMessage[] {
    return this.log.flatMap((entry) =>
      entry.kind === "send" && entry.message ? [entry.message] : [],
    );
  }
  get last(): OutboundChannelMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

/** A Telegram-shaped inbound text, with stable ids. */
export function inbound(input: {
  text?: string;
  command?: "START" | "HELP" | "CANCEL";
  action?: string;
  eventId: string;
  telegramUserId?: string;
  username?: string;
  chatId?: string;
  messageId?: string;
  isPrivate?: boolean;
  /** When the person sent it (default: a fixed past date). */
  at?: Date;
}): InboundChannelMessage {
  const userId = input.telegramUserId ?? "424242";
  return {
    channel: "TELEGRAM",
    externalEventId: input.eventId,
    externalMessageId: input.messageId ?? `m-${input.eventId}`,
    externalConversationId: input.chatId ?? userId,
    sender: {
      channel: "TELEGRAM",
      externalUserId: userId,
      ...(input.username && { username: input.username }),
      displayName: "Test Person",
    },
    isPrivate: input.isPrivate ?? true,
    content: input.action
      ? { kind: "ACTION", handle: input.action, ackToken: `ack-${input.eventId}` }
      : input.command
        ? { kind: "COMMAND", command: input.command }
        : { kind: "TEXT", text: input.text ?? "" },
    timestamp: input.at ?? new Date("2026-10-22T12:00:00Z"),
  };
}

export const newId = createId;

/** The same contract as the Prisma outbox: one row per (user, kind), and a claim that gives each row to exactly one caller. */
export function createMemoryUserNotifications(
  now: () => Date = () => new Date(),
): UserNotificationRepository & { rows: UserNotification[] } {
  const rows: UserNotification[] = [];
  return {
    rows,
    record: (input) => {
      if (rows.some((row) => row.userId === input.userId && row.kind === input.kind)) {
        return Promise.resolve({ created: false });
      }
      rows.push({
        id: input.id,
        userId: input.userId,
        kind: input.kind,
        createdAt: input.now,
        attempts: 0,
        ...(input.silent && { deliveredAt: input.now }),
      });
      return Promise.resolve({ created: true });
    },
    listForUser: (userId) =>
      Promise.resolve(rows.filter((row) => row.userId === userId).map((row) => ({ ...row }))),
    listUsersInOnboarding: (limit) => {
      const done = new Set(
        rows.filter((row) => row.kind === "ONBOARDING_COMPLETED").map((row) => row.userId),
      );
      const started = rows.filter(
        (row) => row.kind === "ONBOARDING_STARTED" && !done.has(row.userId),
      );
      return Promise.resolve(started.slice(0, limit).map((row) => row.userId));
    },
    claim: (input) => {
      const stale = new Date(input.now.getTime() - input.staleMs);
      const claimed: UserNotification[] = [];
      for (const row of rows) {
        if (claimed.length >= input.limit) break;
        if (row.deliveredAt || row.attempts >= input.maxAttempts) continue;
        if (input.userId && row.userId !== input.userId) continue;
        if (row.claimedAt && row.claimedAt >= stale) continue;
        row.claimedAt = input.now;
        claimed.push({ ...row });
      }
      void now;
      return Promise.resolve(claimed);
    },
    markDelivered: (ids, at) => {
      for (const row of rows) if (ids.includes(row.id) && !row.deliveredAt) row.deliveredAt = at;
      return Promise.resolve();
    },
    release: (ids) => {
      for (const row of rows) {
        if (ids.includes(row.id) && !row.deliveredAt) {
          delete row.claimedAt;
          row.attempts += 1;
        }
      }
      return Promise.resolve();
    },
  };
}
