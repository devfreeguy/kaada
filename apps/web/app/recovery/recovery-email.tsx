"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import { EMAIL_CODE_MINUTES } from "../lib/recovery-copy";
import { TextField } from "../components/application/text-field";
import type { useRecovery } from "./use-recovery";

export function RecoveryEmail({
  busy,
  emailCode,
  setEmailCode,
  verifyEmail,
  resend,
  status,
}: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "VERIFY_EMAIL") return null;
  return (
    <FlowSection
      title="Check your email"
      description={`If that address belongs to a Kaada wallet, we sent a 6-digit code. It expires in ${String(EMAIL_CODE_MINUTES)} minutes.`}
    >
      <TextField
        label="6-digit code"
        value={emailCode}
        onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        mono
        center
      />
      <ActionButton
        busy={busy}
        busyLabel="Checking…"
        disabled={emailCode.length !== 6}
        onClick={() => void verifyEmail()}
      >
        Verify email
      </ActionButton>
      <ActionButton variant="quiet" disabled={busy} onClick={() => void resend()}>
        Send a new code
      </ActionButton>
    </FlowSection>
  );
}
