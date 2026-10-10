import type {
  AssetRepository,
  AuditRepository,
  DelegatedPermissionRepository,
  PasskeyRepository,
  WalletRepository,
  WalletSetupSessionRepository,
} from "@kaada/domain";

/** The repositories the wallet services read and write. All are domain contracts. */
export interface WalletRepositories {
  wallets: WalletRepository;
  passkeys: PasskeyRepository;
  delegatedPermissions: DelegatedPermissionRepository;
  audit: AuditRepository;
  walletSetupSessions: WalletSetupSessionRepository;
  assets: AssetRepository;
}

/**
 * Storage for the wallet services. `transaction` runs `work` atomically with repositories bound to
 * it. A transaction is never held open across a call to a wallet provider.
 */
export interface WalletUnitOfWork {
  read: WalletRepositories;
  transaction<T>(work: (repositories: WalletRepositories) => Promise<T>): Promise<T>;
}
