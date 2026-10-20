import { createHash } from "node:crypto";

import { KaadaError, RECOVERY_AUDIT_EVENTS, createId } from "@kaada/domain";
import type {
  PasskeyVerifier,
  RecoveryAttempt,
  RecoveryAttemptStatus,
  RecoveryChainPort,
  RecoveryEmailSender,
  RecoveryRiskPolicy,
  Wallet,
  DepositItem,
  SponsorshipLedger,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { OPAQUE_TOKEN_PATTERN, hashOpaqueToken } from "../authorization/token.js";
import type { RecoveryNotifier } from "./notifier.js";
import type { RecoveryTotpService } from "./recovery-totp.js";
import type { RecoveryPolicy, RecoveryRepositories, RecoveryUnitOfWork } from "./ports.js";

/** Everything the recovery services share. */
export interface RecoveryContext {
  uow: RecoveryUnitOfWork;
  chain: RecoveryChainPort;
  /** The authenticator-app factor: checked here, off-chain, before a recovery may reach the chain. */
  totp: RecoveryTotpService;
  email: RecoveryEmailSender;
  notifier: RecoveryNotifier;
  risk: RecoveryRiskPolicy;
  policy: RecoveryPolicy;
  /** Verifies a passkey registration made on the NEW device (never stores it until the recovery completes). */
  passkeyVerifier: PasskeyVerifier;
  /**
   * What the platform may spend on one wallet so it can secure itself: opening its account and the gas of its first Recovery Code
   * setup. Absent (or a zero cap): nothing is spent and a wallet without native gas simply cannot arm.
   */
  sponsorship?: {
    /** The most native CELO (wei) spent on one wallet over its whole life. */
    perWalletWei: bigint;
    /** The most spent for sponsoring in any rolling 24 hours, across all wallets. Zero means sponsoring is off. */
    dailyBudgetWei: bigint;
    /** Sponsoring stops while the relayer holds less than this (wei). */
    relayerReserveWei: bigint;
    /** What a wallet must have received (millionths of a US dollar) to be sponsored at all. */
    minDepositUsdMicros: bigint;
    /** Every token amount recorded as received by the person's wallet. */
    depositItems: (userId: string) => Promise<DepositItem[]>;
    /** Where the caps are checked and spends recorded, atomically. */
    ledger: SponsorshipLedger;
  };
  rpId: string;
  origin: string;
  /** The web app origin used in notification links. */
  webUrl: string;
  /** Keys the email-code hash. At least 32 random bytes. */
  challengeSecret: Buffer;
  now: () => Date;
  log: AgentLog;
}

export type RecoveryNextStep =
  | "VERIFY_EMAIL"
  | "CREATE_CREDENTIAL"
  | "PROVE_RECOVERY_FACTORS"
  | "SUBMITTING"
  | "WAIT"
  | "WAITING_FOR_PAYMENT"
  | "FINALIZING"
  | "PROVE_NEW_CREDENTIAL"
  | "RESET_PIN"
  | "CREATE_RECOVERY_CODE"
  | "DONE"
  | "STOPPED"
  | "FAILED";

/** What a person (or the web page) is told about an attempt. No hashes, no secrets, no internals. */
export interface RecoveryStatusView {
  status: RecoveryAttemptStatus;
  nextStep: RecoveryNextStep;
  chainId: number;
  /** The Kernel wallet being recovered (shown only after the email was verified). */
  account?: string;
  /** The public verifier the Recovery Code must derive to (so the page can check a typed code before signing). */
  recoveryAddress?: string;
  newRootKind?: "PASSKEY" | "DEVICE_KEY";
  executeAfter?: string;
  blockedReason?: string;
  /** Post-recovery to-do list. */
  pinResetRequired?: boolean;
  recoveryCodeRequired?: boolean;
  /** After a recovery the authenticator app is retired too: a new one is set up with the new Recovery Code. */
  authenticatorRequired?: boolean;
  tokenExpiresAt: string;
}

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const isHash = (value: unknown, bytes = 32): value is string =>
  typeof value === "string" && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value);

