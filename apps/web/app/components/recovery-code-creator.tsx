"use client";
import { formatRecoveryCode, generateRecoveryCode, parseRecoveryCode } from "../lib/recovery-code";
import { primaryAction, secondaryAction } from "./application/styles";
import { AuthenticatorEnroller } from "./authenticator-enroller";
import { RecoveryEmailStep } from "./recovery-email-step";
import { RecoveryNeeds } from "./recovery-needs";
import { useRecoveryCode } from "./use-recovery-code";

export function RecoveryCodeCreator({ token, onDone }: { token: string; onDone?: () => void }) {
  const { step, typed, setTyped, setStep, arm, reload } = useRecoveryCode({ token, onDone });
  return (
    <section className="flex flex-col gap-4 border-t border-white/15 pt-6">
      <h2 className="text-lg font-semibold">Recovery setup</h2>
      {step.name === "loading" && <p className="text-sm text-white/75">Loading...</p>}
      {step.name === "email" && (
        <>
          <RecoveryNeeds />
          <RecoveryEmailStep token={token} onDone={reload} />
        </>
      )}
      {step.name === "authenticator" && (
        <>
          <RecoveryNeeds />
          <AuthenticatorEnroller token={token} onDone={() => setStep({ name: "intro" })} />
        </>
      )}
      {step.name === "intro" && (
        <>
          <RecoveryNeeds />
          <p className="text-sm text-white/75">
            Your Recovery Code is the second part. Kaada never sees it. Write it down and keep it
            somewhere safe, apart from your phone: with it, your authenticator app and your email,
            someone could start a recovery of your wallet.
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "show", code: generateRecoveryCode() })}
            className={primaryAction}
          >
            Create a new Recovery Code
          </button>
        </>
      )}
      {step.name === "show" && (
        <>
          <p className="text-sm text-white/75">
            Write this code down now. It is shown only once and cannot be recovered.
          </p>
          <p
            aria-label="Your Recovery Code"
            className="rounded-lg bg-white/8 px-4 py-4 text-center font-mono text-lg tracking-wide select-all"
          >
            {formatRecoveryCode(step.code)}
          </p>
          <button
            type="button"
            onClick={() => {
              setTyped("");
              setStep({ name: "confirm", code: step.code, mismatch: false });
            }}
            className={primaryAction}
          >
            I have written it down
          </button>
        </>
      )}
      {step.name === "confirm" && (
        <>
          <p className="text-sm text-white/75">Type the code back to make sure it is right.</p>
          <RecoveryNeeds />
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-label="Type your Recovery Code"
            className="rounded-lg border border-white/25 px-4 py-3 font-mono"
          />
          {step.mismatch && (
            <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
              That doesn&apos;t match. Check what you wrote and try again.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              if (parseRecoveryCode(typed) === step.code) {
                const code = step.code;
                setTyped("");
                void arm(code);
              } else {
                setStep({ ...step, mismatch: true });
              }
            }}
            className={primaryAction}
          >
            Confirm and save
          </button>
        </>
      )}
      {step.name === "arming" && (
        <p className="text-sm text-white/75">Confirm with your passkey or this device...</p>
      )}
      {step.name === "done" && (
        <p className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
          Recovery is set up. Keep your Recovery Code safe, and keep your authenticator app.
        </p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
            {step.message}
          </p>
          <button type="button" onClick={reload} className={secondaryAction}>
            Start again
          </button>
        </>
      )}
    </section>
  );
}
