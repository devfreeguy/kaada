import type {
  AuthorizationSessionStatus,
  ChannelPaymentStatus,
  ChannelPaymentStatusRepository,
  ChannelType,
  ExecutionPlanRecord,
} from "@kaada/domain";

import { paymentView } from "../execution/run-status.js";
import type { RunOutcome } from "../execution/runner.js";
import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { NO_CAPABILITIES } from "../conversation/capabilities.js";
import { fallbackParts } from "../conversation/fallbacks.js";
import type {
  ChannelAdapter,
  ChannelTarget,
  NotificationType,
  OutboundAction,
  OutboundChannelMessage,
} from "./types.js";

/**
 * Where a payment is, in terms a chat can announce. Derived ONLY from what the payment services already decided (the
 * authorization session, the PIN approval, the execution record): the channel layer observes, it never advances anything.
 */
export type PaymentProgress =
  | { state: "AWAITING_AUTHORIZATION" }
  | { state: "AUTHORIZATION_EXPIRED" }
  | { state: "AUTHORIZATION_CANCELLED" }
  | { state: "PREPARING" }
  | { state: "ROOT_ACTION_REQUIRED" }
  | { state: "PROCESSING" }
  | { state: "PENDING" }
  | { state: "COMPLETED" }
  | { state: "FAILED"; code?: string }
  | { state: "INSUFFICIENT_BALANCE" }
  | { state: "REAUTHORIZATION_REQUIRED" }
  | { state: "GAS_FUNDING_REQUIRED" }
  | { state: "NO_ROUTE" };

export type PaymentProgressState = PaymentProgress["state"];

const TERMINAL: ReadonlySet<PaymentProgressState> = new Set([
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_CANCELLED",
  "COMPLETED",
  "FAILED",
  "INSUFFICIENT_BALANCE",
  "REAUTHORIZATION_REQUIRED",
  "NO_ROUTE",
]);

/** What the services know about one authorization, as plain data (the Nest glue reads it from the repositories). */
export interface PaymentFacts {
  session: { status: AuthorizationSessionStatus; expiresAt: Date } | null;
  /** The PIN approval, once the person authorized. */
  authorized: boolean;
  plan: ExecutionPlanRecord | null;
  /** The most recent run outcome in this process, if any (it can be fresher than the stored record). */
  latestRun?: RunOutcome | undefined;
}

export interface PaymentFactsReader {
  read(authorizationSessionId: string): Promise<PaymentFacts>;
}

/** The pure derivation. A stored status never claims more than the services agreed on (see paymentView). */
export function deriveProgress(facts: PaymentFacts, now: Date): PaymentProgress {
  if (!facts.authorized) {
    const session = facts.session;
    if (!session || session.status === "CANCELLED") return { state: "AUTHORIZATION_CANCELLED" };
    if (session.status === "EXPIRED" || session.expiresAt.getTime() <= now.getTime()) {
      return { state: "AUTHORIZATION_EXPIRED" };
    }
    return { state: "AWAITING_AUTHORIZATION" };
  }
  const view = paymentView(facts.plan, facts.latestRun);
  switch (view.state) {
    case "NOT_STARTED":
      return { state: "PREPARING" };
    case "ROOT_ACTION_REQUIRED":
      return { state: "ROOT_ACTION_REQUIRED" };
    case "PROCESSING_PAYMENT":
      return { state: "PROCESSING" };
    case "PAYMENT_PENDING":
      return { state: "PENDING" };
    case "PAYMENT_SENT":
      return { state: "COMPLETED" };
    case "PAYMENT_FAILED":
      return { state: "FAILED", ...(view.code && { code: view.code }) };
    case "REAUTHORIZATION_REQUIRED":
      return { state: "REAUTHORIZATION_REQUIRED" };
    case "GAS_FUNDING_REQUIRED":
      return { state: "GAS_FUNDING_REQUIRED" };
    case "INSUFFICIENT_BALANCE":
      return { state: "INSUFFICIENT_BALANCE" };
    case "EXECUTION_ROUTE_UNSUPPORTED":
      return { state: "NO_ROUTE" };
  }
}

