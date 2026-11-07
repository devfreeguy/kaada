"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import { RECOVERY_PROOF } from "../lib/recovery-copy";
import type { useRecovery } from "./use-recovery";

export function RecoveryProof({
  busy,
  proveNewCredential,
  status,
}: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "PROVE_NEW_CREDENTIAL") return null;
  const copy = RECOVERY_PROOF[status.newRootKind ?? "DEVICE_KEY"];
  return (
    <FlowSection title={copy.title}>
      <ActionButton busy={busy} busyLabel="Confirming…" onClick={() => void proveNewCredential()}>
        {copy.action}
      </ActionButton>
    </FlowSection>
  );
}
