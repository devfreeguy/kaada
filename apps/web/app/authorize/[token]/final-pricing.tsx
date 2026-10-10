"use client";

import { useEffect, useState } from "react";

interface Outcome {
  state: string;
  message: string;
}

const PENDING_STATES = new Set(["PREPARING", "NOT_STARTED", "PREPARATION_IN_PROGRESS"]);
/** Payment states after which nothing more will happen on its own. */
const PAYMENT_DONE = new Set([
  "PAYMENT_SENT",
  "PAYMENT_FAILED",
  "REAUTHORIZATION_REQUIRED",
  "INSUFFICIENT_BALANCE",
  "GAS_FUNDING_REQUIRED",
  "EXECUTION_ROUTE_UNSUPPORTED",
]);
const PAYMENT_GIVE_UP_MS = 10 * 60_000;
const POLL_MS = 2000;
const GIVE_UP_MS = 100_000;

/** The token goes in a header only; this component sends no PIN and no payment detail. */
async function execution(token: string, path: string, method: "GET" | "POST"): Promise<Response> {
  return fetch(`/api/v1/execution${path}`, {
    method,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * After the PIN is accepted, asks the server to confirm the final price and follows the result. It
 * only ever shows what the server says; it never claims a payment was sent, because none has been.
 */
export function FinalPricing({ token }: { token: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // The secure link for wallet setup, when the payment is waiting on the passkey.
  const [setupUrl, setSetupUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    /** Carries the payment out (when the server has execution enabled) and follows it to its end. */
    async function followPayment(): Promise<void> {
      const run = await execution(token, "/run", "POST");
      // Not enabled here: the priced state above is all there is to show.
      if (run.status === 503) return;
      if (!run.ok) throw new Error("run");
      const paymentStarted = Date.now();
      for (;;) {
        const response = await execution(token, "/status", "GET");
        if (!response.ok) throw new Error("status");
        const body = (await response.json()) as Outcome;
        if (cancelled) return;
        setOutcome(body);
        if (body.state === "ROOT_ACTION_REQUIRED") {
          const link = await execution(token, "/root-action-link", "POST");
          if (link.ok) {
            const { url } = (await link.json()) as { url: string };
            if (!cancelled) setSetupUrl(url);
          }
        } else if (!cancelled) {
          setSetupUrl(null);
        }
        if (PAYMENT_DONE.has(body.state)) return;
        if (Date.now() - paymentStarted > PAYMENT_GIVE_UP_MS) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelled) return;
        // A payment that is waiting or was interrupted is picked up again; repeats are harmless.
        if (body.state === "NOT_STARTED" || body.state === "ROOT_ACTION_REQUIRED") {
          await execution(token, "/run", "POST");
        }
      }
    }

    void (async () => {
      try {
        const kickoff = await execution(token, "/prepare", "POST");
        if (kickoff.status === 503) {
          if (!cancelled) setUnavailable(true);
          return;
        }
        if (!kickoff.ok) throw new Error("prepare");
        for (;;) {
          const response = await execution(token, "/outcome", "GET");
          if (!response.ok) throw new Error("outcome");
          const body = (await response.json()) as Outcome;
          if (cancelled) return;
          setOutcome(body);
          if (body.state === "EXECUTION_READY") {
            await followPayment();
            return;
          }
          if (!PENDING_STATES.has(body.state)) return;
          if (Date.now() - started > GIVE_UP_MS) return;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (cancelled) return;
        }
      } catch {
        if (!cancelled) {
          setOutcome({
            state: "ERROR",
            message:
              "We couldn't confirm the payment's progress. If you started it, please check your wallet before trying again.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (unavailable) return null;
  return (
    <div className="space-y-3">
      <p role="status" className="rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-800">
        {outcome?.message ?? "Confirming the final price..."}
      </p>
      {setupUrl ? (
        <a
          href={setupUrl}
          className="block rounded-lg bg-neutral-900 px-4 py-3 text-center text-sm font-medium text-white"
        >
          Confirm wallet setup to continue payment
        </a>
      ) : null}
    </div>
  );
}
