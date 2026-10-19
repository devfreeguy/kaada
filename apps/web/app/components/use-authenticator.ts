"use client";
import { useCallback, useState } from "react";
import { api, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
type Step =
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
 */
export function useAuthenticator({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: "intro" });
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState("");
  const begin = useCallback(async () => {
    setStep({ name: "working" });
    try {
      const made = await json<{ otpauthUri: string; secret: string }>(
        await api("/recovery/configuration/authenticator/begin", token, { method: "POST" }),
      );
      setCode("");
      setStep({ name: "scan", uri: made.otpauthUri, secret: made.secret, wrong: false });
    } catch (error) {
      logFailure("authenticator.begin_failed", error);
      setStep({
        name: "error",
        message: describeError(error, "We couldn't start the authenticator setup."),
      });
    }
  }, [token]);
  const confirm = useCallback(
    async (current: Extract<Step, { name: "scan" }>) => {
      if (confirming) return;
      setConfirming(true);
      try {
        await json(
          await api("/recovery/configuration/authenticator/confirm", token, { body: { code } }),
        );
        setCode("");
        setStep({ name: "done" });
        onDone();
      } catch (error) {
        logFailure("authenticator.confirm_failed", error);
        const text = describeError(error, "");
        if (text) {
          setStep({ name: "error", message: text });
        } else {
          setCode("");
          setStep({ ...current, wrong: true });
        }
      } finally {
        setConfirming(false);
      }
    },
    [code, confirming, onDone, token],
  );
  return { step, code, setCode, setStep, begin, confirm, confirming };
}
