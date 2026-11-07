"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import { TextField } from "../components/application/text-field";
import { RecoveryNeeds } from "../components/recovery-needs";
import type { useRecovery } from "./use-recovery";

export function RecoveryStart({
  session,
  busy,
  email,
  setEmail,
  start,
}: ReturnType<typeof useRecovery>) {
  if (session) return null;
  return (
    <FlowSection
      title="Recover your wallet"
      description="Enter the email linked to your account. A recovery takes a few days, and we email you when it starts."
    >
      <RecoveryNeeds />
      <TextField
        label="Email address"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder="you@example.com"
      />
      <ActionButton
        busy={busy}
        busyLabel="Sending…"
        disabled={email.length < 5}
        onClick={() => void start()}
      >
        Send code
      </ActionButton>
    </FlowSection>
  );
}
