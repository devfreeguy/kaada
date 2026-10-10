/** The WalletService, or null when WALLET_PROVIDER=none. */
export const WALLET_SERVICE = Symbol("WALLET_SERVICE");
/** The PasskeyService, or null when wallets are not configured. */
export const PASSKEY_SERVICE = Symbol("PASSKEY_SERVICE");
/** A read-only WalletBalanceReader, or null when wallets are not configured. */
export const BALANCE_READER = Symbol("BALANCE_READER");
