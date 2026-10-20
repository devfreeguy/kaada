"use client";
import { CredentialUnavailable } from "../../components/application/credential-unavailable";
import { primaryAction, secondaryAction } from "../../components/application/styles";
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
    <section className="flex flex-col gap-4">
      <h1>{copy.title}</h1>
      {canEdit && <p className="text-white/75">{copy.intro}</p>}
      <SecurityProgress {...controller} />
      {canEdit && (
        <>
          {capabilities.ready && !capabilities.passkey && !capabilities.deviceKey && (
            <CredentialUnavailable />
          )}
          {capabilities.passkey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(copy.kind, "PASSKEY")}
              className={primaryAction}
            >
              {action === "rotate" ? "Switch to a new passkey" : "Add a passkey"}
            </button>
          )}
          {capabilities.deviceKey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(copy.kind, "DEVICE_KEY")}
              className={secondaryAction}
            >
              {action === "rotate"
                ? "Switch to a key on this device"
                : "Add this device as a backup"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
