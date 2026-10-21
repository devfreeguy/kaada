/**
 * Finds WHY a bundler refused an operation in whatever shape the refusal arrives: the chain adapter's own details (`rpc`, `rpcCode`,
 * `aaCode`, `rpcData`), a nested `cause` chain, and the members viem and bundlers use (`shortMessage`, `reason`, `data`, `details`,
 * `error`). It reads text and numbers only, never an object wholesale, and everything it returns is safe for a log: long hex runs
 * (a signature, calldata) and URLs (a bundler URL carries its API key) are replaced before anything is kept.
 */
export interface BundlerReason {
  /** The class of the error that was thrown, so a refusal with no reason can still be told apart. */
  errorClass: string;
  /** The JSON-RPC error code, when one was found. */
  rpcCode?: number;
  /** The ERC-4337 AA code (AA21 prefund, AA24 signature, AA25 nonce, ...), when one was found anywhere in the text. */
  aaCode?: string;
  /** A short reason, redacted and capped; absent when nothing useful was found. */
  reason?: string;
  /** The bundler refused because the operation's fee is below its floor (the floor can rise between prepare and send). */
  feeTooLow: boolean;
}

const GENERIC = "the bundler refused the operation";
const MAX_DEPTH = 6;
// The error's own `message` comes LAST: for a wrapped error it is the generic words, while `details` and `data` carry the reason.
const TEXT_KEYS = [
  "details",
  "rpc",
  "rpcData",
  "shortMessage",
  "reason",
  "data",
  "cause",
  "error",
  "body",
  "message",
] as const;

export function redactForLog(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64,}/g, "0x[hex omitted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .slice(0, 200);
}

export function findBundlerReason(error: unknown): BundlerReason {
  const errorClass =
    error instanceof Error
      ? ((error.constructor as { name?: string }).name ?? error.name)
      : typeof error;
  const texts: string[] = [];
  let rpcCode: number | undefined;
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      if (value.length > 0 && value !== GENERIC) texts.push(value);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["rpcCode", "code"]) {
      if (rpcCode === undefined && typeof record[key] === "number") rpcCode = record[key];
    }
    for (const key of TEXT_KEYS) visit(record[key], depth + 1);
  };
  visit(error, 0);

  const all = texts.join(" ");
  const aaCode = /\bAA\d{2}\b/.exec(all)?.[0];
  const feeTooLow =
    /max(Priority)?FeePerGas must be at least|fee per gas (is )?too low|underpriced/i.test(all);
  const best = (aaCode && texts.find((t) => t.includes(aaCode))) || texts[0];
  return {
    errorClass,
    feeTooLow,
    ...(rpcCode !== undefined && { rpcCode }),
    ...(aaCode && { aaCode }),
    ...(best && { reason: redactForLog(best) }),
  };
}

/** Whether something is a BUNDLER_REJECTED by its code, whatever class it was thrown as. */
export function isBundlerRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "BUNDLER_REJECTED"
  );
}

/** The chain adapter could not read the bundler's fee floor: it never prices an operation without it. */
export function isFeeUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "RECOVERY_BLOCKED" &&
    (error as { details?: { reason?: unknown } }).details?.reason === "FEE_UNAVAILABLE"
  );
}

/** A refusal because the fee is below the bundler's floor, which can rise between the moment an operation is priced and sent. */
export function isFeeTooLow(error: unknown): boolean {
  return isBundlerRejection(error) && findBundlerReason(error).feeTooLow;
}
