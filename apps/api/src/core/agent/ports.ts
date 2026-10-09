import type {
  AssetRepository,
  ClarificationChoiceRepository,
  ConversationRepository,
  IdentityRepository,
  IntentRepository,
  MessageRepository,
  ProviderRepository,
  QuoteRepository,
  RecipientRepository,
  RouteRepository,
  UserRepository,
} from "@kaada/domain";

/** The repositories the agent core reads and writes. All are domain contracts. */
export interface AgentRepositories {
  users: UserRepository;
  identities: IdentityRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  intents: IntentRepository;
  recipients: RecipientRepository;
  assets: AssetRepository;
  clarifications: ClarificationChoiceRepository;
  quotes: QuoteRepository;
  routes: RouteRepository;
  providers: ProviderRepository;
}

/**
 * How the core talks to storage. `transaction` runs `work` atomically and must give back repositories
 * bound to that transaction; `read` is for reads and single idempotent writes outside one. The core
 * never holds a transaction open across a call to the interpreter.
 */
export interface AgentUnitOfWork {
  read: AgentRepositories;
  transaction<T>(work: (repositories: AgentRepositories) => Promise<T>): Promise<T>;
}

/** Minimal structured logging port: an event name plus identifiers and other non-sensitive fields. */
export type AgentLog = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
) => void;

export const noopLog: AgentLog = () => undefined;
