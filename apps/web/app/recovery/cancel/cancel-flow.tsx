"use client";
import { primaryAction } from "../../components/application/styles";
import { useCancelRecovery } from "./use-cancel-recovery";
const button = primaryAction;
export function CancelFlow() {
  const { view, cancelWithRoot } = useCancelRecovery();
  return (
    <div className="flex flex-col gap-5">
      {view.name === "loading" && <p className="text-white/75">Loading...</p>}
      {view.name === "missing" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link isn&apos;t valid</h1>
          <p className="text-white/75">
            Open the link from the recovery email exactly as it was sent. Links work once.
          </p>
        </section>
      )}
      {(view.name === "ready" || view.name === "working" || view.name === "error") && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Stop a wallet recovery</h1>
          <p className="text-white/75">
            Someone asked to recover your Kaada wallet. If that was you, you don&apos;t need to do
            anything. If it was not you, stop it now from the device or passkey you normally use for
            your wallet.
          </p>
          {view.name === "error" && (
            <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
              {view.message}
            </p>
          )}
          <button
            type="button"
            disabled={view.name === "working"}
            onClick={() => void cancelWithRoot()}
            className={button}
          >
            {view.name === "working" ? "Confirm on your device..." : "This was not me. Stop it"}
          </button>
          <p className="text-xs text-white/60">
            Only your current device or passkey can stop a recovery, and stopping one never moves
            funds. If you no longer have it, a recovery needs your Recovery Code, your authenticator
            app and your email together, so keep those private.
          </p>
        </section>
      )}
      {view.name === "stopped" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">The recovery was stopped</h1>
          <p className="text-white/75">
            Your wallet is unchanged. You will get an email to confirm. If you did not ask for it,
            consider reviewing your email account.
          </p>
        </section>
      )}
    </div>
  );
}
