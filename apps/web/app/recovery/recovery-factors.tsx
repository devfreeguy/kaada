"use client";
import { primaryAction } from "../components/application/styles";

import type { useRecovery } from "./use-recovery";

export function RecoveryFactors({
  session,
  busy,
  recoveryCode,
  setRecoveryCode,
  authenticatorCode,
  setAuthenticatorCode,
  proveWithCode,
  forget,
  status,
}: ReturnType<typeof useRecovery>) {
  const step = status?.nextStep;
  return (
    <>
      {step === "PROVE_RECOVERY_FACTORS" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Prove it is you</h1>
          {!session?.proposal ? (
            <>
              <p className="text-white/75">
                This page lost its progress (it was reloaded). Start again to continue.
              </p>
              <button type="button" onClick={forget} className={primaryAction}>
                Start again
              </button>
            </>
          ) : (
            <>
              <p className="text-white/75">
                Your Recovery Code is checked on this device and never sent to Kaada. It authorises
                this one recovery. Then enter the 6-digit code from your authenticator app.
              </p>
              <input
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label="Recovery Code"
                className="rounded-lg border border-white/25 px-4 py-3 font-mono"
              />
              <input
                value={authenticatorCode}
                onChange={(event) =>
                  setAuthenticatorCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="6-digit code from your authenticator app"
                placeholder="000000"
                className="rounded-lg border border-white/25 px-4 py-3 font-mono tracking-widest"
              />
              <button
                type="button"
                disabled={busy || recoveryCode.length < 20 || authenticatorCode.length !== 6}
                onClick={() => void proveWithCode()}
                className={primaryAction}
              >
                {busy ? "Checking..." : "Start the recovery"}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}
