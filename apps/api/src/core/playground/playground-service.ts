import { createId } from "@kaada/domain";
import type { Conversation, Intent, Message } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import type { ChannelMessageService } from "../channels/message-service.js";
import type { InboundChannelMessage, OutboundChannelMessage } from "../channels/types.js";
import { errorDetails } from "../channels/error-details.js";
import { contentOfText } from "../channels/command-parser.js";
import { collectTrace } from "../channels/trace.js";
import type { TraceEvent } from "../channels/trace.js";
import type { PlaygroundAdapter } from "../../infrastructure/channels/playground/playground-adapter.js";
import { buildSimulatedExecution, describeSimulation } from "./execution-intent.js";
import type { SimulatedExecutionIntent } from "./execution-intent.js";

/*
 * The development playground, as a service.
 *
 * It owns no conversation logic of its own. A turn is built into the same InboundChannelMessage a Telegram update becomes and
 * handed to the same ChannelMessageService.handleInbound, so the interpreter, the coordinator, the currency registry, the
 * conversation memory, the presenter and the opaque button handles are all the ones Telegram uses.
 *
 * What it adds is only observation and containment:
 *   - it runs the turn inside the trace context, so the events the services already log can be shown to a developer;
 *   - it marks the turn as a playground turn, which is what keeps routing away from any wallet (see RoutingService.plan);
 *   - afterwards it reads what the application STORED for the turn and, for a payment, writes down what would have happened.
 */

export interface PlaygroundSession {
  /** Identifies the browser session. Also the external user id of its own WEB identity. */
  sessionId: string;
  /** The chat. Resetting the conversation issues a new one, leaving the old transcript in place. */
  conversationId: string;
}

export interface PlaygroundTurn {
  /** What Kaada said, in order, exactly as any channel adapter would receive it. */
  messages: OutboundChannelMessage[];
  /** The structured answers the agent stored for this turn (AgentResponse objects). */
  responses: unknown[];
  /** The stored intent this turn worked on, if any. */
  intent: StoredIntentView | null;
  /** What the conversation is now waiting to be told, if anything. */
  focus: unknown;
  /** Present only for a payment or conversion: what the application would have executed. */
  simulated: SimulatedExecutionIntent | null;
  /** The sentence shown under a simulated payment. */
  simulationNote: string | null;
  /** The structured events the services logged while handling this turn. */
  trace: TraceEvent[];
  elapsedMs: number;
  result: string;
}

/** The parts of a stored intent worth showing a developer. No secrets exist on an intent. */
export interface StoredIntentView {
  id: string;
  type: string;
  status: string;
  revision: number;
  missingFields: string[];
  /** What the language step read, after validation. */
  parsed: unknown;
  /** The canonical amount the application resolved, in exact smallest units. */
  amount: unknown;
  sourceAssetId?: string;
  destinationAssetId?: string;
  preferredSourceAssetId?: string;
  destinationCountry?: string;
  recipientId?: string;
}

export interface PlaygroundDeps {
  /**
   * The shared orchestrator, wired for the playground: the same class and the same agent as Telegram, with the wallet-facing
   * capabilities left out entirely, so there is nothing for it to call even if something asked.
   */
  messages: ChannelMessageService;
  adapter: PlaygroundAdapter;
  conversations: {
    findByExternalId(
      channel: "WEB",
      externalConversationId: string,
    ): Promise<Conversation | null>;
  };
  storedMessages: { listRecent(conversationId: string, limit: number): Promise<Message[]> };
  intents: { listRecentByConversation(id: string, limit: number): Promise<Intent[]> };
  log?: AgentLog;
  now?: () => Date;
}

/** A session id a browser cannot forge into another session's: random, and used verbatim as the identity's external id. */
export function newSession(): PlaygroundSession {
  return { sessionId: `pg_${createId()}`, conversationId: `pg-chat-${createId()}` };
}

export class PlaygroundService {
  private readonly now: () => Date;

