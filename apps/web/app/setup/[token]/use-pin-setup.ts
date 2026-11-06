"use client";
import { useCallback, useEffect, useState } from "react";
import { api, describeError, json } from "../../lib/api";
import { failureCopy } from "../../lib/app-copy";
import { logFailure } from "../../lib/client-log";
import { observeRequest } from "../../lib/observe-request";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import { useOperation } from "../../lib/use-operation";
import { useWhen } from "../../lib/use-when";

export type Step =
  | { name: "loading" }
  | { name: "load-error"; message: string }
  | { name: "set" }
  | { name: "enter" }
  | { name: "confirm"; first: string }
  | { name: "working" }
  | { name: "saved" }
  | { name: "error"; message: string };

/**
 * Create the 6-digit PIN. Setting a PIN is security-sensitive, so after the two entries the person
 * confirms with their root once more (their passkey, or this device's key): that fresh proof, not the PIN, is the strong credential.
 * The digits exist only in this component's memory and are cleared as soon as they are used.
 *
 * Saving runs through the operation gate (one attempt at a time; a late answer is dropped), and `onDone` is told once the step
 * IS `set` or `saved` (useWhen), never from inside the save itself: a parent that throws while reacting cannot turn a saved PIN
 * into a reported failure.
 */
async function loadPinStatus(token: string) {
  const body = await json<{ isSet: boolean }>(await api("/wallet/pin", token));
  return body.isSet;
}

export function usePinSetup({
  token,
  onDone,
}: {
  token: string;
  onDone?: (() => void) | undefined;
}) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [value, setValue] = useState("");
  const [revision, setRevision] = useState(0);
  const gate = useOperation();

  const reload = useCallback(() => {
    gate.reset();
    setValue("");
    setStep({ name: "loading" });
    setRevision((current) => current + 1);
  }, [gate]);

  useEffect(
    () =>
      observeRequest(
        () => loadPinStatus(token),
        // Only a screen that is still waiting for this answer takes it: a late status read never replaces a saved PIN.
        (isSet) =>
          setStep((current) =>
            current.name === "loading" ? (isSet ? { name: "set" } : { name: "enter" }) : current,
          ),
        (error) => {
          logFailure("setup.pin_state_failed", error);
          setStep((current) =>
            current.name === "loading"
              ? { name: "load-error", message: describeError(error, "Couldn't check your PIN.") }
              : current,
          );
        },
      ),
    [token, revision],
  );

  useWhen(step.name === "set" || step.name === "saved", onDone);

  const save = useCallback(
    async (pin: string) => {
      const operation = gate.begin();
      if (!operation) return;
      operation.commit(() => setStep({ name: "working" }));
      try {
        const optionsResponse = await api("/wallet/pin/options", token, { method: "POST" });
        const challenge = await json<RootChallenge>(optionsResponse);
        // The wallet's root decides the prompt: a passkey, or this device's key. The PIN is only ever sent with that proof.
        const proof = await proveRoot(challenge);
        await json(await api("/wallet/pin", token, { method: "POST", body: { pin, proof } }));
        operation.succeed(() => setStep({ name: "saved" }));
      } catch (error) {
        logFailure("setup.pin_failed", error);
        const cancelled = error instanceof Error && error.name === "NotAllowedError";
        const message =
          error instanceof DeviceKeyMissingError
            ? failureCopy.deviceKeyMissing
            : cancelled
              ? "Cancelled. Your PIN wasn't saved."
              : describeError(
                  error,
                  "Couldn't confirm your PIN was saved. Reload before trying again.",
                );
        operation.commit(() => setStep({ name: "load-error", message }));
      } finally {
        operation.finish();
      }
    },
    [gate, token],
  );

  const next = useCallback(() => {
    if (step.name === "enter") {
      const first = value;
      setValue("");
      setStep({ name: "confirm", first });
    } else if (step.name === "confirm") {
      const entered = value;
      const first = step.first;
      setValue("");
      if (entered !== first) {
        setStep({ name: "error", message: "The PINs didn't match. Start again." });
        return;
      }
      void save(entered);
    }
  }, [save, step, value]);

  return { step, value, setValue, setStep, next, reload };
}
