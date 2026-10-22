"use client";

import CountUp from "../../components/animations/text/count-up";
import { useEffect, useState } from "react";

const refreshInterval = 5 * 60 * 1000;
const requestTimeout = 10_000;
const formatter = new Intl.NumberFormat("en");

export function CompletedPayments() {
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let mounted = true;
    let pending: AbortController | null = null;
    async function refresh() {
      // One controller per request, cut off by hand after 10 seconds: older browsers lack AbortSignal.any and AbortSignal.timeout.
      const request = new AbortController();
      pending = request;
      const cutoff = window.setTimeout(() => request.abort(), requestTimeout);
      try {
        const response = await fetch("/api/v1/stats/public", {
          credentials: "omit",
          headers: { Accept: "application/json" },
          signal: request.signal,
        });
        if (!response.ok) throw new Error("Public statistics unavailable");
        const data: unknown = await response.json();
        if (
          typeof data !== "object" ||
          data === null ||
          !("completedPayments" in data) ||
          typeof data.completedPayments !== "number" ||
          !Number.isSafeInteger(data.completedPayments) ||
          data.completedPayments < 0
        )
          throw new Error("Invalid completed payment count");
        if (!mounted) return;
        setCount(data.completedPayments);
        setStatus("ready");
      } catch {
        // A failed refresh keeps the last good number on screen; only a page that never had one says "unavailable".
        if (mounted) setStatus((current) => (current === "ready" ? current : "unavailable"));
      } finally {
        window.clearTimeout(cutoff);
      }
    }
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, refreshInterval);
    return () => {
      mounted = false;
      pending?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const label =
    count !== null
      ? `${formatter.format(count)} completed payments`
      : status === "loading"
        ? "Loading completed payment count"
        : "Payment count temporarily unavailable";

  return (
    <span aria-live="polite" aria-label={label} title={label}>
      {count === null ? "—" : <CountUp to={count} separator="," duration={1.4} />}
    </span>
  );
}
