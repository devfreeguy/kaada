/** The WalletService, or null when WALLET_PROVIDER=none. */
export const WALLET_SERVICE = Symbol("WALLET_SERVICE");
/** The PasskeyService, or null when wallets are not configured. */
export const PASSKEY_SERVICE = Symbol("PASSKEY_SERVICE");
/** A read-only WalletBalanceReader, or null when wallets are not configured. */
export const BALANCE_READER = Symbol("BALANCE_READER");
/** The WalletSetupService (setup links and passkey onboarding), or null when wallets are not configured. */
export const WALLET_SETUP_SERVICE = Symbol("WALLET_SETUP_SERVICE");
/** The WalletBalanceService (fresh, read-only Celo balances), or null when wallets are not configured. */
export const WALLET_BALANCE_SERVICE = Symbol("WALLET_BALANCE_SERVICE");
/** Repositories for the wallet edge (development user creation only). */
export const WALLET_REPOSITORIES = Symbol("WALLET_REPOSITORIES");
