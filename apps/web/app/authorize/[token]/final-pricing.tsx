"use client";
import { ActionLink } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { paymentProgressCopy, rootContextOf, verifyCopy } from "../../lib/app-copy";
import type { Operation } from "../../lib/app-copy";
import type { Method } from "./authorization-machine";
import type { Outcome } from "./follow-payment";
import { usePaymentProgress } from "./use-payment-progress";

/**
 * What the person sees once their authorization is accepted. Everything here comes from the server's state for the payment
 * (see paymentProgressCopy): accepting a PIN or a passkey is not the payment's outcome, so the heading follows the payment, and
 * the extra security check a payment can need is offered as part of it, named by the signer the wallet needs.
 */
export function PaymentProgressView({
  operation,
  method,
  outcome,
  alreadyRunning,
  setupUrl,
}: {
  operation: Operation;
  method: Method;
  outcome: Outcome | null;
  alreadyRunning: boolean;
  setupUrl: string | null;
}) {
  const copy = paymentProgressCopy(operation, method, outcome ?? {}, { alreadyRunning });
  const signer =
    outcome?.state === "ROOT_ACTION_REQUIRED"
      ? outcome.action === "ROOT_PASSKEY_REQUIRED"
        ? "passkey"
        : outcome.action === "ROOT_DEVICE_KEY_REQUIRED"
          ? "device"
          : null
      : null;
  return (
    <FlowSection title={copy.title} {...(copy.description && { description: copy.description })}>
      {setupUrl && signer ? (
        <ActionLink href={setupUrl}>
          {verifyCopy(rootContextOf(operation), signer).action}
        </ActionLink>
      ) : null}
    </FlowSection>
  );
}

export function PaymentDone({
  token,
  operation,
  method,
}: {
  token: string;
  operation: Operation;
  method: Method;
}) {
  // A passkey or device key signs the payment itself, so it is already on its way; a PIN only authorizes it.
  const alreadyRunning = method !== "PIN";
  const { outcome, unavailable, setupUrl } = usePaymentProgress(token, alreadyRunning);
  // Execution is not enabled on this server: there is no payment state to report, only the proof that was accepted.
  const shown = unavailable ? { state: "UNAVAILABLE" } : outcome;
  return (
    <PaymentProgressView
      operation={operation}
      method={method}
      outcome={shown}
      alreadyRunning={alreadyRunning}
      setupUrl={setupUrl}
    />
  );
}
