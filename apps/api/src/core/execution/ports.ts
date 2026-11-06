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
  Permit2AllowanceReader,
  PaymentAuthorizationRepository,
  ProviderRepository,
  RecipientRepository,
  RouteRepository,
  WalletCredentialRepository,
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
  walletCredentials: WalletCredentialRepository;
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
  /**
   * Permit2 allowances, when a Uniswap-style provider is configured. Optional: a deployment that has
   * none never needs it, and the plan then refuses a Permit2-routed swap instead of guessing.
   */
  permit2Allowances?: Permit2AllowanceReader;
  /** Fresh on-chain balances in smallest units, by asset id. */
  balances: { balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> };
  /** Whether the smart account already exists on chain (read-only). */
  isDeployed(input: { chainId: number; address: string }): Promise<boolean>;
}
