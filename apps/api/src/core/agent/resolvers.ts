import { createAssetRegistry } from "@kaada/domain";

import { createAssetResolver } from "../assets/asset-resolver.js";
import type { AssetResolver } from "../assets/asset-resolver.js";
import { createRepositoryRecipientResolver } from "../recipients/recipient-resolver.js";
import type { RecipientResolver } from "../recipients/recipient-resolver.js";
import type { AgentRepositories } from "./ports.js";

export interface AgentResolvers {
  assets: AssetResolver;
  recipients: RecipientResolver;
}

/**
 * Resolvers backed by the given repositories. The agent builds these from the repositories of the
 * transaction it is running in, so lookups never need a second database connection.
 */
export function createDefaultResolvers(repositories: AgentRepositories): AgentResolvers {
  return {
    assets: createAssetResolver(createAssetRegistry(repositories.assets)),
    recipients: createRepositoryRecipientResolver(repositories),
  };
}
