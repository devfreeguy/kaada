"use client";
import { primaryAction, secondaryAction } from "../components/application/styles";

import type { useRecovery } from "./use-recovery";

export function RecoveryEmail({
  busy,
  emailCode,
  setEmailCode,
  verifyEmail,
  resend,
  status,
}: ReturnType<typeof useRecovery>) {
  const step = status?.nextStep;
  return (
    <>
      {step === "VERIFY_EMAIL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Check your email</h1>
          <p className="text-white/75">
            If that address belongs to a Kaada wallet, we sent a 6-digit code. It expires soon.
          </p>
          <input
            value={emailCode}
            onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Email code"
            className="rounded-lg border border-white/25 px-4 py-3 text-center font-mono text-xl tracking-widest"
          />
          <button
            type="button"
            disabled={busy || emailCode.length !== 6}
            onClick={() => void verifyEmail()}
            className={primaryAction}
          >
            Verify
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resend()}
            className={secondaryAction}
          >
            Send a new code
          </button>
        </section>
      )}
    </>
  );
}
