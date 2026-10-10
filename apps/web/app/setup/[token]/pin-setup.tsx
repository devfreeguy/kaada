"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";

import { PinKeypad } from "../../components/pin-keypad";

type Step =
  | { name: "loading" }
  | { name: "set" }
  | { name: "enter" }
  | { name: "confirm"; first: string }
  | { name: "working" }
  | { name: "saved" }
  | { name: "error"; message: string };

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api/v1/wallet/pin${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Create the 4-digit PIN. Setting a PIN is security-sensitive, so after the two entries the person
 * touches their passkey once more: that fresh assertion, not the PIN, is the strong credential.
 * The digits exist only in this component's memory and are cleared as soon as they are used.
 */
export function PinSetup({ token }: { token: string }) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [value, setValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: Step = { name: "enter" };
      try {
        const response = await call(token, "");
        if (response.ok) {
          const body = (await response.json()) as { isSet: boolean };
          if (body.isSet) next = { name: "set" };
        }
      } catch {
        // Fall through to the creation step; the server decides what is allowed.
      }
      if (!cancelled) setStep(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const save = useCallback(
    async (pin: string) => {
      setStep({ name: "working" });
      try {
        if (!browserSupportsWebAuthn()) throw new Error("unsupported");
        const optionsResponse = await call(token, "/options", { method: "POST" });
        if (!optionsResponse.ok) throw new Error("options");
        const optionsJSON = (await optionsResponse.json()) as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"];
        const assertion = await startAuthentication({ optionsJSON });
        const response = await call(token, "", {
          method: "POST",
          body: JSON.stringify({ pin, assertion }),
        });
        if (!response.ok) throw new Error("save");
        setStep({ name: "saved" });
      } catch (error) {
        const cancelled = error instanceof Error && error.name === "NotAllowedError";
        setStep({
          name: "error",
          message: cancelled
            ? "Passkey confirmation was cancelled. Your PIN was not saved."
            : "We couldn't save your PIN. Please try again.",
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

  if (step.name === "loading") return null;

  return (
    <section className="flex flex-col gap-4 border-t border-neutral-200 pt-6">
      {step.name === "set" && <p className="text-sm text-neutral-600">Your payment PIN is set.</p>}
      {step.name === "saved" && <p className="text-sm text-neutral-800">PIN saved.</p>}
      {step.name === "working" && (
        <p className="text-sm text-neutral-600">Confirm with your passkey...</p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {step.message}
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "enter" })}
            className="rounded-xl border border-neutral-300 px-5 py-3 text-base font-medium"
          >
            Try again
          </button>
        </>
      )}
      {(step.name === "enter" || step.name === "confirm") && (
        <>
          <h2 className="text-lg font-semibold">
            {step.name === "enter" ? "Create your 4-digit PIN" : "Enter it again"}
          </h2>
          <p className="text-sm text-neutral-600">
            You will use this PIN to approve each payment. It is not a recovery code and does not
            unlock your wallet.
          </p>
          <PinKeypad
            value={value}
            onChange={setValue}
            onSubmit={next}
            submitLabel={step.name === "enter" ? "Next" : "Save"}
          />
        </>
      )}
    </section>
  );
}
