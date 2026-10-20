"use client";
import { primaryAction, secondaryAction } from "../../components/application/styles";
import type { useSetup } from "./use-setup";

type Props = Pick<
  ReturnType<typeof useSetup>,
  "view" | "deviceKeysEnabled" | "createWithDevice" | "create"
>;
export function SetupCredentialStep({ view, deviceKeysEnabled, createWithDevice, create }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Secure your wallet</h1>
      <p className="text-white/75">
        A passkey secures your account using your fingerprint, face or screen lock.
        {deviceKeysEnabled &&
          " You can also keep a key on this device and confirm payments with your PIN instead."}
      </p>
      {view.name === "error" && (
        <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
          {view.message}
        </p>
      )}
      <button
        type="button"
        disabled={view.name === "creating"}
        onClick={() =>
          void (view.name === "error" && view.retry === "device" ? createWithDevice() : create())
        }
        className={primaryAction}
      >
        {view.name === "creating"
          ? "Waiting for your device..."
          : view.name === "error" && view.retry === "device"
            ? "Try with this device"
            : "Create Passkey"}
      </button>
      {deviceKeysEnabled && view.name !== "creating" && (
        <button type="button" onClick={() => void createWithDevice()} className={secondaryAction}>
          Use this device and my PIN instead
        </button>
      )}
      <p className="text-xs text-white/60">
        Your device keeps the passkey or key. Kaada never sees or stores it.
      </p>
    </section>
  );
}
