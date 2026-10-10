import type {
  AllowanceReader,
  AssetRepository,
  AuditRepository,
  DelegatedPermissionRepository,
  ExecutionPlanRepository,
  ExecutionTransactionRepository,
  RootActionSessionRepository,
  ExecutionSecretRepository,
  FirmQuoteAttemptRepository,
  IntentRepository,
  PasskeyRepository,
  PaymentAuthorizationRepository,
  ProviderRepository,
  RecipientRepository,
  RouteRepository,
  WalletRepository,
} from "@kaada/domain";

/**
 * Authenticated encryption for execution secrets. `context` is bound into the ciphertext (the record
 * it belongs to), so a ciphertext moved to another record does not decrypt.
 */
export interface SecretCipher {
  encrypt(plaintext: string, context: string): { keyVersion: number; ciphertext: string };
  decrypt(ciphertext: string, context: string): string;
}

/** The repositories firm quoting and execution planning read and write. All are domain contracts. */
export interface ExecutionRepositories {
  paymentAuthorizations: PaymentAuthorizationRepository;
  intents: IntentRepository;
  routes: RouteRepository;
  recipients: RecipientRepository;
  wallets: WalletRepository;
  passkeys: PasskeyRepository;
  delegatedPermissions: DelegatedPermissionRepository;
  assets: AssetRepository;
  providers: ProviderRepository;
  firmQuoteAttempts: FirmQuoteAttemptRepository;
  executionSecrets: ExecutionSecretRepository;
  executionPlans: ExecutionPlanRepository;
  executionTransactions: ExecutionTransactionRepository;
  rootActions: RootActionSessionRepository;
  audit: AuditRepository;
}

export interface ExecutionUnitOfWork {
  read: ExecutionRepositories;
  transaction<T>(work: (repositories: ExecutionRepositories) => Promise<T>): Promise<T>;
}

/** Read-only chain access for planning. There is no write method on either member. */
export interface ChainState {
  allowances: AllowanceReader;
  /** Fresh on-chain balances in smallest units, by asset id. */
  balances: { balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> };
  /** Whether the smart account already exists on chain (read-only). */
  isDeployed(input: { chainId: number; address: string }): Promise<boolean>;
}
