import { createAssetRegistry } from "@kaada/domain";
import type {
  AssetRegistry,
  AssetRepository,
  AuditRepository,
  WalletSetupSessionRepository,
  AuthorizationSessionRepository,
  ExecutionPlanRepository,
  ExecutionTransactionRepository,
  RootActionSessionRepository,
  ExecutionSecretRepository,
  FirmQuoteAttemptRepository,
  PaymentAuthorizationRepository,
  TransactionPinRepository,
  DelegatedPermissionRepository,
  PasskeyRepository,
  WalletRepository,
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
import {
  createAuthorizationSessionRepository,
  createPaymentAuthorizationRepository,
  createTransactionPinRepository,
} from "./authorization.js";
import { createClarificationChoiceRepository } from "./clarifications.js";
import { createConversationRepository, createMessageRepository } from "./conversations.js";
import {
  createExecutionPlanRepository,
  createExecutionSecretRepository,
  createFirmQuoteAttemptRepository,
} from "./firm.js";
import { createExecutionTransactionRepository, createRootActionSessionRepository } from "./run.js";
import { createIdentityRepository, createUserRepository } from "./identity.js";
import { createIntentRepository } from "./intents.js";
import {
  createExecutionRepository,
  createQuoteRepository,
  createRouteRepository,
} from "./quotes-routes-executions.js";
import { createProviderRepository, createRecipientRepository } from "./recipients-providers.js";
import {
  createAuditRepository,
  createDelegatedPermissionRepository,
  createPasskeyRepository,
  createWalletRepository,
  createWalletSetupSessionRepository,
} from "./wallets.js";

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
  wallets: WalletRepository;
  passkeys: PasskeyRepository;
  delegatedPermissions: DelegatedPermissionRepository;
  audit: AuditRepository;
  walletSetupSessions: WalletSetupSessionRepository;
  transactionPins: TransactionPinRepository;
  authorizationSessions: AuthorizationSessionRepository;
  paymentAuthorizations: PaymentAuthorizationRepository;
  firmQuoteAttempts: FirmQuoteAttemptRepository;
  executionSecrets: ExecutionSecretRepository;
  executionPlans: ExecutionPlanRepository;
  executionTransactions: ExecutionTransactionRepository;
  rootActions: RootActionSessionRepository;
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
    wallets: createWalletRepository(db),
    passkeys: createPasskeyRepository(db),
    delegatedPermissions: createDelegatedPermissionRepository(db),
    audit: createAuditRepository(db),
    walletSetupSessions: createWalletSetupSessionRepository(db),
    transactionPins: createTransactionPinRepository(db),
    authorizationSessions: createAuthorizationSessionRepository(db),
    paymentAuthorizations: createPaymentAuthorizationRepository(db),
    firmQuoteAttempts: createFirmQuoteAttemptRepository(db),
    executionSecrets: createExecutionSecretRepository(db),
    executionPlans: createExecutionPlanRepository(db),
    executionTransactions: createExecutionTransactionRepository(db),
    rootActions: createRootActionSessionRepository(db),
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
  options: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  // maxWait is how long to wait for a pooled connection to START the transaction. Prisma's 2 s default
  // is too tight for a remote database under concurrent load (a burst of callers queues for
  // connections), so it is 10 s unless the caller says otherwise.
  return database.client.$transaction((tx) => work(buildRepositories(tx)), {
    maxWait: options.maxWaitMs ?? 10_000,
    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
  });
}

/** The domain AssetRegistry backed by the database. Reads on every call; add caching when needed. */
export function createDatabaseAssetRegistry(database: Database): AssetRegistry {
  return createAssetRegistry(createAssetRepository(database.client));
}
