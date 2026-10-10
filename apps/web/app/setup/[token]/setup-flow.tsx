"use client";

import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";

interface WalletInfo {
  address: string | null;
  status: string;
}

interface BalanceLine {
  symbol: string;
  formatted: string;
}

type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready" }
  | { name: "finish" }
  | { name: "creating" }
  | { name: "done"; address: string }
  | { name: "error"; message: string; retry: "create" | "finish" };

/** Sends the setup token as a bearer header: it is never put in a body, a query string or a log. */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api/v1/wallet${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function SetupFlow({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });
  const [copied, setCopied] = useState(false);
  const [balances, setBalances] = useState<BalanceLine[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: View;
      try {
        const response = await call(token, "");
        if (response.status === 401) {
          next = { name: "invalid" };
        } else if (!response.ok) {
          throw new Error("unavailable");
        } else {
          const body = (await response.json()) as {
            passkeyRegistered: boolean;
            wallet: WalletInfo | null;
          };
          next =
            body.wallet?.status === "ACTIVE" && body.wallet.address
              ? { name: "done", address: body.wallet.address }
              : body.passkeyRegistered
                ? { name: "finish" }
                : { name: "ready" };
        }
      } catch {
        next = {
          name: "error",
          message: "We couldn't reach Kaada. Please try again.",
          retry: "create",
        };
      }
      if (!cancelled) setView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const address = view.name === "done" ? view.address : null;
  useEffect(() => {
    if (!address) return;
    void (async () => {
      try {
        const response = await call(token, "/balances");
        if (!response.ok) return;
        const body = (await response.json()) as { balances: BalanceLine[] };
        setBalances(body.balances.filter((line) => line.formatted !== "0"));
      } catch {
        // Balances are a convenience; the wallet is ready either way.
      }
    })();
  }, [address, token]);

  const finish = useCallback(async () => {
    setView({ name: "creating" });
    try {
      const response = await call(token, "/setup/finalize", { method: "POST" });
      if (response.status === 401) return setView({ name: "invalid" });
      if (!response.ok) throw new Error("failed");
      const body = (await response.json()) as { wallet: WalletInfo | null };
      if (body.wallet?.address) return setView({ name: "done", address: body.wallet.address });
      throw new Error("no wallet");
    } catch {
      setView({
        name: "error",
        message:
          "Your passkey is saved, but the wallet could not be created yet. Please try again.",
        retry: "finish",
      });
    }
  }, [token]);

  const create = useCallback(async () => {
    if (!browserSupportsWebAuthn()) {
      return setView({
        name: "error",
        message: "This browser doesn't support passkeys. Please open the link in Safari or Chrome.",
        retry: "create",
      });
    }
    setView({ name: "creating" });
    try {
      const optionsResponse = await call(token, "/passkeys/registration/options", {
        method: "POST",
      });
      if (optionsResponse.status === 401) return setView({ name: "invalid" });
      if (!optionsResponse.ok) throw new Error("options");
      const optionsJSON = (await optionsResponse.json()) as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"];

      const credential = await startRegistration({ optionsJSON });

      const verifyResponse = await call(token, "/passkeys/registration/verify", {
        method: "POST",
        body: JSON.stringify(credential),
      });
      if (verifyResponse.status === 401) return setView({ name: "invalid" });
      if (verifyResponse.status === 502) {
        return setView({
          name: "error",
          message:
            "Your passkey is saved, but the wallet could not be created yet. Please try again.",
          retry: "finish",
        });
      }
      if (!verifyResponse.ok) throw new Error("verify");
      const body = (await verifyResponse.json()) as { wallet: WalletInfo | null };
      if (!body.wallet?.address) throw new Error("no wallet");
      setView({ name: "done", address: body.wallet.address });
    } catch (error) {
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      setView({
        name: "error",
        message: cancelled
          ? "Passkey creation was cancelled. You can try again when you're ready."
          : "We couldn't create your passkey. Please try again.",
        retry: "create",
      });
    }
  }, [token]);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the address is still on screen.
    }
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p className="text-sm font-semibold tracking-wide text-neutral-500">Kaada</p>

      {view.name === "loading" && <p className="text-neutral-600">Checking your link...</p>}

      {view.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link has expired</h1>
          <p className="text-neutral-600">
            For your security, setup links work once and only for a few minutes. Go back to your
            chat and ask Kaada for a new one.
          </p>
        </section>
      )}

      {(view.name === "ready" || view.name === "creating" || view.name === "error") && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Secure your wallet</h1>
          <p className="text-neutral-600">
            Your passkey protects your Kaada wallet. No seed phrase is required for normal use.
          </p>
          {view.name === "error" && (
            <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
              {view.message}
            </p>
          )}
          <button
            type="button"
            disabled={view.name === "creating"}
            onClick={() =>
              void (view.name === "error" && view.retry === "finish" ? finish() : create())
            }
            className="rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white disabled:opacity-50"
          >
            {view.name === "creating"
              ? "Waiting for your passkey..."
              : view.name === "error" && view.retry === "finish"
                ? "Finish setup"
                : "Create Passkey"}
          </button>
          <p className="text-xs text-neutral-500">
            Your device keeps the passkey. Kaada never sees or stores it.
          </p>
        </section>
      )}

      {view.name === "finish" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Almost done</h1>
          <p className="text-neutral-600">
            Your passkey is saved. One more step creates your wallet.
          </p>
          <button
            type="button"
            onClick={() => void finish()}
            className="rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white"
          >
            Finish setup
          </button>
        </section>
      )}

      {view.name === "done" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Wallet ready</h1>
          <p
            className="break-all rounded-lg bg-neutral-100 px-4 py-3 font-mono text-sm"
            title={view.address}
          >
            {shorten(view.address)}
          </p>
          <p className="text-xs text-neutral-500">
            Send supported Celo stablecoins to this address to fund your wallet.
          </p>
          {balances.length > 0 && (
            <ul className="text-sm text-neutral-700">
              {balances.map((line) => (
                <li key={line.symbol}>
                  {line.formatted} {line.symbol}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void copy(view.address)}
              className="flex-1 rounded-xl border border-neutral-300 px-5 py-4 text-base font-medium"
            >
              {copied ? "Copied" : "Copy Address"}
            </button>
            <button
              type="button"
              onClick={() => window.close()}
              className="flex-1 rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white"
            >
              Done
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            You can close this page and return to your chat.
          </p>
        </section>
      )}
    </main>
  );
}
