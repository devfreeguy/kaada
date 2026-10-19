"use client";
import { CredentialUnavailable } from "../components/application/credential-unavailable";
import { primaryAction, secondaryAction } from "../components/application/styles";

import type { useRecovery } from "./use-recovery";

export function RecoveryCredential({
  busy,
  createPasskey,
  createDeviceKey,
  capabilities,
  status,
}: ReturnType<typeof useRecovery>) {
  const step = status?.nextStep;
  return (
    <>
      {step === "CREATE_CREDENTIAL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Set up this device</h1>
          <p className="text-white/75">
            Choose how this device will protect your wallet from now on.
          </p>
          {capabilities.ready && !capabilities.passkey && !capabilities.deviceKey && (
            <CredentialUnavailable />
          )}
          {capabilities.passkey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void createPasskey()}
              className={primaryAction}
            >
              {busy ? "Waiting for your device..." : "Create a new passkey"}
            </button>
          )}
          {capabilities.deviceKey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void createDeviceKey()}
              className={secondaryAction}
            >
              No passkey? Use a key kept by this device
            </button>
          )}
        </section>
      )}
    </>
  );
}
