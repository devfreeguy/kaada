"use client";
import { useCallback, useState } from "react";
import { api, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
import { useOperation } from "../lib/use-operation";
import { useWhen } from "../lib/use-when";

export type Step =
  | { name: "intro" }
  | { name: "working" }
  | { name: "scan"; uri: string; secret: string; wrong: boolean }
  | { name: "done" }
  | { name: "error"; message: string };

/**
 * Sets up the authenticator app that guards a recovery. The server makes the secret and shows it ONCE here (as a QR code and as
 * a key to type); it keeps only an encrypted copy. Setup is not finished until the person enters one valid 6-digit code from
 * the app, which proves the app really holds the secret. Works with Google Authenticator, Microsoft Authenticator, Authy,
 * 1Password and any other standard authenticator app.
 *
 * Both calls run through the operation gate (one at a time, a late answer dropped), and the parent hears about `done` from
 * useWhen, so a parent that fails cannot turn a linked app into a reported failure.
 */
export function useAuthenticator({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: "intro" });
  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const gate = useOperation();

  useWhen(step.name === "done", onDone);

  const begin = useCallback(async () => {
    const operation = gate.begin();
    if (!operation) return;
    operation.commit(() => setStep({ name: "working" }));
    try {
      const made = await json<{ otpauthUri: string; secret: string }>(
        await api("/recovery/configuration/authenticator/begin", token, { method: "POST" }),
      );
      setCode("");
      operation.commit(() =>
        setStep({ name: "scan", uri: made.otpauthUri, secret: made.secret, wrong: false }),
      );
    } catch (error) {
      logFailure("authenticator.begin_failed", error);
      operation.commit(() =>
        setStep({
          name: "error",
          message: describeError(error, "Couldn't start authenticator setup."),
        }),
      );
    } finally {
      operation.finish();
    }
  }, [gate, token]);

  const confirm = useCallback(
    async (current: Extract<Step, { name: "scan" }>) => {
      const operation = gate.begin();
      if (!operation) return;
      operation.commit(() => setConfirming(true));
      try {
        await json(
          await api("/recovery/configuration/authenticator/confirm", token, { body: { code } }),
        );
        setCode("");
        operation.succeed(() => setStep({ name: "done" }));
      } catch (error) {
        logFailure("authenticator.confirm_failed", error);
        const text = describeError(error, "");
        operation.commit(() => {
          setConfirming(false);
          if (text) {
            setStep({ name: "error", message: text });
          } else {
            setCode("");
            setStep({ ...current, wrong: true });
          }
        });
      } finally {
        operation.finish();
      }
    },
    [code, gate, token],
  );

  return { step, code, setCode, setStep, begin, confirm, confirming };
}
