import { hasFinancialChange } from "@kaada/domain";
import type { Intent, NewIntent } from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";

/**
 * Called once after an intent's financial details change, with the new revision. This is the single
 * place where anything derived from the previous version must be thrown away: a later build hooks
 * quote and route invalidation here. Anything that stores the revision it was made from (clarification
 * options today) is already stale by comparison and needs no write.
 */
export type OnIntentRevised = (
  repositories: AgentRepositories,
  intent: Intent,
  previousRevision: number,
) => Promise<void>;

export const noopOnIntentRevised: OnIntentRevised = () => Promise.resolve();

export interface CommitResult {
  intent: Intent;
  /** True when this commit moved the revision, i.e. a financial detail changed. */
  revised: boolean;
}

/**
 * The only place an intent is written during a turn, and so the only place its revision moves.
 * `state` is the full desired state; the revision it carries is ignored and recomputed:
 * - a new intent starts at 1;
 * - an existing one stays put unless a financial detail changed (hasFinancialChange), in which case
 *   it goes up by one and the revised hook runs;
 * - asking a question, restating the same details or changing only status never moves it.
 */
export async function commitIntent(
  repositories: AgentRepositories,
  args: { previous: Intent | null; state: NewIntent; onRevised: OnIntentRevised },
): Promise<CommitResult> {
  const { previous, state } = args;
  if (!previous) {
    return { intent: await repositories.intents.create({ ...state, revision: 1 }), revised: false };
  }

  const revised = hasFinancialChange(previous, state);
  const revision = previous.revision + (revised ? 1 : 0);
  const intent = await repositories.intents.save({
    ...state,
    revision,
    createdAt: previous.createdAt,
    updatedAt: previous.updatedAt,
  });
  if (revised) await args.onRevised(repositories, intent, previous.revision);
  return { intent, revised };
}
