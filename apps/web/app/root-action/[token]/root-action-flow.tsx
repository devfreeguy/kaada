"use client";

import { useEffect, useState } from "react";

import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import type { RootChallenge } from "../../lib/root-proof";
import { loggedFetch, logFailure } from "../../lib/client-log";

type RootAction = "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED";

type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready"; title: string; message: string; action: RootAction }
  | { name: "confirming"; action: RootAction }
  | { name: "done" }
  | { name: "error"; message: string; action: RootAction };

/** The link token travels in a header only: never in a body, a query string or a log. */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return loggedFetch(`/api/v1/root-action${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

const confirmLabel = (action: RootAction) =>
  action === "ROOT_PASSKEY_REQUIRED" ? "Confirm with passkey" : "Confirm with this device";

/**
 * Wallet setup that needs the person's ROOT (creating the account and installing the restricted permission for one
 * payment). The server decides exactly what is signed and which signer the wallet has: the page shows a sentence and the
 * matching prompt (a passkey, or this device's key), sends back the root's proof and nothing else, and never asks for the PIN.
 */
export function RootActionFlow({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: View;
      try {
        const response = await call(token, "/view");
        if (response.status === 401) next = { name: "invalid" };
        else if (!response.ok) throw new Error("unavailable");
        else {
          const body = (await response.json()) as {
            title: string;
            message: string;
            action: RootAction;
          };
          next = { name: "ready", title: body.title, message: body.message, action: body.action };
        }
      } catch (error) {
        logFailure("root_action.load_failed", error);
        next = {
          name: "error",
          message: "We couldn't reach Kaada. Please try again.",
          action: "ROOT_PASSKEY_REQUIRED",
        };
      }
      if (!cancelled) setView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function confirm(action: RootAction) {
    setView({ name: "confirming", action });
    try {
      const options = await call(token, "/options");
      if (options.status === 401) return setView({ name: "invalid" });
      if (!options.ok) throw new Error("options");
      const proof = await proveRoot((await options.json()) as RootChallenge);
      const response = await call(token, "/complete", {
        method: "POST",
        body: JSON.stringify({ proof }),
      });
      if (response.status === 401) return setView({ name: "invalid" });
      if (!response.ok) throw new Error("complete");
      setView({ name: "done" });
    } catch (error) {
      logFailure("root_action.register_failed", error);
      // Cancelling the prompt is the person's choice, not a fault.
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      setView({
        name: "error",
        action,
        message:
          error instanceof DeviceKeyMissingError
            ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
            : cancelled
              ? "Confirmation was cancelled. Nothing was changed; you can try again."
              : "That didn't work. Nothing was changed; you can try again.",
      });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-12">
      {view.name === "loading" && <p className="text-neutral-600">Loading...</p>}
      {view.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link isn&apos;t valid</h1>
          <p className="text-neutral-600">
            It may have expired or already been used. Go back to your payment to get a new one.
          </p>
        </section>
      )}
      {view.name === "ready" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">{view.title}</h1>
          <p className="text-neutral-600">{view.message}</p>
          <button
            type="button"
            onClick={() => void confirm(view.action)}
            className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white"
          >
            {confirmLabel(view.action)}
          </button>
        </section>
      )}
      {view.name === "confirming" && (
        <p className="text-neutral-600">
          {view.action === "ROOT_PASSKEY_REQUIRED"
            ? "Waiting for your passkey..."
            : "Confirming with this device..."}
        </p>
      )}
      {view.name === "done" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">Wallet setup submitted</h1>
          <p className="text-neutral-600">
            Return to your payment page. It continues on its own once the setup is confirmed.
          </p>
        </section>
      )}
      {view.name === "error" && (
        <section className="flex flex-col gap-3">
          <p className="text-neutral-800">{view.message}</p>
          <button
            type="button"
            onClick={() => void confirm(view.action)}
            className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white"
          >
            Try again
          </button>
        </section>
      )}
    </main>
  );
}
