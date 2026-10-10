export const KAADA_ERROR_CODES = [
  "INVALID_INTENT",
  "INVALID_AMOUNT",
  "ASSET_MISMATCH",
  "INSUFFICIENT_AMOUNT",
  "MISSING_INFORMATION",
  "RECIPIENT_NOT_FOUND",
  "ASSET_NOT_SUPPORTED",
  "PAIR_NOT_SUPPORTED",
  "NO_ROUTE_AVAILABLE",
  "INSUFFICIENT_BALANCE",
  "QUOTE_EXPIRED",
  "SLIPPAGE_EXCEEDED",
  "EXECUTION_FAILED",
  "EXECUTION_NOT_ENABLED",
  "ROOT_CREDENTIAL_REQUIRED",
  "WALLET_PROVISIONING_FAILED",
  "WALLET_NOT_ACTIVE",
  "PERMISSION_REJECTED",
  "CREDENTIAL_REJECTED",
  "SETUP_SESSION_INVALID",
  "PIN_REJECTED",
  "PIN_LOCKED",
  "PIN_NOT_SET",
  "PIN_RESET_REQUIRED",
  "AUTHORIZATION_SESSION_INVALID",
  "AUTHORIZATION_REJECTED",
  "BUNDLER_REJECTED",
  "BUNDLER_UNAVAILABLE",
  "WALLET_ALREADY_SETUP",
  "PROVIDER_UNAVAILABLE",
  "RAMP_UNAVAILABLE",
] as const;

export type KaadaErrorCode = (typeof KAADA_ERROR_CODES)[number];

export interface KaadaErrorOptions {
  /** Structured, non-sensitive context for logs and callers. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** The single error type for expected business failures. Branch on `code`, not on subclasses. */
export class KaadaError extends Error {
  override readonly name = "KaadaError";
  readonly code: KaadaErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: KaadaErrorCode, message: string, options: KaadaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
  }
}

export function isKaadaError(error: unknown, code?: KaadaErrorCode): error is KaadaError {
  return error instanceof KaadaError && (code === undefined || error.code === code);
}
