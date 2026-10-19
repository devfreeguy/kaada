import {
  EXECUTION_AUDIT_EVENTS,
  KaadaError,
  createId,
  isNativeCelo,
  isWalletActive,
} from "@kaada/domain";
import type {
  AccountCall,
  Asset,
  AuthorizationSession,
  KernelExecutionPort,
  RootChallenge,
  RootCredential,
  RootProof,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { errorDetails } from "../channels/error-details.js";
import type {
  PaymentAuthorizationService,
  PinRejection,
} from "../authorization/payment-authorization-service.js";
import type { RootAdapters, RootCredentialService } from "../roots/root-credentials.js";
import type { ExecutionPreparationService } from "./preparation-service.js";
import type { ExecutionUnitOfWork, SecretCipher } from "./ports.js";
import { encodeTransfer, stepKey } from "./steps.js";
import { isDirectTransferRoute, isTransferRecord } from "./transfer.js";

/** How long a person has between seeing the prompt and answering it. The operation they sign is fixed for this long. */
export const ROOT_PAYMENT_TTL_MS = 5 * 60 * 1000;

export interface RootPaymentDeps {
  payments: Pick<PaymentAuthorizationService, "inspect" | "verifyPin" | "authorizeVerified">;
  preparation: Pick<ExecutionPreparationService, "prepare">;
  unitOfWork: ExecutionUnitOfWork;
  kernel: KernelExecutionPort;
  roots: RootCredentialService;
  adapters: RootAdapters;
  cipher: SecretCipher;
  chain: {
    balances: { balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> };
  };
  /** The least native CELO (wei) the account needs for the network fee. */
  minNativeWei: bigint;
  /** The chain id the root validators run on: what a signed payload is bound to. */
  onChainId: number;
  log?: AgentLog;
  now?: () => Date;
}

/**
 * How a payment page should ask the person to confirm: with their own root (a passkey, one prompt, no PIN), or with the PIN.
 * `pinRequired` is for a root that cannot tell a person from a device (a device key): the PIN is asked FIRST and the device key then
 * signs in the background, still one step for the person.
 */
export type ConfirmationMethod =
  { method: "PIN" } | { method: "ROOT"; rootType: RootCredential["type"]; pinRequired: boolean };

export type RootPaymentBegin =
  | {
      status: "READY";
      challenge: RootChallenge;
      operation: string;
      rootType: RootCredential["type"];
    }
  | { status: "NOT_AVAILABLE" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "GAS_FUNDING_REQUIRED" };

export type RootPaymentConfirm =
  | { status: "SENT"; executionId: string }
  | { status: "PIN_REQUIRED" }
  | PinRejection
  | { status: "NOT_AVAILABLE" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "GAS_FUNDING_REQUIRED" }
  | { status: "NOT_SENT"; code: string };

/** What the person is about to sign, as the server worked it out from storage. Never from the browser. */
interface Eligible {
  session: AuthorizationSession;
  walletId: string;
  walletAddress: string;
  userId: string;
  asset: Asset & { contractAddress: string };
  recipient: string;
  amount: string;
  routeId: string;
  intentRevision: number;
  calls: AccountCall[];
  root: RootCredential;
}

/** The sealed hand-off between "show the prompt" and "here is the answer". Opaque to the browser and bound to one session. */
interface Sealed {
  v: 1;
  sessionId: string;
  walletId: string;
  routeId: string;
  intentRevision: number;
  rootType: RootCredential["type"];
  challenge: string;
  calls: AccountCall[];
  prepared: Record<string, unknown>;
  expiresAt: number;
}

const invalid = () =>
  new KaadaError("AUTHORIZATION_SESSION_INVALID", "this authorization link is not valid");

/**
 * Confirming a DIRECT transfer with the wallet's own root instead of a PIN and a permission.
 *
 * The person's passkey (or device key) signs the transfer itself: one UserOperation that creates the account when it does not exist yet
 * and sends `transfer(recipient, amount)`. Nothing is installed on chain for Kaada's server key, so the server can never move these
 * funds on its own: every payment is confirmed by the person, once.
 *
 *  1. `begin` works out the operation from STORAGE (never from the browser), prepares it, and hands back the prompt and a sealed copy.
 *  2. `confirm` opens the seal, re-checks the payment is still exactly that, checks the root's proof over the operation's hash, and
 *     only then records the approval, takes execution rights (consuming it) and sends the operation the person signed.
 *
 * The runner then follows the payment to its end exactly like any other direct transfer.
 */
export class RootPaymentService {
  private readonly uow: ExecutionUnitOfWork;
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: RootPaymentDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  /** Which way this payment is confirmed. Falls back to the PIN whenever the root cannot sign this payment. */
  async method(token: string): Promise<ConfirmationMethod> {
    const found = await this.eligible(token);
    if (!found) return { method: "PIN" };
    return {
      method: "ROOT",
      rootType: found.root.type,
      pinRequired: found.root.type !== "PASSKEY",
    };
  }

  async begin(token: string): Promise<RootPaymentBegin> {
    const found = await this.eligible(token);
    if (!found) return { status: "NOT_AVAILABLE" };
    const short = await this.shortfall(found);
    if (short) return { status: short };

    let prepared;
    try {
      prepared = await this.deps.kernel.prepareRootOperation({
        walletAddress: found.walletAddress,
        credential: found.root,
        calls: found.calls,
      });
    } catch (error) {
      if (isPrefundError(error)) return { status: "GAS_FUNDING_REQUIRED" };
      throw error;
    }

    const sealed: Sealed = {
      v: 1,
      sessionId: found.session.id,
      walletId: found.walletId,
      routeId: found.routeId,
      intentRevision: found.intentRevision,
      rootType: found.root.type,
      challenge: prepared.challenge.toLowerCase(),
      calls: found.calls,
      prepared: prepared.prepared,
      expiresAt: this.now().getTime() + ROOT_PAYMENT_TTL_MS,
    };
    const operation = this.deps.cipher.encrypt(
      JSON.stringify(sealed),
      `root-payment:${found.session.id}`,
    ).ciphertext;
    const challenge = this.deps.adapters.prepareOperationChallenge(
      found.root,
      { account: found.walletAddress, chainId: this.deps.onChainId },
      prepared.challenge,
    );
    return { status: "READY", challenge, operation, rootType: found.root.type };
  }

  async confirm(
    token: string,
    input: { operation: string; proof: RootProof; pin?: string | undefined },
  ): Promise<RootPaymentConfirm> {
    const found = await this.eligible(token);
    if (!found) return { status: "NOT_AVAILABLE" };

    const sealed = this.open(found, input.operation);
    // The operation the person was shown must still be exactly this payment, byte for byte.
    if (JSON.stringify(sealed.calls) !== JSON.stringify(found.calls)) throw invalid();

    // A root that cannot tell a person from a device (a device key) is paired with the PIN, asked first.
    if (found.root.type !== "PASSKEY") {
      if (!input.pin) return { status: "PIN_REQUIRED" };
      const rejected = await this.deps.payments.verifyPin(found.session, input.pin);
      if (rejected) return rejected;
    }

    // The proof must be this root's signature over THIS operation's hash.
    await this.deps.adapters.verifyOperationProof(
      found.root,
      { account: found.walletAddress, chainId: this.deps.onChainId },
      sealed.challenge,
      input.proof,
    );

    const short = await this.shortfall(found);
    if (short) return { status: short };

    const authorization = await this.deps.payments.authorizeVerified(found.session);
    const prepared = await this.deps.preparation.prepare(authorization.id);
    if (prepared.status !== "EXECUTION_READY") {
      this.log("warn", "root_payment.not_ready", {
        authorizationId: authorization.id,
        status: prepared.status,
      });
      return { status: "NOT_SENT", code: prepared.status };
    }
    const repositories = this.uow.read;
    const record = await repositories.executionPlans.findById(prepared.executionId);
    if (!record || !isTransferRecord(record) || record.status !== "READY") {
      return { status: "NOT_SENT", code: "EXECUTION_NOT_READY" };
    }

    // Take execution rights: this consumes the approval in the same atomic step, exactly as for every other payment.
    const acquired = await this.uow.transaction((tx) =>
      tx.executionPlans.acquire(record.id, this.now()),
    );
    if (acquired.status !== "ACQUIRED") return { status: "NOT_SENT", code: acquired.status };
    await this.audit(found, record.id, EXECUTION_AUDIT_EVENTS.acquired, {
      authorizationId: authorization.id,
      signer: "ROOT",
    });

    // The step is written BEFORE it is sent, with the hash the root signed, so a crash leaves something to look up.
    const { transaction, created } = await repositories.executionTransactions.begin({
      idempotencyKey: stepKey(record.id, "TRANSFER"),
      executionId: record.id,
      type: "TRANSFER",
      chainId: found.asset.chainId ?? 42220,
      fromAddress: found.walletAddress,
      toAddress: found.recipient,
      assetId: found.asset.id,
      amount: found.amount,
      metadata: { step: "TRANSFER", signer: "ROOT" },
    });
    if (!created || transaction.status !== "CREATED") {
      return { status: "NOT_SENT", code: "STEP_IN_FLIGHT" };
    }
    await repositories.executionTransactions.recordUserOpHash(transaction.id, sealed.challenge);
    await repositories.executionPlans.transition(record.id, ["SIGNING"], "SUBMITTING");

    try {
      const sent = await this.deps.kernel.sendRootOperation({
        prepared: sealed.prepared as never,
        proof: input.proof,
      });
      await repositories.executionTransactions.markSubmitted(transaction.id, {
        userOpHash: sent.userOpHash.toLowerCase(),
        now: this.now(),
      });
      await repositories.executionPlans.transition(record.id, ["SUBMITTING"], "SUBMITTED");
      await this.audit(found, record.id, EXECUTION_AUDIT_EVENTS.stepSent, { step: "TRANSFER" });
      return { status: "SENT", executionId: record.id };
    } catch (error) {
      if (error instanceof KaadaError && error.code === "BUNDLER_REJECTED") {
        // Refused before it went anywhere: nothing moved.
        await repositories.executionTransactions.markNotSent(
          transaction.id,
          "BUNDLER_REJECTED",
          this.now(),
        );
        await repositories.executionPlans.transition(record.id, ["SUBMITTING"], "FAILED", {
          failureCode: isPrefundError(error) ? "GAS_FUNDING_REQUIRED" : "BUNDLER_REJECTED",
        });
        this.log("warn", "root_payment.rejected", {
          executionId: record.id,
          ...errorDetails(error),
        });
        return isPrefundError(error)
          ? { status: "GAS_FUNDING_REQUIRED" }
          : { status: "NOT_SENT", code: "BUNDLER_REJECTED" };
      }
      // It may have reached the bundler: never resent, followed until the chain says what happened.
      await repositories.executionTransactions.markUnknown(transaction.id, this.now());
      this.log("error", "root_payment.send_unknown", {
        executionId: record.id,
        ...errorDetails(error),
      });
      return { status: "SENT", executionId: record.id };
    }
  }

  /** Everything the person is about to sign, from storage. Undefined when this payment cannot be confirmed with the root. */
  private async eligible(token: string): Promise<Eligible | undefined> {
    const { session, route, wallet, recipientAddress } = await this.deps.payments.inspect(token);
    if (!isDirectTransferRoute(route) || !recipientAddress || !wallet.address) return undefined;
    if (!isWalletActive(wallet)) return undefined;
    if (
      route.input.assetId !== route.output.assetId ||
      route.input.amount !== route.output.amount
    ) {
      return undefined;
    }
    const asset = await this.uow.read.assets.findById(route.input.assetId);
    if (!asset?.contractAddress) return undefined;

    let root: RootCredential;
    try {
      root = await this.deps.roots.activeRoot(wallet);
    } catch (error) {
      // No root on record: the PIN path (and its wallet setup) still works.
      this.log("info", "root_payment.no_root", { walletId: wallet.id, ...errorDetails(error) });
      return undefined;
    }
    const amount = route.input.amount;
    return {
      session,
      walletId: wallet.id,
      walletAddress: wallet.address,
      userId: wallet.userId,
      asset: asset as Asset & { contractAddress: string },
      recipient: recipientAddress,
      amount,
      routeId: route.id,
      intentRevision: session.intentRevision,
      calls: [
        {
          to: asset.contractAddress.toLowerCase(),
          data: encodeTransfer(recipientAddress, BigInt(amount)),
          value: "0",
        },
      ],
      root,
    };
  }

  /** Not enough of the token, or not enough CELO left over for the network fee (CELO is also the coin that pays it). */
  private async shortfall(
    found: Eligible,
  ): Promise<"INSUFFICIENT_BALANCE" | "GAS_FUNDING_REQUIRED" | undefined> {
    const celoSent = isNativeCelo(found.asset) ? BigInt(found.amount) : 0n;
    const native = await this.deps.kernel.nativeBalance(found.walletAddress);
    if (native < this.deps.minNativeWei + celoSent) {
      return celoSent > 0n ? "INSUFFICIENT_BALANCE" : "GAS_FUNDING_REQUIRED";
    }
    const held = await this.deps.chain.balances.balancesOf(found.walletAddress, [found.asset.id]);
    if ((held.get(found.asset.id) ?? 0n) < BigInt(found.amount)) return "INSUFFICIENT_BALANCE";
    return undefined;
  }

  /** Opens the seal made by `begin`: only this server can have made it, and only for this session, wallet, route and root. */
  private open(found: Eligible, operation: string): Sealed {
    let sealed: Sealed;
    try {
      sealed = JSON.parse(
        this.deps.cipher.decrypt(operation, `root-payment:${found.session.id}`),
      ) as Sealed;
    } catch {
      throw invalid();
    }
    if (
      sealed.v !== 1 ||
      sealed.sessionId !== found.session.id ||
      sealed.walletId !== found.walletId ||
      sealed.routeId !== found.routeId ||
      sealed.intentRevision !== found.intentRevision ||
      sealed.rootType !== found.root.type ||
      sealed.expiresAt <= this.now().getTime()
    ) {
      throw invalid();
    }
    return sealed;
  }

  private async audit(
    found: Eligible,
    executionId: string,
    type: string,
    data: Record<string, string> = {},
  ): Promise<void> {
    // The trail records what happened; it must never decide what happens.
    try {
      await this.uow.read.audit.append({
        id: createId(),
        userId: found.userId,
        executionId,
        type,
        entityType: "execution",
        entityId: executionId,
        data,
      });
    } catch (error) {
      this.log("error", "execution.audit_write_failed", {
        executionId,
        type,
        ...errorDetails(error),
      });
    }
  }
}

/** "The account cannot pay the prefund" is a funding problem to say plainly, not a failure. */
function isPrefundError(error: unknown): boolean {
  return (
    error instanceof KaadaError &&
    error.code === "BUNDLER_REJECTED" &&
    /AA21|prefund/i.test(typeof error.details?.["rpc"] === "string" ? error.details["rpc"] : "")
  );
}
