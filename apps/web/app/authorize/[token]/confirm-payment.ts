import { failureCopy } from "../../lib/app-copy";
import type { RootChallenge, RootProof } from "../../lib/root-proof";
import { DeviceKeyMissingError } from "../../lib/root-proof";
import { toLock } from "./authorization-machine";
import type { Lock, Method } from "./authorization-machine";

/** What confirming a payment came to. Nothing here is a state of the screen: the machine decides what to show. */
export type ConfirmOutcome =
  | { type: "approved" }
  | { type: "failed"; notice: string; lock?: Lock | null }
  | { type: "invalid" }
  | { type: "blocked"; reason: "no-pin" | "reset" };

export interface ConfirmDeps {
  api(
    path: string,
    token: string,
    init?: { method?: "GET" | "POST"; body?: unknown },
  ): Promise<Response>;
  proveRoot(challenge: RootChallenge): Promise<RootProof>;
  /** The clock, for lock times. */
  now?: () => number;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Reads a rejected response into what to tell the person, using the server's code and never its wording. */
export function interpretRejection(
  status: number,
  body: Record<string, unknown>,
  now: number,
): ConfirmOutcome {
  const code = body["code"] as string | undefined;
  if (status === 401 && code === undefined) return { type: "invalid" };
  if (code === "PIN_NOT_SET") return { type: "blocked", reason: "no-pin" };
  if (code === "PIN_RESET_REQUIRED") return { type: "blocked", reason: "reset" };
  if (status === 423 || body["lockedUntil"]) {
    const until = typeof body["lockedUntil"] === "string" ? body["lockedUntil"] : null;
    return { type: "failed", notice: failureCopy.locked, lock: toLock(until, now) };
  }
  if (code === "INVALID_PIN") {
    const left = body["attemptsRemaining"];
    return {
      type: "failed",
      notice: failureCopy.wrongPin(
        typeof left === "number" && Number.isSafeInteger(left) ? left : undefined,
      ),
    };
  }
  if (status === 429) return { type: "failed", notice: failureCopy.rateLimited };
  if (code === "PIN_REQUIRED") return { type: "failed", notice: failureCopy.pinRequired };
  if (code === "INSUFFICIENT_BALANCE") {
    return { type: "failed", notice: failureCopy.insufficientBalance };
  }
  if (code === "GAS_FUNDING_REQUIRED") return { type: "failed", notice: failureCopy.gasFunding };
  if (code === "NOT_SENT") return { type: "failed", notice: failureCopy.notSent };
  return { type: "failed", notice: failureCopy.unknownResult };
}

/**
 * Confirms a payment the way its wallet requires: the PIN alone, a passkey, or this device's key with the PIN. Returns what it
 * came to and never touches the screen, so a late return can be ignored by whoever called it.
 */
export async function confirmPayment(
  deps: ConfirmDeps,
  input: { token: string; method: Method; pin: string },
): Promise<ConfirmOutcome> {
  const { token, method, pin } = input;
  const clock = () => (deps.now ?? Date.now)();
  try {
    if (method === "PIN") {
      const response = await deps.api("/authorization/authorize", token, {
        method: "POST",
        body: { pin },
      });
      return response.ok
        ? { type: "approved" }
        : interpretRejection(response.status, await readBody(response), clock());
    }
    // The wallet's own root signs the payment itself. The server fixes what is signed; this page only shows the prompt.
    const options = await deps.api("/authorization/root/options", token, { method: "POST" });
    if (!options.ok) return interpretRejection(options.status, await readBody(options), clock());
    const { challenge, operation } = (await options.json()) as {
      challenge: RootChallenge;
      operation: string;
    };
    const proof = await deps.proveRoot(challenge);
    const response = await deps.api("/authorization/root/confirm", token, {
      method: "POST",
      body: { operation, proof, ...(method === "DEVICE_KEY" && { pin }) },
    });
    return response.ok
      ? { type: "approved" }
      : interpretRejection(response.status, await readBody(response), clock());
  } catch (error) {
    if (error instanceof DeviceKeyMissingError) {
      return { type: "failed", notice: failureCopy.deviceKeyMissing };
    }
    // Cancelling the prompt is the person's choice, and certain: nothing was submitted.
    if (error instanceof Error && error.name === "NotAllowedError") {
      return { type: "failed", notice: failureCopy.cancelledPayment };
    }
    return { type: "failed", notice: failureCopy.unknownResult };
  }
}
