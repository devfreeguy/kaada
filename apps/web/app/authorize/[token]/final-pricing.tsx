"use client";

import { useEffect, useState } from "react";

interface Outcome {
  state: string;
  message: string;
}

const PENDING_STATES = new Set(["PREPARING", "NOT_STARTED", "PREPARATION_IN_PROGRESS"]);
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

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
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
          if (!PENDING_STATES.has(body.state)) return;
          if (Date.now() - started > GIVE_UP_MS) return;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (cancelled) return;
        }
      } catch {
        if (!cancelled) {
          setOutcome({
            state: "ERROR",
            message: "We couldn't check the final price. Nothing was sent.",
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
    <p role="status" className="rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-800">
      {outcome?.message ?? "Confirming the final price..."}
    </p>
  );
}
