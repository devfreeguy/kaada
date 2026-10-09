import { createAssetRegistry } from "@kaada/domain";
import type {
  AssetRegistry,
  AssetRepository,
  ClarificationChoiceRepository,
  ConversationRepository,
  ExecutionRepository,
  IdentityRepository,
  IntentRepository,
  MessageRepository,
  ProviderRepository,
  QuoteRepository,
  RecipientRepository,
  RouteRepository,
  UserRepository,
} from "@kaada/domain";

import type { Database } from "../client/index.js";
import type { Db } from "./db.js";
import { createAssetRepository } from "./assets.js";
import { createClarificationChoiceRepository } from "./clarifications.js";
import { createConversationRepository, createMessageRepository } from "./conversations.js";
import { createIdentityRepository, createUserRepository } from "./identity.js";
import { createIntentRepository } from "./intents.js";
import {
  createExecutionRepository,
  createQuoteRepository,
  createRouteRepository,
} from "./quotes-routes-executions.js";
import { createProviderRepository, createRecipientRepository } from "./recipients-providers.js";

/** Every repository, typed by its domain contract. No Prisma types appear here. */
export interface Repositories {
  users: UserRepository;
  identities: IdentityRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  intents: IntentRepository;
  recipients: RecipientRepository;
  assets: AssetRepository;
  providers: ProviderRepository;
  quotes: QuoteRepository;
  routes: RouteRepository;
  executions: ExecutionRepository;
  clarifications: ClarificationChoiceRepository;
}

function buildRepositories(db: Db): Repositories {
  return {
    users: createUserRepository(db),
    identities: createIdentityRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    intents: createIntentRepository(db),
    recipients: createRecipientRepository(db),
    assets: createAssetRepository(db),
    providers: createProviderRepository(db),
    quotes: createQuoteRepository(db),
    routes: createRouteRepository(db),
    executions: createExecutionRepository(db),
    clarifications: createClarificationChoiceRepository(db),
  };
}

export function createRepositories(database: Database): Repositories {
  return buildRepositories(database.client);
}

/**
 * Runs `work` in one database transaction with repositories bound to it. It commits when `work`
 * resolves and rolls back when it throws. Repositories from `createRepositories` must not be used
 * inside `work`; use the ones passed in.
 */
export function withTransaction<T>(
  database: Database,
  work: (repositories: Repositories) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return database.client.$transaction(
    (tx) => work(buildRepositories(tx)),
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
  );
}

/** The domain AssetRegistry backed by the database. Reads on every call; add caching when needed. */
export function createDatabaseAssetRegistry(database: Database): AssetRegistry {
  return createAssetRegistry(createAssetRepository(database.client));
}
