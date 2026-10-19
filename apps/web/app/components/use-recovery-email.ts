"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
import { observeRequest } from "../lib/observe-request";

type Step =
  | { name: "loading" }
  | { name: "enter" }
  | { name: "sending" }
  | { name: "code"; email: string }
  | { name: "checking"; email: string }
  | { name: "done"; masked: string }
  | { name: "error"; message: string; retry: "load" | "enter" };

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Registers the email a person recovers with. Recovery starts from this address, so without it nobody can get back in: it is the
 * first part of recovery setup. A 6-digit code is sent to the address and the address counts only once the right code is entered.
 * The page cannot say whether an address already belongs to someone: the answer is the same either way.
 */
export function useRecoveryEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(
    () =>
      observeRequest(
        async () =>
          json<{ registered: boolean; masked?: string }>(
            await api("/recovery/configuration/email", token),
          ),
        (status) =>
          setStep(
            status.registered ? { name: "done", masked: status.masked ?? "" } : { name: "enter" },
          ),
        (error) => {
          logFailure("recovery_email.status_failed", error);
          setStep({
            name: "error",
            message: describeError(error, "We couldn’t check your email. Try again."),
            retry: "load",
          });
        },
      ),
    [token, revision],
  );

  const reload = () => {
    setStep({ name: "loading" });
    setRevision((value) => value + 1);
  };

  const send = useCallback(async () => {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setStep({ name: "error", message: "Enter a valid email address.", retry: "enter" });
      return;
    }
    setStep({ name: "sending" });
    try {
      await json(
        await api("/recovery/configuration/email/begin", token, { body: { email: address } }),
      );
      setCode("");
      setStep({ name: "code", email: address });
    } catch (error) {
      logFailure("recovery_email.send_failed", error);
      setStep({
        name: "error",
        message:
          error instanceof ApiError && error.kind === "rate-limited"
            ? "Please wait a minute before asking for another code."
            : error instanceof ApiError && error.kind === "unavailable"
              ? "We couldn’t send the email right now. Please try again in a few minutes."
              : describeError(error, "We couldn’t send the code. Check the address and try again."),
        retry: "enter",
      });
    }
  }, [email, token]);

  const confirm = useCallback(
    async (address: string) => {
      setStep({ name: "checking", email: address });
      try {
        const done = await json<{ masked: string }>(
          await api("/recovery/configuration/email/confirm", token, { body: { code } }),
        );
        setCode("");
        setStep({ name: "done", masked: done.masked });
        onDone();
      } catch (error) {
        logFailure("recovery_email.confirm_failed", error);
        setCode("");
        setStep({
          name: "error",
          message:
            error instanceof ApiError && error.kind === "rejected"
              ? "That code didn’t work. It may be wrong or expired. Ask for a new one."
              : describeError(error, "We couldn’t check the code. Try again."),
          retry: "enter",
        });
      }
    },
    [code, onDone, token],
  );

  return { step, email, setEmail, code, setCode, send, confirm, reload, setStep };
}
