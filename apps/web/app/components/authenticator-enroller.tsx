"use client";
import { groupSecret } from "../lib/recovery-copy";
import { ActionButton } from "./application/action-button";
import { FlowSection } from "./application/flow-section";
import { StatusNote } from "./application/status-note";
import { TextField } from "./application/text-field";
import { QrCode } from "./qr-code";
import { useAuthenticator } from "./use-authenticator";

export function AuthenticatorEnroller({ token, onDone }: { token: string; onDone: () => void }) {
  const { step, code, setCode, setStep, begin, confirm, confirming } = useAuthenticator({
    token,
    onDone,
  });
  return (
    <FlowSection title="Authenticator app" as="h2">
      {step.name === "intro" && (
        <>
          <p className="text-sm text-app-muted">
            Link Google Authenticator, Authy, 1Password or similar. You’ll need its 6-digit code to
            recover your wallet.
          </p>
          <ActionButton onClick={() => void begin()}>Set up authenticator</ActionButton>
        </>
      )}
      {step.name === "working" && <StatusNote>Working…</StatusNote>}
      {step.name === "scan" && (
        <>
          <p className="text-sm text-app-muted">
            Scan this with your app, or type the key. It’s shown only once.
          </p>
          <QrCode value={step.uri} label="QR code for your authenticator app" />
          <p
            aria-label="Setup key"
            className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-center font-mono text-sm tracking-wide select-all"
          >
            {groupSecret(step.secret)}
          </p>
          <TextField
            label="6-digit code from your app"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            mono
            center
          />
          {step.wrong && (
            <StatusNote tone="danger">
              That code didn’t work. Wait for the next one and try again.
            </StatusNote>
          )}
          <ActionButton
            busy={confirming}
            busyLabel="Checking…"
            disabled={code.length !== 6}
            onClick={() => void confirm(step)}
          >
            Confirm code
          </ActionButton>
        </>
      )}
      {step.name === "done" && <StatusNote tone="success">Authenticator app linked.</StatusNote>}
      {step.name === "error" && (
        <>
          <StatusNote tone="danger">{step.message}</StatusNote>
          <ActionButton onClick={() => setStep({ name: "intro" })}>Start again</ActionButton>
        </>
      )}
    </FlowSection>
  );
}
