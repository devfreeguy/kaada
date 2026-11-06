"use client";
import { ActionButton } from "../components/application/action-button";
import { CredentialUnavailable } from "../components/application/credential-unavailable";
import { FlowSection } from "../components/application/flow-section";
import type { useRecovery } from "./use-recovery";

export function RecoveryCredential({
  busy,
  createPasskey,
  createDeviceKey,
  capabilities,
  status,
}: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "CREATE_CREDENTIAL") return null;
  return (
    <FlowSection
      title="Set up this device"
      description="Choose how this device will protect your wallet from now on."
    >
      {capabilities.ready && !capabilities.passkey && !capabilities.deviceKey && (
        <CredentialUnavailable />
      )}
      {capabilities.passkey && (
        <ActionButton
          busy={busy}
          busyLabel="Waiting for your device…"
          onClick={() => void createPasskey()}
        >
          Create passkey
        </ActionButton>
      )}
      {capabilities.deviceKey && (
        <ActionButton variant="secondary" disabled={busy} onClick={() => void createDeviceKey()}>
          No passkey? Use a key on this device
        </ActionButton>
      )}
    </FlowSection>
  );
}
