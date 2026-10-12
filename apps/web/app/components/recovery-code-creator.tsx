"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { api, describeError, json } from "../lib/api";
import {
  deriveRecoveryKey,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
} from "../lib/recovery-code";
import { signRootRequest } from "../lib/root-material";
import type { RootSigningRequest } from "../lib/root-material";
import { DeviceKeyMissingError } from "../lib/root-proof";

type Step =
  | { name: "loading" }
  | { name: "intro" }
  | { name: "show"; code: string }
  | { name: "confirm"; code: string; mismatch: boolean }
  | { name: "arming" }
  | { name: "done" }
  | { name: "error"; message: string };

/**
 * Creates a NEW Recovery Code and arms it with the wallet's current root. The code is generated in this browser, shown once and
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
        const loaded = await json<{ account: Address; chainId: number }>(
          await api("/recovery/configuration/context", token),
        );
        if (cancelled) return;
        setContext(loaded);
        setStep({ name: "intro" });
      } catch (error) {
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
      <h2 className="text-lg font-semibold">Recovery Code</h2>
      {step.name === "loading" && <p className="text-sm text-neutral-600">Loading...</p>}
      {step.name === "intro" && (
        <>
          <p className="text-sm text-neutral-600">
            If you lose this device, your Recovery Code, together with your email, lets you get your
            wallet back after a safety delay. Kaada never sees it. Write it down and keep it
            somewhere safe: anyone with it and access to your email could start a recovery.
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
          Your new Recovery Code is active. Keep it safe.
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
