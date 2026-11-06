"use client";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { api, describeError, json } from "../lib/api";
import { failureCopy } from "../lib/app-copy";
import { logFailure } from "../lib/client-log";
import { observeRequest } from "../lib/observe-request";
import { deriveRecoveryKey } from "../lib/recovery-code";
import type { RootSigningRequest } from "../lib/root-material";
import { signRootRequest } from "../lib/root-material";
import { DeviceKeyMissingError } from "../lib/root-proof";
import { useOperation } from "../lib/use-operation";
import { useWhen } from "../lib/use-when";

export type Step =
  | { name: "loading" }
  | { name: "email" }
  | { name: "authenticator" }
  | { name: "intro" }
  | { name: "show"; code: string }
  | { name: "confirm"; code: string; mismatch: boolean }
  | { name: "arming" }
  | { name: "done" }
  | { name: "error"; message: string };

/**
 * Sets up recovery: the authenticator app first (a code that proves you hold it), then a NEW Recovery Code, armed with the
 * wallet's current root. The code is generated in this browser, shown once and
 * confirmed by typing it back; Kaada receives only the address derived from it (never the code), and the root signs the
 * operation that installs that address. The code lives in this component's memory only: not in the URL, storage or a form field.
 *
 * Arming runs through the operation gate (one attempt; a late answer is dropped) and the parent is told it is done only once the
 * step IS done (useWhen), so a parent that fails cannot turn a completed setup into a reported failure.
 */
async function loadRecoveryContext(token: string) {
  return json<{
    account: Address;
    chainId: number;
    authenticatorEnrolled: boolean;
    emailRegistered: boolean;
  }>(await api("/recovery/configuration/context", token));
}

export function useRecoveryCode({
  token,
  onDone,
}: {
  token: string;
  onDone?: (() => void) | undefined;
}) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [context, setContext] = useState<{ account: Address; chainId: number } | null>(null);
  const [typed, setTyped] = useState("");
  const [revision, setRevision] = useState(0);
  const gate = useOperation();

  const reload = useCallback(() => {
    gate.reset();
    setTyped("");
    setStep({ name: "loading" });
    setRevision((value) => value + 1);
  }, [gate]);

  useEffect(
    () =>
      observeRequest(
        () => loadRecoveryContext(token),
        (loaded) => {
          setContext(loaded);
          // In order: the email recovery starts from, the authenticator app, then the Recovery Code.
          const next: Step = !loaded.emailRegistered
            ? { name: "email" }
            : loaded.authenticatorEnrolled
              ? { name: "intro" }
              : { name: "authenticator" };
          setStep((current) => (current.name === "loading" ? next : current));
        },
        (error) => {
          logFailure("recovery_code.context_failed", error);
          setStep((current) =>
            current.name === "loading"
              ? { name: "error", message: describeError(error, "Couldn't prepare recovery setup.") }
              : current,
          );
        },
      ),
    [token, revision],
  );

  useWhen(step.name === "done", onDone);

  const arm = useCallback(
    async (canonical: string) => {
      if (!context) return;
      const operation = gate.begin();
      if (!operation) return;
      operation.commit(() => setStep({ name: "arming" }));
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
        operation.succeed(() => setStep({ name: "done" }));
      } catch (error) {
        logFailure("recovery_code.create_failed", error);
        operation.commit(() =>
          setStep({
            name: "error",
            message:
              error instanceof DeviceKeyMissingError
                ? failureCopy.deviceKeyMissing
                : describeError(
                    error,
                    "Couldn't confirm recovery setup. Reload before trying again.",
                  ),
          }),
        );
      } finally {
        operation.finish();
      }
    },
    [context, gate, token],
  );

  return { step, typed, setTyped, setStep, arm, reload };
}
