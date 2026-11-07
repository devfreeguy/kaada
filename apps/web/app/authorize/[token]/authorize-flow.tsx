"use client";
import { ActionLink } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { StatusNote } from "../../components/application/status-note";
import { VerificationStep } from "../../components/application/verification-step";
import { PinKeypad } from "../../components/pin-keypad";
import {
  blockedCopy,
  failureCopy,
  recoverCopy,
  verifyContextOf,
  verifyCopy,
} from "../../lib/app-copy";
import type { VerifyMethod } from "../../lib/app-copy";
import type { Method } from "./authorization-machine";
import { PaymentDone } from "./final-pricing";
import { PaymentSummary } from "./payment-summary";
import { useAuthorization } from "./use-authorization";

const VERIFY_METHOD: Record<Method, VerifyMethod> = {
  PASSKEY: "passkey",
  DEVICE_KEY: "device",
  PIN: "pin",
};

const RECOVERY_HINT: Record<Exclude<Method, "PIN">, string> = {
  PASSKEY: recoverCopy.passkey,
  DEVICE_KEY: recoverCopy.device,
};

export function AuthorizeFlow({ token }: { token: string }) {
  const controller = useAuthorization({ token });
  return <AuthorizeScreen token={token} {...controller} />;
}

/** What the person sees for each state of the approval. Pure: the same state always draws the same screen. */
export function AuthorizeScreen({
  token,
  state,
  pin,
  setPin,
  submit,
  reload,
}: { token: string } & ReturnType<typeof useAuthorization>) {
  switch (state.name) {
    case "loading":
      return <FlowStatus kind="loading" subject="payment" />;
    case "invalid":
      return <FlowStatus kind="unavailable" subject="payment" />;
    case "load-error":
      return (
        <FlowStatus kind="load-failed" subject="payment" message={state.message} onRetry={reload} />
      );
    case "blocked":
      return state.reason === "no-pin" ? (
        <FlowSection title={blockedCopy.noPin.title} description={blockedCopy.noPin.body} />
      ) : (
        <FlowSection title={blockedCopy.reset.title} description={blockedCopy.reset.body}>
          <ActionLink href="/recovery">{blockedCopy.reset.action}</ActionLink>
        </FlowSection>
      );
    case "done":
      return <PaymentDone token={token} operation={state.operation} method={state.method} />;
    case "ready":
    case "submitting": {
      const submitting = state.name === "submitting";
      const method = state.method;
      const operation = state.view.operation;
      const context = verifyContextOf(operation);
      const lock = state.name === "ready" ? state.lock : null;
      const notice = state.name === "ready" ? state.notice : null;
      const recovery =
        method === "PIN" ? null : (
          <p className="text-sm text-app-muted">
            {RECOVERY_HINT[method]}{" "}
            <a href="/recovery" className="text-app-text underline underline-offset-4">
              {recoverCopy.link}
            </a>
          </p>
        );
      return (
        <VerificationStep
          context={context}
          method={VERIFY_METHOD[method]}
          waiting={submitting}
          notice={lock ? undefined : notice}
          summary={
            <>
              <PaymentSummary summary={state.view.summary} operation={operation} />
              {lock ? (
                <StatusNote tone="warning">{failureCopy.lockedFor(lock.label)}</StatusNote>
              ) : null}
            </>
          }
          onConfirm={() => void submit()}
          actionHidden={lock !== null}
          footer={recovery}
        >
          {method === "PASSKEY" ? undefined : (
            <PinKeypad
              value={pin}
              onChange={setPin}
              onSubmit={() => void submit()}
              disabled={submitting}
              submitLabel={verifyCopy(context, VERIFY_METHOD[method]).action}
            />
          )}
        </VerificationStep>
      );
    }
  }
}
