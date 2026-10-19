"use client";
import { useCallback, useEffect, useState } from "react";
import { api, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
type Step =
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
 */
import { observeRequest } from "../../lib/observe-request";
async function loadPinStatus(token: string) {
  const body = await json<{ isSet: boolean }>(await api("/wallet/pin", token));
  return body.isSet;
}
export function usePinSetup({ token }: { token: string }) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [value, setValue] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = () => {
    setStep({ name: "loading" });
    setRevision((value) => value + 1);
  };
  useEffect(
    () =>
      observeRequest(
        () => loadPinStatus(token),
        (isSet) => setStep(isSet ? { name: "set" } : { name: "enter" }),
        (error) => {
          logFailure("setup.pin_state_failed", error);
          setStep({
            name: "load-error",
            message: describeError(error, "We couldn’t check your PIN. Try loading it again."),
          });
        },
      ),
    [token, revision],
  );
  const save = useCallback(
    async (pin: string) => {
      setStep({ name: "working" });
      try {
        const optionsResponse = await api("/wallet/pin/options", token, { method: "POST" });
        const challenge = await json<RootChallenge>(optionsResponse);
        // The wallet's root decides the prompt: a passkey, or this device's key. The PIN is only ever sent with that proof.
        const proof = await proveRoot(challenge);
        const response = await api("/wallet/pin", token, {
          method: "POST",
          body: { pin, proof },
        });
        await json(response);
        setStep({ name: "saved" });
      } catch (error) {
        logFailure("setup.pin_failed", error);
        const cancelled = error instanceof Error && error.name === "NotAllowedError";
        setStep({
          name: "load-error",
          message:
            error instanceof DeviceKeyMissingError
              ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
              : cancelled
                ? "Confirmation was cancelled. Your PIN was not saved."
                : describeError(
                    error,
                    "We couldn’t confirm your PIN was saved. Reload the wallet before trying again.",
                  ),
        });
      }
    },
    [token],
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
        setStep({ name: "error", message: "The two PINs didn't match. Start again." });
        return;
      }
      void save(entered);
    }
  }, [save, step, value]);
  return { step, value, setValue, setStep, next, reload };
}
