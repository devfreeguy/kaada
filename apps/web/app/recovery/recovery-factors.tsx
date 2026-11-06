"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import { TextField } from "../components/application/text-field";
import type { useRecovery } from "./use-recovery";

export function RecoveryFactors({
  session,
  busy,
  recoveryCode,
  setRecoveryCode,
  authenticatorCode,
  setAuthenticatorCode,
  proveWithCode,
  forget,
  status,
}: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "PROVE_RECOVERY_FACTORS") return null;
  if (!session?.proposal) {
    return (
      <FlowSection
        title="Prove it’s you"
        description="This page was reloaded and lost its progress."
      >
        <ActionButton onClick={forget}>Start again</ActionButton>
      </FlowSection>
    );
  }
  return (
    <FlowSection
      title="Prove it’s you"
      description="Your Recovery Code is checked on this device and never sent to Kaada."
    >
      <TextField
        label="Recovery Code"
        value={recoveryCode}
        onChange={(event) => setRecoveryCode(event.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        mono
      />
      <TextField
        label="Authenticator code"
        value={authenticatorCode}
        onChange={(event) =>
          setAuthenticatorCode(event.target.value.replace(/\D/g, "").slice(0, 6))
        }
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        mono
      />
      <ActionButton
        busy={busy}
        busyLabel="Checking…"
        disabled={recoveryCode.length < 20 || authenticatorCode.length !== 6}
        onClick={() => void proveWithCode()}
      >
        Start recovery
      </ActionButton>
    </FlowSection>
  );
}