export const isTerminalProgress = (state: PaymentProgressState): boolean => TERMINAL.has(state);

/** The notification type a state corresponds to (so recovery and payment alerts share one vocabulary). */
export function notificationTypeOf(progress: PaymentProgress): NotificationType | null {
  switch (progress.state) {
    case "AWAITING_AUTHORIZATION":
      return "PAYMENT_AUTHORIZATION_REQUIRED";
    case "AUTHORIZATION_EXPIRED":
    case "AUTHORIZATION_CANCELLED":
      return "PAYMENT_QUOTE_EXPIRED";
    case "PREPARING":
    case "PROCESSING":
      return "PAYMENT_PROCESSING";
    case "ROOT_ACTION_REQUIRED":
      return "PAYMENT_ROOT_ACTION_REQUIRED";
    case "PENDING":
      return "PAYMENT_PENDING";
    case "COMPLETED":
      return "PAYMENT_COMPLETED";
    case "FAILED":
      return "PAYMENT_FAILED";
    case "INSUFFICIENT_BALANCE":
      return "PAYMENT_INSUFFICIENT_BALANCE";
    case "REAUTHORIZATION_REQUIRED":
      return "PAYMENT_REAUTHORIZATION_REQUIRED";
    case "GAS_FUNDING_REQUIRED":
      return "PAYMENT_GAS_FUNDING_REQUIRED";
    case "NO_ROUTE":
      return "PAYMENT_NO_ROUTE";
  }
}

/**
 * The words for a payment state. Calm, never blames, and never tells anyone to retry a payment that might already be on its
 * way: an unconfirmed payment is "being confirmed", not "failed".
 */
/**
 * What a person is told about a payment's progress. Every state's meaning is fixed; only the wording of a completed payment
 * varies (stably, by `seed`), and it never invents a detail: there is no model here, and status messages are re-read on a timer.
 */
export function describeProgress(progress: PaymentProgress, seed = ""): string {
  switch (progress.state) {
    case "AWAITING_AUTHORIZATION":
      return "Waiting for your confirmation on the secure page.";
    case "AUTHORIZATION_EXPIRED":
      return "That payment wasn't confirmed in time, so I cancelled it. Tell me again if you still want to send it.";
    case "AUTHORIZATION_CANCELLED":
      return "That payment was cancelled.";
    case "PREPARING":
      return "Authorized ✅ Confirming the final price…";
    case "ROOT_ACTION_REQUIRED":
      return "One security step is needed before this payment can be sent.";
    case "PROCESSING":
      return "Processing your payment…";
    case "PENDING":
      return "Your payment has been submitted and is still confirming. You don't need to do anything, and please don't send it again.";
    case "COMPLETED": {
      const parts = fallbackParts("PAYMENT_COMPLETED", { capabilities: NO_CAPABILITIES }, seed);
      return parts
        ? `${parts.acknowledgement ?? "Payment sent ✅"}\n\n${parts.closing ?? "Anything else?"}`
        : "Payment sent ✅";
    }
    case "FAILED":
      return `The payment didn't go through, and your funds are safe.${progress.code ? ` Reference: ${progress.code}.` : ""}`;
    case "INSUFFICIENT_BALANCE":
      return "You don't have enough funds for this payment.";
    case "REAUTHORIZATION_REQUIRED":
      return "The price or the authorization changed before the payment went out, so nothing was sent. Ask me to set the payment up again and you'll confirm it once more.";
    case "GAS_FUNDING_REQUIRED":
      return "Your wallet needs a little CELO to cover network fees before this payment can be sent.";
    case "NO_ROUTE":
      return "I can't find an available route for this payment right now. Try again in a little while.";
  }
}

