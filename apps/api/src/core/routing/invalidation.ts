import { retireAuthorization } from "../authorization/retire.js";
import type { OnIntentRevised } from "../intents/intent-commit.js";

/**
 * Run whenever an intent's financial details change: every still-usable route built for an older
 * revision becomes INVALID. Rows and their immutable quotes are kept (financial history); a route is
 * simply never selectable again. Revision checks elsewhere (assertRouteUsable, reuse) would reject
 * such routes anyway; this makes the stored state say so.
 */
export const invalidateRoutesOnRevision: OnIntentRevised = async (repositories, intent) => {
  await repositories.routes.invalidateOlderThan(intent.id, intent.revision);
};

/**
 * Run whenever an intent's financial details change: every authorization session and approval built
 * for the old details is retired (cancelled / revoked, never deleted). An approval for the old
 * amount, recipient or asset can therefore never be used for the new one.
 */
export function invalidateAuthorizationOnRevision(now: () => Date): OnIntentRevised {
  return async (repositories, intent) => {
    await retireAuthorization(repositories, intent.id, null, "INTENT_REVISED", now());
  };
}
