import type { Intent } from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";

/**
 * The payment this chat is in the middle of: the newest intent that can still be completed or changed, UNLESS its payment was already
 * approved and handed to the executor (a consumed approval, or an execution that is signing, sent, settling or done).
 *
 * That payment is finished business. A later "send 1000 naira to Jay" is a NEW payment, so it must start a new intent instead of
 * merging into the one that was just paid (which would reuse its revision, cancel its links and be refused by the double-spend
 * guard, so the person could never pay anyone a second time in the same chat).
 */
export async function findActiveIntent(
  repositories: Pick<AgentRepositories, "intents" | "paymentAuthorizations">,
  conversationId: string,
): Promise<Intent | null> {
  const open = await repositories.intents.findOpenByConversation(conversationId);
  if (!open) return null;
  return (await repositories.paymentAuthorizations.hasSpendingExecution(open.id)) ? null : open;
}
