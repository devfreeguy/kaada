"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
import { observeRequest } from "../lib/observe-request";
import { useOperation } from "../lib/use-operation";
import { useWhen } from "../lib/use-when";

export type Step =
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
 *
 * Sending and checking run through the operation gate, and the parent hears about `done` from useWhen rather than from inside the
 * check, so a parent that fails cannot turn a verified email into a reported failure.
 */
export function useRecoveryEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [revision, setRevision] = useState(0);
  const gate = useOperation();

  useEffect(
    () =>
      observeRequest(
        async () =>
          json<{ registered: boolean; masked?: string }>(
            await api("/recovery/configuration/email", token),
          ),
        (status) =>
          setStep((current) =>
            current.name !== "loading"
              ? current
              : status.registered
                ? { name: "done", masked: status.masked ?? "" }
                : { name: "enter" },
          ),
        (error) => {
          logFailure("recovery_email.status_failed", error);
          setStep((current) =>
            current.name !== "loading"
              ? current
              : {
                  name: "error",
                  message: describeError(error, "Couldn't check your email."),
                  retry: "load",
                },
          );
        },
      ),
    [token, revision],
  );

  useWhen(step.name === "done", onDone);

  const reload = useCallback(() => {
    gate.reset();
    setStep({ name: "loading" });
    setRevision((value) => value + 1);
  }, [gate]);

  const send = useCallback(async () => {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setStep({ name: "error", message: "Enter a valid email address.", retry: "enter" });
      return;
    }
    const operation = gate.begin();
    if (!operation) return;
    operation.commit(() => setStep({ name: "sending" }));
    try {
      await json(
        await api("/recovery/configuration/email/begin", token, { body: { email: address } }),
      );
      setCode("");
      operation.commit(() => setStep({ name: "code", email: address }));
    } catch (error) {
      logFailure("recovery_email.send_failed", error);
      operation.commit(() =>
        setStep({
          name: "error",
          message:
            error instanceof ApiError && error.kind === "rate-limited"
              ? "Wait a minute before asking for another code."
              : error instanceof ApiError && error.kind === "unavailable"
                ? "Couldn't send the email. Try again in a few minutes."
                : describeError(error, "Couldn't send the code. Check the address."),
          retry: "enter",
        }),
      );
    } finally {
      operation.finish();
    }
  }, [email, gate, token]);

  const confirm = useCallback(
    async (address: string) => {
      const operation = gate.begin();
      if (!operation) return;
      operation.commit(() => setStep({ name: "checking", email: address }));
      try {
        const done = await json<{ masked: string }>(
          await api("/recovery/configuration/email/confirm", token, { body: { code } }),
        );
        setCode("");
        operation.succeed(() => setStep({ name: "done", masked: done.masked }));
      } catch (error) {
        logFailure("recovery_email.confirm_failed", error);
        setCode("");
        operation.commit(() =>
          setStep({
            name: "error",
            message:
              error instanceof ApiError && error.kind === "rejected"
                ? "That code didn't work. It may be wrong or expired."
                : describeError(error, "Couldn't check the code. Try again."),
            retry: "enter",
          }),
        );
      } finally {
        operation.finish();
      }
    },
    [code, gate, token],
  );

  return { step, email, setEmail, code, setCode, send, confirm, reload, setStep };
}
