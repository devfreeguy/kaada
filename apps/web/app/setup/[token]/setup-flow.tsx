"use client";
import { primaryAction, secondaryAction } from "../../components/application/styles";
import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { shortenAddress } from "../../lib/display";
import { PinSetup } from "./pin-setup";
import { useSetup } from "./use-setup";
export function SetupFlow({ token }: { token: string }) {
  const {
    view,
    deviceKeysEnabled,
    funded,
    copied,
    balances,
    finish,
    createWithDevice,
    create,
    copy,
    reload,
  } = useSetup({ token });
  return (
    <div className="flex flex-col gap-6">
      {view.name === "loading" && <p className="text-white/75">Checking your link...</p>}
      {view.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link has expired</h1>
          <p className="text-white/75">
            For your security, setup links work once and only for a short time. Go back to your chat
            and ask Kaada for a new one.
          </p>
        </section>
      )}
      {(view.name === "ready" || view.name === "creating" || view.name === "error") && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Secure your wallet</h1>
          <p className="text-white/75">
            Choose how you will confirm payments. A passkey uses your fingerprint, face or screen
            lock. Or keep a key on this device and confirm with your PIN instead. Either works on
            any device, and you decide: you are never forced into one.
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
              void (view.name === "error" && view.retry === "load"
                ? reload()
                : view.name === "error" && view.retry === "finish"
                  ? finish()
                  : view.name === "error" && view.retry === "device"
                    ? createWithDevice()
                    : create())
            }
            className={primaryAction}
          >
            {view.name === "creating"
              ? "Waiting for your device..."
              : view.name === "error" && view.retry === "load"
                ? "Reload wallet"
                : view.name === "error" && view.retry === "finish"
                  ? "Finish setup"
                  : view.name === "error" && view.retry === "device"
                    ? "Try with this device"
                    : "Create Passkey"}
          </button>
          {deviceKeysEnabled && view.name !== "creating" && (
            <button
              type="button"
              onClick={() => void createWithDevice()}
              className={secondaryAction}
            >
              Use this device and my PIN instead
            </button>
          )}
          <p className="text-xs text-white/60">
            Your device keeps the passkey or key. Kaada never sees or stores it.
            {!deviceKeysEnabled && " Choosing a key on this device isn’t available right now."}
          </p>
        </section>
      )}
      {view.name === "finish" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Almost done</h1>
          <p className="text-white/75">
            Your credential is saved. One more step creates your wallet.
          </p>
          <button type="button" onClick={() => void finish()} className={primaryAction}>
            Finish setup
          </button>
        </section>
      )}
      {view.name === "done" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Wallet ready</h1>
          <p
            className="break-all rounded-lg bg-white/8 px-4 py-3 font-mono text-sm"
            title={view.address}
          >
            {shortenAddress(view.address)}
          </p>
          <p className="text-xs text-white/60">
            Send supported Celo stablecoins to this address to fund your wallet.
          </p>
          {balances.length > 0 && (
            <ul className="text-sm text-white/80">
              {balances.map((line) => (
                <li key={line.symbol}>
                  {line.formatted} {line.symbol}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void copy(view.address)}
              className={"flex-1 " + secondaryAction}
            >
              {copied ? "Copied" : "Copy Address"}
            </button>
            <button
              type="button"
              onClick={() => window.close()}
              className={"flex-1 " + primaryAction}
            >
              Done
            </button>
          </div>
          <p className="text-xs text-white/60">You can close this page and return to your chat.</p>
          <PinSetup token={token} />
          {funded && (
            <>
          <section className="flex flex-col gap-3 border-t border-white/15 pt-6">
            <h2 className="text-lg font-semibold">Secure your account</h2>
            <p className="text-sm text-white/75">
              Kaada never holds your keys, so nobody can restore your wallet for you. Finish these
              steps now, so you can always get back in if you lose your device.
            </p>
          </section>
          <RecoveryCodeCreator token={token} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