  constructor(private readonly deps: PlaygroundDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * A typed message, exactly as a Telegram text message would arrive, including the slash-command reading: "/rates naira to
   * argentine pesos" becomes the RATES command carrying its arguments, through the same parser the Telegram adapter uses.
   */
  message(session: PlaygroundSession, text: string): Promise<PlaygroundTurn> {
    return this.run(session, contentOfText(text));
  }

  /**
   * A pressed button. It travels as an ACTION carrying the opaque handle the presenter issued, which is what Telegram's
   * callback_data carries, so the same claim, binding and expiry rules apply. It is never turned into text.
   */
  action(session: PlaygroundSession, handle: string): Promise<PlaygroundTurn> {
    return this.run(session, { kind: "ACTION", handle });
  }

  private async run(
    session: PlaygroundSession,
    content: InboundChannelMessage["content"],
  ): Promise<PlaygroundTurn> {
    const inbound: InboundChannelMessage = {
      channel: "WEB",
      externalEventId: `pg-event-${createId()}`,
      externalMessageId: `pg-msg-${createId()}`,
      externalConversationId: session.conversationId,
      sender: {
        channel: "WEB",
        externalUserId: session.sessionId,
        displayName: "Playground",
      },
      // A playground chat is one-to-one by construction.
      isPrivate: true,
      content,
      timestamp: this.now(),
    };

    const started = Date.now();
    const { result, events } = await collectTrace(
      () => this.deps.messages.handleInbound(inbound),
      { playground: true },
    );
    const elapsedMs = Date.now() - started;

    const messages = this.deps.adapter.drain(session.conversationId);
    // Reading back what the turn stored is for the developer's benefit only: the turn itself has already happened and the
    // person already has their answer. A failure here (a database hiccup, a stale client after a migration) must therefore
    // degrade to "no debug detail", never turn a completed turn into a 500 and lose the reply with it.
    const stored = await this.readStoredTurn(session).catch((error: unknown) => {
      this.deps.log?.("warn", "playground.debug_read_failed", {
        conversationId: session.conversationId,
        ...errorDetails(error),
      });
      return { responses: [], lastResponse: null, intent: null, focus: null };
    });

    const simulated =
      stored.intent && stored.lastResponse
        ? buildSimulatedExecution(stored.intent, stored.lastResponse)
        : null;
    if (simulated) {
      // The development terminal gets the event, whole, as the record of what WOULD have run.
      this.deps.log?.("info", "PLAYGROUND_EXECUTION_INTENT", {
        intent: simulated.intent,
        intentId: simulated.intentId,
        executionMode: simulated.executionMode,
        // The whole event, as the development terminal should show it.
        event: JSON.stringify(simulated, null, 2),
      });
    }

    return {
      messages,
      responses: stored.responses,
      intent: stored.intent ? viewOf(stored.intent) : null,
      focus: stored.focus,
      simulated,
      simulationNote: simulated ? describeSimulation(simulated) : null,
      trace: events,
      elapsedMs,
      result,
    };
  }

  /** What the application stored for this turn: its answers, the intent it worked on and the conversation's focus. */
  private async readStoredTurn(
    session: PlaygroundSession,
  ): Promise<{
    responses: unknown[];
    lastResponse: ReturnType<typeof asResponse>;
    intent: Intent | null;
    focus: unknown;
  }> {
    const conversation = await this.deps.conversations.findByExternalId(
      "WEB",
      session.conversationId,
    );
    if (!conversation) return { responses: [], lastResponse: null, intent: null, focus: null };

    const recent = await this.deps.storedMessages.listRecent(conversation.id, 12);
    // Everything the assistant stored AFTER the last thing the person said is this turn's work. Anchoring on the transcript
    // rather than on a clock keeps it right whatever the stored timestamps are.
    const lastUserAt = recent.map((message) => message.role).lastIndexOf("USER");
    const answers = recent
      .slice(lastUserAt + 1)
      .filter((message) => message.role === "ASSISTANT");
    const responses = answers.map((message) => message.structuredData).filter((d) => d !== undefined);
    const [intent = null] = await this.deps.intents.listRecentByConversation(conversation.id, 1);
    const last = answers.at(-1);
    return {
      responses,
      lastResponse: asResponse(last?.structuredData),
      intent,
      focus: conversation.metadata?.["focus"] ?? null,
    };
  }
}

/** A stored structured answer, read back as the AgentResponse it is. Shape-checked, never trusted blindly. */
function asResponse(stored: unknown): import("../responses/agent-response.js").AgentResponse | null {
  if (stored === null || typeof stored !== "object") return null;
  const type = (stored as { type?: unknown }).type;
  return typeof type === "string"
    ? (stored as import("../responses/agent-response.js").AgentResponse)
    : null;
}

function viewOf(intent: Intent): StoredIntentView {
  return {
    id: intent.id,
    type: intent.type,
    status: intent.status,
    revision: intent.revision,
    missingFields: intent.missingFields,
    parsed: intent.parsed ?? null,
    amount: intent.amount ?? null,
    ...(intent.sourceAssetId && { sourceAssetId: intent.sourceAssetId }),
    ...(intent.destinationAssetId && { destinationAssetId: intent.destinationAssetId }),
    ...(intent.preferredSourceAssetId && {
      preferredSourceAssetId: intent.preferredSourceAssetId,
    }),
    ...(intent.destinationCountry && { destinationCountry: intent.destinationCountry }),
    ...(intent.recipientId && { recipientId: intent.recipientId }),
  };
}
