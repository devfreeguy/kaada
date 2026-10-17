"use client";

import { useEffect, useState } from "react";

import { api, describeError, json } from "../../lib/api";
import { signRootRequest } from "../../lib/root-material";
import type { RootSigningRequest } from "../../lib/root-material";
import { DeviceKeyMissingError } from "../../lib/root-proof";

type View =
  | { name: "loading" }
  | { name: "missing" }
  | { name: "ready" }
  | { name: "working"; what: "report" | "cancel" }
  | { name: "stopped"; how: "report" | "cancel" }
  | { name: "error"; message: string };

const button =
  "rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white disabled:opacity-50";
const secondary = "rounded-xl border border-neutral-300 px-5 py-4 text-base font-medium";

/**
 * "This was not me." The link in the recovery email carries a one-use token in its URL FRAGMENT (which is never sent to a
 * server or a log); it is moved into memory and removed from the address bar at once. Two ways to stop a pending recovery:
 * report it (Kaada security vetoes it; no device needed) or cancel it with the CURRENT root (passkey or device key).
 */
export function ReportFlow() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "loading" });

  useEffect(() => {
    const match = /^#([A-Za-z0-9_-]{20,})$/.exec(window.location.hash);
    // Remove the token from the address bar and history straight away.
    window.history.replaceState(null, "", window.location.pathname);
    void Promise.resolve().then(() => {
      if (!match?.[1]) return setView({ name: "missing" });
      setToken(match[1]);
      setView({ name: "ready" });
    });
  }, []);

  async function report() {
    if (!token) return;
    setView({ name: "working", what: "report" });
    try {
      await json(await api("/recovery/report", token, { method: "POST" }));
      setView({ name: "stopped", how: "report" });
    } catch (error) {
      setView({
        name: "error",
        message: describeError(
          error,
          "We couldn't stop it. It may already be finished or stopped.",
        ),
      });
    }
  }

  async function cancelWithRoot() {
    if (!token) return;
    setView({ name: "working", what: "cancel" });
    try {
      const request = await json<RootSigningRequest>(
        await api("/recovery/cancel/prepare", token, { method: "POST" }),
      );
      const material = await signRootRequest(request);
      await json(await api("/recovery/cancel", token, { body: { material } }));
      setView({ name: "stopped", how: "cancel" });
    } catch (error) {
      setView({
        name: "error",
        message:
          error instanceof DeviceKeyMissingError
            ? "This browser doesn't hold your wallet's device key. Open the link on the device you use, or report it instead."
            : describeError(error, "We couldn't cancel it. Nothing was changed."),
      });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {view.name === "loading" && <p className="text-neutral-600">Loading...</p>}
      {view.name === "missing" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link isn&apos;t valid</h1>
          <p className="text-neutral-600">
            Open the link from the recovery email exactly as it was sent. Links work once.
          </p>
        </section>
      )}
      {(view.name === "ready" || view.name === "working" || view.name === "error") && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Stop a wallet recovery</h1>
          <p className="text-neutral-600">
            Someone asked to recover your Kaada wallet. If that was you, you don&apos;t need to do
            anything. If it was not you, stop it now.
          </p>
          {view.name === "error" && (
            <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
              {view.message}
            </p>
          )}
          <button
            type="button"
            disabled={view.name === "working"}
            onClick={() => void report()}
            className={button}
          >
            {view.name === "working" && view.what === "report"
              ? "Stopping..."
              : "This was not me. Stop it"}
          </button>
          <button
            type="button"
            disabled={view.name === "working"}
            onClick={() => void cancelWithRoot()}
            className={secondary}
          >
            {view.name === "working" && view.what === "cancel"
              ? "Confirm on your device..."
              : "Cancel it from my current device"}
          </button>
          <p className="text-xs text-neutral-500">
            Stopping a recovery never moves funds and never changes your wallet.
          </p>
        </section>
      )}
      {view.name === "stopped" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">The recovery was stopped</h1>
          <p className="text-neutral-600">
            Your wallet is unchanged. You will get an email to confirm. If you did not ask for it,
            consider reviewing your email account.
          </p>
        </section>
      )}
    </div>
  );
}
