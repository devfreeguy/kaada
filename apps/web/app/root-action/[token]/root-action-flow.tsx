"use client";
import { primaryAction } from "../../components/application/styles";
import { useRootAction } from "./use-root-action";
const confirmLabel = (action: string) =>
  action === "ROOT_PASSKEY_REQUIRED" ? "Confirm with passkey" : "Confirm with this device";
export function RootActionFlow({ token }: { token: string }) {
  const { view, confirm, reload } = useRootAction({ token });
  return (
    <div className="flex flex-col gap-6">
      {view.name === "loading" && <p className="text-white/75">Loading...</p>}
      {view.name === "load-error" && (
        <section className="flex flex-col gap-4">
          <h1>Couldn’t load request</h1>
          <p role="alert" className="text-white/75">
            {view.message}
          </p>
          <button type="button" className={primaryAction} onClick={reload}>
            Try loading again
          </button>
        </section>
      )}
      {view.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link isn&apos;t valid</h1>
          <p className="text-white/75">
            It may have expired or already been used. Go back to your payment to get a new one.
          </p>
        </section>
      )}
      {view.name === "ready" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">{view.title}</h1>
          <p className="text-white/75">{view.message}</p>
          <button type="button" onClick={() => void confirm(view.action)} className={primaryAction}>
            {confirmLabel(view.action)}
          </button>
        </section>
      )}
      {view.name === "confirming" && (
        <p className="text-white/75">
          {view.action === "ROOT_PASSKEY_REQUIRED"
            ? "Waiting for your passkey..."
            : "Confirming with this device..."}
        </p>
      )}
      {view.name === "done" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">Wallet setup submitted</h1>
          <p className="text-white/75">
            Return to your payment page. It continues on its own once the setup is confirmed.
          </p>
        </section>
      )}
      {view.name === "error" && (
        <section className="flex flex-col gap-3">
          <p className="text-white/90">{view.message}</p>
          <button type="button" onClick={() => void confirm(view.action)} className={primaryAction}>
            Try again
          </button>
        </section>
      )}
    </div>
  );
}
