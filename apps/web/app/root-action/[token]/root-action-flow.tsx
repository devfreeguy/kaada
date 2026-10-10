"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready"; title: string; message: string }
  | { name: "confirming" }
  | { name: "done" }
  | { name: "error"; message: string };

/** The link token travels in a header only: never in a body, a query string or a log. */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api/v1/root-action${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Wallet setup that needs the person's passkey (creating the account and installing the restricted
 * permission for one payment). The server decides exactly what is signed and shows only a sentence
 * here; the page sends back the passkey's assertion and nothing else. It never asks for the PIN.
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
          const body = (await response.json()) as { title: string; message: string };
          next = { name: "ready", title: body.title, message: body.message };
        }
      } catch {
        next = { name: "error", message: "We couldn't reach Kaada. Please try again." };
      }
      if (!cancelled) setView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function confirm() {
    setView({ name: "confirming" });
    try {
      if (!browserSupportsWebAuthn()) {
        setView({ name: "error", message: "This browser can't use passkeys." });
        return;
      }
      const options = await call(token, "/options");
      if (options.status === 401) return setView({ name: "invalid" });
      if (!options.ok) throw new Error("options");
      const assertion = await startAuthentication({
        optionsJSON: (await options.json()) as PublicKeyCredentialRequestOptionsJSON,
      });
      const response = await call(token, "/complete", {
        method: "POST",
        body: JSON.stringify({ assertion }),
      });
      if (response.status === 401) return setView({ name: "invalid" });
      if (!response.ok) throw new Error("complete");
      setView({ name: "done" });
    } catch {
      setView({
        name: "error",
        message: "That didn't work. Nothing was changed; you can try again.",
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
            onClick={() => void confirm()}
            className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white"
          >
            Confirm with passkey
          </button>
        </section>
      )}
      {view.name === "confirming" && (
        <p className="text-neutral-600">Waiting for your passkey...</p>
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
            onClick={() => void confirm()}
            className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white"
          >
            Try again
          </button>
        </section>
      )}
    </main>
  );
}
