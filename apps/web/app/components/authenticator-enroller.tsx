"use client";

import { useCallback, useState } from "react";

import { api, describeError, json } from "../lib/api";
import { groupSecret } from "../lib/recovery-copy";
import { QrCode } from "./qr-code";

type Step =
  | { name: "intro" }
  | { name: "working" }
  | { name: "scan"; uri: string; secret: string; wrong: boolean }
  | { name: "done" }
  | { name: "error"; message: string };

const button =
  "rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white disabled:opacity-50";

/**
 * Sets up the authenticator app that guards a recovery. The server makes the secret and shows it ONCE here (as a QR code and as
 * a key to type); it keeps only an encrypted copy. Setup is not finished until the person enters one valid 6-digit code from
 * the app, which proves the app really holds the secret. Works with Google Authenticator, Microsoft Authenticator, Authy,
 * 1Password and any other standard authenticator app.
 */
export function AuthenticatorEnroller({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: "intro" });
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
      setStep({
        name: "error",
        message: describeError(error, "We couldn't start the authenticator setup."),
      });
    }
  }, [token]);

  const confirm = useCallback(
    async (current: Extract<Step, { name: "scan" }>) => {
      try {
        await json(
          await api("/recovery/configuration/authenticator/confirm", token, { body: { code } }),
        );
        setCode("");
        setStep({ name: "done" });
        onDone();
      } catch (error) {
        const text = describeError(error, "");
        if (text) {
          setStep({ name: "error", message: text });
        } else {
          setCode("");
          setStep({ ...current, wrong: true });
        }
      }
    },
    [code, onDone, token],
  );

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Authenticator app</h2>
      {step.name === "intro" && (
        <>
          <p className="text-sm text-neutral-600">
            First, link an authenticator app (Google Authenticator, Microsoft Authenticator, Authy,
            1Password or similar). It gives you a 6-digit code that changes every 30 seconds, and
            you will need it, together with your Recovery Code, to recover your wallet.
          </p>
          <button type="button" onClick={() => void begin()} className={button}>
            Set up my authenticator app
          </button>
        </>
      )}
      {step.name === "working" && <p className="text-sm text-neutral-600">Working...</p>}
      {step.name === "scan" && (
        <>
          <p className="text-sm text-neutral-600">
            Scan this with your authenticator app, or type the key into it. We show it only once.
          </p>
          <QrCode value={step.uri} label="QR code for your authenticator app" />
          <p
            aria-label="Setup key"
            className="rounded-lg bg-neutral-100 px-4 py-3 text-center font-mono text-sm tracking-wide select-all"
          >
            {groupSecret(step.secret)}
          </p>
          <label className="flex flex-col gap-2 text-sm text-neutral-600">
            Now type the 6-digit code your app shows
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit code from your authenticator app"
              className="rounded-lg border border-neutral-300 px-4 py-3 font-mono text-lg tracking-widest"
            />
          </label>
          {step.wrong && (
            <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
              That code didn&apos;t work. Wait for the next one in your app and try again.
            </p>
          )}
          <button
            type="button"
            disabled={code.length !== 6}
            onClick={() => void confirm(step)}
            className={button}
          >
            Confirm the code
          </button>
        </>
      )}
      {step.name === "done" && (
        <p className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
          Your authenticator app is linked.
        </p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {step.message}
          </p>
          <button type="button" onClick={() => setStep({ name: "intro" })} className={button}>
            Start again
          </button>
        </>
      )}
    </section>
  );
}
