"use client";
import { primaryAction } from "../components/application/styles";
import { RecoveryNeeds } from "../components/recovery-needs";
import type { useRecovery } from "./use-recovery";

export function RecoveryStart({
  session,
  busy,
  email,
  setEmail,
  start,
}: ReturnType<typeof useRecovery>) {
  return (
    <>
      {!session && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recover your wallet</h1>
          <p className="text-white/75">
            Lost your device or passkey? Enter the email linked to your Kaada account. You will need
            your Recovery Code and your authenticator app. For your safety, a recovery takes a few
            days and you are told by email when it starts.
          </p>
          <RecoveryNeeds />
          <label htmlFor="recovery-email" className="text-sm font-medium text-white/80">
            Email address
          </label>
          <input
            id="recovery-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email address"
            className="rounded-lg border border-white/25 px-4 py-3"
          />
          <button
            type="button"
            disabled={busy || email.length < 5}
            onClick={() => void start()}
            className={primaryAction}
          >
            {busy ? "Starting..." : "Start recovery"}
          </button>
        </section>
      )}
    </>
  );
}
