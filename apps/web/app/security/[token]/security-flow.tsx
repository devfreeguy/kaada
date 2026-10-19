"use client";
import { CredentialUnavailable } from "../../components/application/credential-unavailable";
import { primaryAction, secondaryAction } from "../../components/application/styles";
import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { useSecurity } from "./use-security";
const button = primaryAction;
const secondary = secondaryAction;
const COPY: Record<
  "ROTATE_ROOT" | "ENROLL_BACKUP",
  { title: string; intro: string; done: string }
> = {
  ROTATE_ROOT: {
    title: "Change the passkey or device that controls your wallet",
    intro:
      "Move control to a new passkey or device key. Your current one confirms the change, and the old one stops working once it is done.",
    done: "Your wallet is now controlled by the new credential. The old one no longer works.",
  },
  ENROLL_BACKUP: {
    title: "Add a backup passkey or device",
    intro:
      "A backup can also control your wallet, so you are not locked out if you lose this device. Your current credential confirms adding it.",
    done: "Your backup is added. Both credentials can now control your wallet.",
  },
};
export function SecurityFlow({ token }: { token: string }) {
  const { progress, change, check, busy, capabilities } = useSecurity({ token });
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Wallet security</h1>
      {capabilities.ready && !capabilities.passkey && !capabilities.deviceKey && (
        <CredentialUnavailable />
      )}
      {progress.name === "error" && (
        <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
          {progress.message}
        </p>
      )}
      {progress.name === "pending" && (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-white/75">
            {progress.message}
          </p>
          <button
            type="button"
            className={secondaryAction}
            onClick={() => void check(progress.changeId)}
          >
            Check change status
          </button>
        </div>
      )}
      {progress.name === "working" && <p className="text-white/75">{progress.message}</p>}
      {progress.name === "confirmed" && (
        <p role="status" className="rounded-2xl bg-emerald/15 p-4 text-white">
          Your security change is confirmed.
        </p>
      )}
      {progress.name === "done" && (
        <p className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
          {COPY[progress.kind].done}
        </p>
      )}
      {(["ROTATE_ROOT", "ENROLL_BACKUP"] as const).map((kind) => (
        <section
          key={kind}
          className="flex flex-col gap-4 rounded-3xl border border-white/15 bg-white/5 p-5"
        >
          <h2 className="text-lg font-semibold">{COPY[kind].title}</h2>
          <p className="text-sm text-white/75">{COPY[kind].intro}</p>
          {capabilities.passkey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(kind, "PASSKEY")}
              className={button}
            >
              {kind === "ROTATE_ROOT" ? "Switch to a new passkey" : "Add a passkey"}
            </button>
          )}
          {capabilities.deviceKey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(kind, "DEVICE_KEY")}
              className={secondary}
            >
              {kind === "ROTATE_ROOT"
                ? "Switch to a key on this device"
                : "Add this device as a backup"}
            </button>
          )}
        </section>
      ))}
      <RecoveryCodeCreator token={token} />
    </div>
  );
}
