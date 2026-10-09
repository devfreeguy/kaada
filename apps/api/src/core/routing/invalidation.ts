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