export interface PaymentStatusDispatcherDeps {
  statuses: ChannelPaymentStatusRepository;
  facts: PaymentFactsReader;
  adapters: ReadonlyMap<ChannelType, ChannelAdapter>;
  /** A secure link for the root step of this payment, issued when that state is announced. Null when none is waiting. */
  rootActionLink?(authorizationSessionId: string, userId: string): Promise<string | null>;
  /** Light follow-up buttons offered under a completed payment (server-bound suggestions). Optional. */
  completionActions?(status: ChannelPaymentStatus): Promise<OutboundAction[]>;
  now?: () => Date;
  log?: AgentLog;
  batch?: number;
}

/**
 * Tells people how their payments are going, in the chat they asked in. It is a pure observer, driven from the database, so it
 * survives restarts and works the same whichever process ran the payment:
 *
 *  - every pass reads each unfinished payment's current state and compares it with what the person was last told;
 *  - a change is claimed with a compare-and-set before anything is sent, so two instances (or a repeated pass) cannot announce
 *    the same change twice, and a failed send puts the claim back so the next pass tries again;
 *  - one status message is EDITED as the payment moves, rather than a new message per step.
 */
export class PaymentStatusDispatcher {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: PaymentStatusDispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async sweep(): Promise<{ examined: number; announced: number }> {
    const rows = await this.deps.statuses.listActive(this.deps.batch ?? 50);
    let announced = 0;
    for (const row of rows) {
      try {
        if (await this.advance(row)) announced += 1;
      } catch (error) {
        this.log("warn", "channel.payment_status.failed", {
          statusId: row.id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    return { examined: rows.length, announced };
  }

  private async advance(row: ChannelPaymentStatus): Promise<boolean> {
    const adapter = this.deps.adapters.get(row.channel);
    if (!adapter) return false;
    const progress = deriveProgress(
      await this.deps.facts.read(row.authorizationSessionId),
      this.now(),
    );
    if (progress.state === row.lastState) return false;

    const claimed = await this.deps.statuses.transition({
      id: row.id,
      from: row.lastState,
      to: progress.state,
      terminal: isTerminalProgress(progress.state),
    });
    if (!claimed) return false; // another instance announced it

    try {
      await this.announce(adapter, claimed, progress);
      return true;
    } catch (error) {
      // Nothing reached the person: undo the claim so the next pass tries again.
      await this.deps.statuses.revert({ id: row.id, from: row.lastState, to: progress.state });
      throw error;
    }
  }

  private async announce(
    adapter: ChannelAdapter,
    claimed: ChannelPaymentStatus,
    progress: PaymentProgress,
  ): Promise<void> {
    const target: ChannelTarget = { externalConversationId: claimed.externalConversationId };
    const message: OutboundChannelMessage = {
      text: describeProgress(progress, claimed.authorizationSessionId),
    };
    if (progress.state === "COMPLETED" && this.deps.completionActions) {
      const actions = await this.deps.completionActions(claimed).catch(() => []);
      if (actions.length > 0) message.actions = actions;
    }
    if (progress.state === "ROOT_ACTION_REQUIRED" && this.deps.rootActionLink) {
      const url = await this.deps.rootActionLink(claimed.authorizationSessionId, claimed.userId);
      if (url) {
        message.actions = [
          { type: "OPEN_URL", semantic: "OPEN_ROOT_ACTION", label: "Continue securely", url },
        ];
      }
    }

    const closed =
      progress.state === "AUTHORIZATION_EXPIRED" || progress.state === "AUTHORIZATION_CANCELLED";
    if (closed && claimed.externalSummaryMessageId) {
      // The summary's "Authorize payment" button must stop being offered: replace the summary itself.
      await adapter.update(target, claimed.externalSummaryMessageId, message);
      return;
    }
    if (claimed.externalStatusMessageId) {
      await adapter.update(target, claimed.externalStatusMessageId, message);
      return;
    }
    const sent = await adapter.send(target, message);
    await this.deps.statuses.attachStatusMessage(claimed.id, sent.externalMessageId);
  }
}