/** A single message for every refusal that must not tell a caller anything: no oracle on tokens or accounts. */
export const invalidSession = () =>
  new KaadaError("RECOVERY_SESSION_INVALID", "this recovery link is not valid or has expired");

export function readToken(token: unknown): string {
  if (typeof token !== "string" || !OPAQUE_TOKEN_PATTERN.test(token)) throw invalidSession();
  return token;
}

/** The attempt behind a session token: unexpired and not in a dead state. */
export async function resolveAttempt(
  context: RecoveryContext,
  token: unknown,
  options: { allow?: RecoveryAttemptStatus[] } = {},
): Promise<RecoveryAttempt> {
  const attempt = await context.uow.read.recoveryAttempts.findByTokenHash(
    hashOpaqueToken(readToken(token)),
  );
  // A token of an attempt whose email was never verified is exactly as useless as a made-up one: otherwise status calls
  // would tell an outsider which emails belong to accounts.
  if (
    !attempt ||
    attempt.emailVerifiedAt === undefined ||
    attempt.tokenExpiresAt.getTime() <= context.now().getTime()
  ) {
    throw invalidSession();
  }
  if (options.allow && !options.allow.includes(attempt.status)) {
    throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now", {
      details: { status: attempt.status },
    });
  }
  return attempt;
}

export async function audit(
  repositories: Pick<RecoveryRepositories, "audit">,
  attempt: Pick<RecoveryAttempt, "id" | "userId">,
  type: string,
  data?: Record<string, string | number | boolean>,
): Promise<void> {
  await repositories.audit.append({
    id: createId(),
    userId: attempt.userId,
    type,
    entityType: "recovery_attempt",
    entityId: attempt.id,
    // Identifiers, statuses and reason codes only: never a token, a code, a signature or a key.
    ...(data && { data }),
  });
}

export function nextStepFor(attempt: RecoveryAttempt): RecoveryNextStep {
  switch (attempt.status) {
    case "EMAIL_PENDING":
      return "VERIFY_EMAIL";
    case "EMAIL_VERIFIED":
      return "CREATE_CREDENTIAL";
    case "ROOT_PROPOSED":
      return "PROVE_RECOVERY_FACTORS";
    case "INITIATING":
      return "SUBMITTING";
    case "PENDING":
      return attempt.blockedReason === "PAYMENT_IN_FLIGHT" ? "WAITING_FOR_PAYMENT" : "WAIT";
    case "FINALIZING":
      return "FINALIZING";
    case "ROOT_CHANGED":
      return "PROVE_NEW_CREDENTIAL";
    case "COMPLETED":
      if (!attempt.pinResetAt) return "RESET_PIN";
      if (!attempt.newConfigurationId) return "CREATE_RECOVERY_CODE";
      return "DONE";
    case "CANCELLED":
    case "EXPIRED":
      return "STOPPED";
    case "FAILED":
      return "FAILED";
  }
}

export function statusView(
  context: RecoveryContext,
  attempt: RecoveryAttempt,
  wallet: Wallet | null,
  recoveryAddress: string | undefined,
): RecoveryStatusView {
  const verified = attempt.emailVerifiedAt !== undefined;
  return {
    status: attempt.status,
    nextStep: nextStepFor(attempt),
    chainId: context.chain.chainId,
    ...(verified && wallet?.address && { account: wallet.address }),
    ...(verified && recoveryAddress && { recoveryAddress }),
    ...(attempt.newRootKind && { newRootKind: attempt.newRootKind }),
    ...(attempt.executeAfter && { executeAfter: attempt.executeAfter.toISOString() }),
    ...(attempt.blockedReason && { blockedReason: attempt.blockedReason }),
    ...(attempt.status === "COMPLETED" && {
      pinResetRequired: !attempt.pinResetAt,
      recoveryCodeRequired: !attempt.newConfigurationId,
      authenticatorRequired: !attempt.newConfigurationId,
    }),
    tokenExpiresAt: attempt.tokenExpiresAt.toISOString(),
  };
}

export { RECOVERY_AUDIT_EVENTS };
