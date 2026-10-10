import type {
  AssetRepository,
  AuditRepository,
  AuthorizationSessionRepository,
  IntentRepository,
  PaymentAuthorizationRepository,
  QuoteRepository,
  RecipientRepository,
  RouteRepository,
  TransactionPinRepository,
  WalletRepository,
} from "@kaada/domain";

/** The repositories the authorization services read and write. All are domain contracts. */
export interface AuthorizationRepositories {
  transactionPins: TransactionPinRepository;
  authorizationSessions: AuthorizationSessionRepository;
  paymentAuthorizations: PaymentAuthorizationRepository;
  audit: AuditRepository;
  intents: IntentRepository;
  routes: RouteRepository;
  quotes: QuoteRepository;
  wallets: WalletRepository;
  recipients: RecipientRepository;
  assets: AssetRepository;
}

/**
 * Storage for the authorization services. `transaction` runs `work` atomically with repositories
 * bound to it. A transaction is never held open across password hashing.
 */
export interface AuthorizationUnitOfWork {
  read: AuthorizationRepositories;
  transaction<T>(work: (repositories: AuthorizationRepositories) => Promise<T>): Promise<T>;
}

/** Hashes and checks PINs. The only implementation is Argon2id; tests may tune its cost, never its kind. */
export interface PinHasher {
  hash(pin: string): Promise<string>;
  /** Constant-time comparison inside the hashing library. Never throws for a wrong PIN. */
  verify(hash: string, pin: string): Promise<boolean>;
}
