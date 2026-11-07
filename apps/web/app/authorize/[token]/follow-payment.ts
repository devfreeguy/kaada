import { logFailure } from "../../lib/client-log";
import { api } from "../../lib/api";
export interface Outcome {
  state: string;
  message?: string;
  /** Which signer the next step needs, when the server says the payment waits on one. */
  action?: string;
}
const PENDING_STATES = new Set(["PREPARING", "NOT_STARTED", "PREPARATION_IN_PROGRESS"]);
/** Payment states that are final: nothing that arrives later may replace them. */
const FINAL_STATES = new Set([
  "PAYMENT_SENT",
  "PAYMENT_FAILED",
  "REAUTHORIZATION_REQUIRED",
  "INSUFFICIENT_BALANCE",
  "GAS_FUNDING_REQUIRED",
  "EXECUTION_ROUTE_UNSUPPORTED",
  "EXECUTION_BLOCKED",
  "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY",
  "FINAL_PRICE_UNAVAILABLE",
  "PROVIDER_CAPACITY_REACHED",
]);
/** States a payment reaches only after its price is confirmed and execution has begun. */
const PROGRESSED_STATES = new Set([
  "EXECUTION_READY",
  "ROOT_ACTION_REQUIRED",
  "PROCESSING_PAYMENT",
  "PAYMENT_PENDING",
]);

/**
 * Which of two answers the page should keep. The payment's status can be read from the server a moment before its run has
 * recorded anything, which comes back as "not started" even though the price was already confirmed: that answer describes an
 * older moment, so it never replaces a later one. A final state is never replaced by anything. Every other change is a real
 * transition and is shown.
 */
export function advanceOutcome(current: Outcome | null, incoming: Outcome): Outcome {
  if (!current) return incoming;
  if (FINAL_STATES.has(current.state)) return current;
  if (incoming.state === "NOT_STARTED" && PROGRESSED_STATES.has(current.state)) return current;
  return incoming;
}
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
/** A root-action link lives 10 minutes; ask for a new one a little before that. */
const LINK_REFRESH_MS = 8 * 60_000;
const POLL_MS = 2000;
const GIVE_UP_MS = 100_000;
/** The token goes in a header only; this component sends no PIN and no payment detail. */
async function execution(token: string, path: string, method: "GET" | "POST"): Promise<Response> {
  return api(`/execution${path}`, token, { method });
}

export function watchFinalPricing(
  token: string,
  alreadySent: boolean,
  {
    setOutcome,
    setUnavailable,
    setSetupUrl,
  }: {
    setOutcome: (value: Outcome) => void;
    setUnavailable: (value: boolean) => void;
    setSetupUrl: (value: string | null) => void;
  },
) {
  let cancelled = false;
  const started = Date.now();
  /** Carries the payment out (when the server has execution enabled) and follows it to its end. */
  async function followPayment(): Promise<void> {
    const run = await execution(token, "/run", "POST");
    // Not enabled here: the priced state above is all there is to show.
    if (run.status === 503) return;
    if (!run.ok) throw new Error("run");
    const paymentStarted = Date.now();
    let linkIssuedAt = 0;
    for (;;) {
      const response = await execution(token, "/status", "GET");
      if (!response.ok) throw new Error("status");
      const body = (await response.json()) as Outcome;
      if (cancelled) return;
      setOutcome(body);
      if (body.state === "ROOT_ACTION_REQUIRED") {
        // Ask for the secure link ONCE and keep it: every request replaces the previous link's token,
        // so re-requesting on each poll would invalidate the link the person is about to click.
        // (Found in the real-browser run.) Ask again only when it is close to expiring.
        if (Date.now() - linkIssuedAt > LINK_REFRESH_MS) {
          const link = await execution(token, "/root-action-link", "POST");
          if (link.ok) {
            const { url } = (await link.json()) as { url: string };
            linkIssuedAt = Date.now();
            if (!cancelled) setSetupUrl(url);
          }
        }
      } else if (!cancelled) {
        linkIssuedAt = 0;
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
      if (alreadySent) {
        await followPayment();
        return;
      }
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
    } catch (error) {
      logFailure("authorize.final_pricing_failed", error);
      if (!cancelled) {
        setOutcome({ state: "ERROR" });
      }
    }
  })();
  return () => {
    cancelled = true;
  };
}
