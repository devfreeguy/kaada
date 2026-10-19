"use client";
import { groupSecret } from "../lib/recovery-copy";
import { primaryAction } from "./application/styles";
import { QrCode } from "./qr-code";
import { useAuthenticator } from "./use-authenticator";
const button = primaryAction;

export function AuthenticatorEnroller({ token, onDone }: { token: string; onDone: () => void }) {
  const { step, code, setCode, setStep, begin, confirm, confirming } = useAuthenticator({
    token,
    onDone,
  });
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Authenticator app</h2>
      {step.name === "intro" && (
        <>
          <p className="text-sm text-white/75">
            First, link an authenticator app (Google Authenticator, Microsoft Authenticator, Authy,
            1Password or similar). It gives you a 6-digit code that changes every 30 seconds, and
            you will need it, together with your Recovery Code, to recover your wallet.
          </p>
          <button type="button" onClick={() => void begin()} className={button}>
            Set up my authenticator app
          </button>
        </>
      )}
      {step.name === "working" && <p className="text-sm text-white/75">Working...</p>}
      {step.name === "scan" && (
        <>
          <p className="text-sm text-white/75">
            Scan this with your authenticator app, or type the key into it. We show it only once.
          </p>
          <QrCode value={step.uri} label="QR code for your authenticator app" />
          <p
            aria-label="Setup key"
            className="rounded-lg bg-white/8 px-4 py-3 text-center font-mono text-sm tracking-wide select-all"
          >
            {groupSecret(step.secret)}
          </p>
          <label className="flex flex-col gap-2 text-sm text-white/75">
            Now type the 6-digit code your app shows
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit code from your authenticator app"
              className="rounded-lg border border-white/25 px-4 py-3 font-mono text-lg tracking-widest"
            />
          </label>
          {step.wrong && (
            <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
              That code didn&apos;t work. Wait for the next one in your app and try again.
            </p>
          )}
          <button
            type="button"
            disabled={confirming || code.length !== 6}
            onClick={() => void confirm(step)}
            className={button}
          >
            {confirming ? "Checking…" : "Confirm the code"}
          </button>
        </>
      )}
      {step.name === "done" && (
        <p className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
          Your authenticator app is linked.
        </p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
            {step.message}
          </p>
          <button type="button" onClick={() => setStep({ name: "intro" })} className={button}>
            Start again
          </button>
        </>
      )}
    </section>
  );
}
