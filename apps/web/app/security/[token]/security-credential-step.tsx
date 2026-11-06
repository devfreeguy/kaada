"use client";
import { ActionButton } from "../../components/application/action-button";
import { CredentialUnavailable } from "../../components/application/credential-unavailable";
import { FlowSection } from "../../components/application/flow-section";
import { securityActions } from "./security-actions";
import { SecurityProgress } from "./security-progress";
import type { useSecurity } from "./use-security";
export function SecurityCredentialStep({
  action,
  controller,
}: {
  action: "rotate" | "backup";
  controller: ReturnType<typeof useSecurity>;
}) {
  const { progress, capabilities, change, busy } = controller;
  const copy = securityActions[action];
  const canEdit = progress.name === "idle" || progress.name === "error";
  return (
    <FlowSection title={copy.title} description={canEdit ? copy.intro : undefined}>
      <SecurityProgress {...controller} />
      {canEdit && (
        <>
          {capabilities.ready && !capabilities.passkey && !capabilities.deviceKey && (
            <CredentialUnavailable />
          )}
          {capabilities.passkey && (
            <ActionButton disabled={busy} onClick={() => void change(copy.kind, "PASSKEY")}>
              {action === "rotate" ? "Use a new passkey" : "Add a passkey"}
            </ActionButton>
          )}
          {capabilities.deviceKey && (
            <ActionButton
              variant="secondary"
              disabled={busy}
              onClick={() => void change(copy.kind, "DEVICE_KEY")}
            >
              {action === "rotate" ? "Use a key on this device" : "Add this device"}
            </ActionButton>
          )}
        </>
      )}
    </FlowSection>
  );
}
