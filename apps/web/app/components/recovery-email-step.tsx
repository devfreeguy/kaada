"use client";
import { AppAlert } from "./application/app-alert";
import { primaryAction, secondaryAction } from "./application/styles";
import { useRecoveryEmail } from "./use-recovery-email";

export function RecoveryEmailStep({ token, onDone }: { token: string; onDone: () => void }) {
  const { step, email, setEmail, code, setCode, send, confirm, reload, setStep } = useRecoveryEmail(
    { token, onDone },
  );

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-semibold">1. Your recovery email</h3>
      {step.name === "loading" && <p className="text-sm text-white/75">Loading...</p>}
      {step.name === "done" && (
        <p role="status" className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
          Recovery email verified{step.masked ? `: ${step.masked}` : ""}.
        </p>
      )}
      {(step.name === "enter" || step.name === "sending" || step.name === "error") && (
        <>
          <p className="text-sm text-white/75">
            If you ever lose your device, recovery starts from this email. Use an address only you
            can open. We send a 6-digit code to check it.
          </p>
          {step.name === "error" && <AppAlert>{step.message}</AppAlert>}
          <label htmlFor="recovery-setup-email" className="text-sm font-medium text-white/80">
            Email address
          </label>
          <input
            id="recovery-setup-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            className="rounded-lg border border-white/25 px-4 py-3"
          />
          {step.name === "error" && step.retry === "load" ? (
            <button type="button" onClick={reload} className={secondaryAction}>
              Try again
            </button>
          ) : (
            <button
              type="button"
              disabled={step.name === "sending" || email.trim().length < 5}
              onClick={() => void send()}
              className={primaryAction}
            >
              {step.name === "sending" ? "Sending..." : "Send me a code"}
            </button>
          )}
        </>
      )}
      {(step.name === "code" || step.name === "checking") && (
        <>
          <p className="text-sm text-white/75">
            If that address can be used, a 6-digit code is on its way to {step.email}. It expires in
            10 minutes. Check your spam folder too.
          </p>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="6-digit code from your email"
            placeholder="000000"
            className="rounded-lg border border-white/25 px-4 py-3 text-center font-mono text-xl tracking-widest"
          />
          <button
            type="button"
            disabled={step.name === "checking" || code.length !== 6}
            onClick={() => void confirm(step.email)}
            className={primaryAction}
          >
            {step.name === "checking" ? "Checking..." : "Verify email"}
          </button>
          <button
            type="button"
            disabled={step.name === "checking"}
            onClick={() => setStep({ name: "enter" })}
            className={secondaryAction}
          >
            Use a different address
          </button>
        </>
      )}
    </div>
  );
}
