"use client";
import { EMAIL_CODE_MINUTES } from "../lib/recovery-copy";
import { ActionButton } from "./application/action-button";
import { FlowSection } from "./application/flow-section";
import { StatusNote } from "./application/status-note";
import { TextField } from "./application/text-field";
import { useRecoveryEmail } from "./use-recovery-email";

export function RecoveryEmailStep({ token, onDone }: { token: string; onDone: () => void }) {
  const { step, email, setEmail, code, setCode, send, confirm, reload, setStep } = useRecoveryEmail(
    { token, onDone },
  );

  return (
    <FlowSection title="Recovery email" as="h2">
      {step.name === "loading" && <StatusNote>Loading…</StatusNote>}
      {step.name === "done" && (
        <StatusNote tone="success">
          Email verified{step.masked ? `: ${step.masked}` : ""}.
        </StatusNote>
      )}
      {(step.name === "enter" || step.name === "sending" || step.name === "error") && (
        <>
          <p className="text-sm text-app-muted">
            Recovery starts from this address. Use one only you can open.
          </p>
          {step.name === "error" && <StatusNote tone="danger">{step.message}</StatusNote>}
          <TextField
            label="Email address"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
          />
          {step.name === "error" && step.retry === "load" ? (
            <ActionButton variant="secondary" onClick={reload}>
              Try again
            </ActionButton>
          ) : (
            <ActionButton
              busy={step.name === "sending"}
              busyLabel="Sending…"
              disabled={email.trim().length < 5}
              onClick={() => void send()}
            >
              Send code
            </ActionButton>
          )}
        </>
      )}
      {(step.name === "code" || step.name === "checking") && (
        <>
          <p className="text-sm text-app-muted">
            If that address can be used, we sent a 6-digit code to {step.email}. It expires in{" "}
            {EMAIL_CODE_MINUTES} minutes.
          </p>
          <TextField
            label="6-digit code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            mono
            center
          />
          <ActionButton
            busy={step.name === "checking"}
            busyLabel="Checking…"
            disabled={code.length !== 6}
            onClick={() => void confirm(step.email)}
          >
            Verify email
          </ActionButton>
          <ActionButton
            variant="quiet"
            disabled={step.name === "checking"}
            onClick={() => setStep({ name: "enter" })}
          >
            Use a different address
          </ActionButton>
        </>
      )}
    </FlowSection>
  );
}
