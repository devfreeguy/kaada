"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import type { useRecovery } from "./use-recovery";

export function RecoveryProof({
  busy,
  proveNewCredential,
  status,
}: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "PROVE_NEW_CREDENTIAL") return null;
  return (
    <FlowSection
      title="One quick check"
      description="Confirm that this device can sign for your wallet."
    >
      <ActionButton busy={busy} busyLabel="Confirming…" onClick={() => void proveNewCredential()}>
        Confirm with this device
      </ActionButton>
    </FlowSection>
  );
}
