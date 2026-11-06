"use client";
import { ActionButton } from "../../components/application/action-button";
import { VerificationStep } from "../../components/application/verification-step";
import { verifyCopy } from "../../lib/app-copy";
import type { useSetup } from "./use-setup";

type Props = Pick<
  ReturnType<typeof useSetup>,
  "view" | "deviceKeysEnabled" | "createWithDevice" | "create"
>;

export function SetupCredentialStep({ view, deviceKeysEnabled, createWithDevice, create }: Props) {
  const creating = view.name === "creating";
  // After a failed passkey attempt that offered the device instead, the device becomes the main action.
  const deviceFirst = view.name === "error" && view.retry === "device";
  return (
    <VerificationStep
      context="wallet-setup"
      method={deviceFirst ? "device" : "passkey"}
      waiting={creating}
      notice={view.name === "error" ? view.message : undefined}
      onConfirm={() => void (deviceFirst ? createWithDevice() : create())}
      alternative={
        deviceKeysEnabled && !creating && !deviceFirst ? (
          <ActionButton variant="secondary" onClick={() => void createWithDevice()}>
            {verifyCopy("wallet-setup", "device").action}
          </ActionButton>
        ) : null
      }
      footer={<p className="text-xs text-app-faint">Kaada never sees your passkey or key.</p>}
    />
  );
}
