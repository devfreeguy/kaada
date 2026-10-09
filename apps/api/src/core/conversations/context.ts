import type { Conversation, ConversationTurn, Intent, Message, MissingField } from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";

/**
 * What the agent knows about a conversation right now, assembled from Postgres (the source of
 * truth) rather than replayed from chat history.
 *
 * The active intent is the most recent intent that is still open (DRAFT, AWAITING_DETAILS,
 * RESOLVED, QUOTING or AWAITING_CONFIRMATION). Terminal intents (COMPLETED, CANCELLED, FAILED,
 * EXPIRED) and in-flight executions are never active. A conversation has at most one active
 * intent; parallel operations in one conversation are not supported yet.
 */
export interface ConversationContext {
  conversation: Conversation;
  recentMessages: Message[];
  activeIntent?: Intent;
  /** The question the user still owes an answer to, if the active intent is waiting on details. */
  pendingClarification?: MissingField;
}

export async function loadConversationContext(
  repositories: Pick<AgentRepositories, "messages" | "intents">,
  conversation: Conversation,
  messageLimit: number,
): Promise<ConversationContext> {
  const [recentMessages, activeIntent] = await Promise.all([
    repositories.messages.listRecent(conversation.id, messageLimit),
    repositories.intents.findOpenByConversation(conversation.id),
  ]);
  const pending =
    activeIntent?.status === "AWAITING_DETAILS" ? activeIntent.missingFields[0] : undefined;
  return {
    conversation,
    recentMessages,
    ...(activeIntent && { activeIntent }),
    ...(pending && { pendingClarification: pending }),
  };
}

/** The user/assistant turns of a conversation, oldest first, minus one message (the current one). */
export function toHistory(messages: Message[], excludeMessageId: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.id === excludeMessageId) continue;
    if (message.role === "USER" || message.role === "ASSISTANT") {
      turns.push({ role: message.role, content: message.content });
    }
  }
  return turns;
}
