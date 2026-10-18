"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { api, describeError, json } from "../lib/api";
import { RECOVERY_LOSS_WARNING, RECOVERY_NEEDS, RECOVERY_NEEDS_TITLE } from "../lib/recovery-copy";
import {
  deriveRecoveryKey,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
} from "../lib/recovery-code";
import { signRootRequest } from "../lib/root-material";
import type { RootSigningRequest } from "../lib/root-material";
import { DeviceKeyMissingError } from "../lib/root-proof";
import { AuthenticatorEnroller } from "./authenticator-enroller";
import { logFailure } from "../lib/client-log";

type Step =
  | { name: "loading" }
  | { name: "authenticator" }
  | { name: "intro" }
  | { name: "show"; code: string }
  | { name: "confirm"; code: string; mismatch: boolean }
  | { name: "arming" }
  | { name: "done" }
  | { name: "error"; message: string };

/** The two things recovery needs, said plainly, and what happens if both are lost. */
function RecoveryNeeds() {
  return (
    <div className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
      <p className="font-medium">{RECOVERY_NEEDS_TITLE}</p>
      <ul className="mt-1 list-disc pl-5">
        {RECOVERY_NEEDS.map((need) => (
          <li key={need}>{need}</li>
        ))}
      </ul>
      <p className="mt-2 font-medium">{RECOVERY_LOSS_WARNING}</p>
    </div>
  );
}

/**
 * Sets up recovery: the authenticator app first (a code that proves you hold it), then a NEW Recovery Code, armed with the
 * wallet's current root. The code is generated in this browser, shown once and
 * confirmed by typing it back; Kaada receives only the address derived from it (never the code), and the root signs the
 * operation that installs that address. The code lives in this component's memory only: not in the URL, storage or a form field.
 */
export function RecoveryCodeCreator({ token, onDone }: { token: string; onDone?: () => void }) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [context, setContext] = useState<{ account: Address; chainId: number } | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await json<{
          account: Address;
          chainId: number;
          authenticatorEnrolled: boolean;
        }>(await api("/recovery/configuration/context", token));
        if (cancelled) return;
        setContext(loaded);
        setStep(loaded.authenticatorEnrolled ? { name: "intro" } : { name: "authenticator" });
      } catch (error) {
        logFailure("recovery_code.context_failed", error);
        if (!cancelled) {
          setStep({
            name: "error",
            message: describeError(error, "We couldn't prepare your Recovery Code."),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const arm = useCallback(
    async (canonical: string) => {
      if (!context) return;
      setStep({ name: "arming" });
      try {
        const { address } = deriveRecoveryKey(canonical, context);
        const prepared = await json<{ configurationId: string; signing: RootSigningRequest }>(
          await api("/recovery/configuration/prepare", token, {
            body: { recoveryAddress: address },
          }),
        );
        const material = await signRootRequest(prepared.signing);
        await json(
          await api("/recovery/configuration", token, {
            body: { configurationId: prepared.configurationId, material },
          }),
        );
        setStep({ name: "done" });
        onDone?.();
      } catch (error) {
        logFailure("recovery_code.create_failed", error);
        setStep({
          name: "error",
          message:
            error instanceof DeviceKeyMissingError
              ? "This browser doesn't hold your wallet's device key. Open the link on the device you use."
              : describeError(error, "We couldn't save your Recovery Code. Nothing was changed."),
        });
      }
    },
    [context, onDone, token],
  );

  return (
    <section className="flex flex-col gap-4 border-t border-neutral-200 pt-6">
      <h2 className="text-lg font-semibold">Recovery setup</h2>
      {step.name === "loading" && <p className="text-sm text-neutral-600">Loading...</p>}
      {step.name === "authenticator" && (
        <>
          <RecoveryNeeds />
          <AuthenticatorEnroller token={token} onDone={() => setStep({ name: "intro" })} />
        </>
      )}
      {step.name === "intro" && (
        <>
          <RecoveryNeeds />
          <p className="text-sm text-neutral-600">
            Your Recovery Code is the second part. Kaada never sees it. Write it down and keep it
            somewhere safe, apart from your phone: with it, your authenticator app and your email,
            someone could start a recovery of your wallet.
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "show", code: generateRecoveryCode() })}
            className="rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white"
          >
            Create a new Recovery Code
          </button>
        </>
      )}
      {step.name === "show" && (
        <>
          <p className="text-sm text-neutral-600">
            Write this code down now. It is shown only once and cannot be recovered.
          </p>
          <p
            aria-label="Your Recovery Code"
            className="rounded-lg bg-neutral-100 px-4 py-4 text-center font-mono text-lg tracking-wide select-all"
          >
            {formatRecoveryCode(step.code)}
          </p>
          <button
            type="button"
            onClick={() => {
              setTyped("");
              setStep({ name: "confirm", code: step.code, mismatch: false });
            }}
            className="rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white"
          >
            I have written it down
          </button>
        </>
      )}
      {step.name === "confirm" && (
        <>
          <p className="text-sm text-neutral-600">Type the code back to make sure it is right.</p>
          <RecoveryNeeds />
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-label="Type your Recovery Code"
            className="rounded-lg border border-neutral-300 px-4 py-3 font-mono"
          />
          {step.mismatch && (
            <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
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
            className="rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white"
          >
            Confirm and save
          </button>
        </>
      )}
      {step.name === "arming" && (
        <p className="text-sm text-neutral-600">Confirm with your passkey or this device...</p>
      )}
      {step.name === "done" && (
        <p className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
          Recovery is set up. Keep your Recovery Code safe, and keep your authenticator app.
        </p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {step.message}
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "intro" })}
            className="rounded-xl border border-neutral-300 px-5 py-3 text-base font-medium"
          >
            Start again
          </button>
        </>
      )}
    </section>
  );
}
