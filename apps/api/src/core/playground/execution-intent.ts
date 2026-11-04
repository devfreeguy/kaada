import type { Intent } from "@kaada/domain";

import { currencyByCode } from "../currency/catalog.js";
import type { AgentResponse, MoneyView } from "../responses/agent-response.js";

/*
 * What Kaada WOULD have done, written down instead of done.
 *
 * Every field here is copied from what the real pipeline produced for this turn: the stored intent row (which the coordinator
 * and the assessment filled in) and the agent's own structured response (which routing priced). Nothing is inferred, and a
 * detail the application did not establish is simply absent rather than guessed. Where a figure appears it is the provider's,
 * in exact smallest units, alongside the text the person was shown.
 *
 * It is produced only in the development playground, where the funding resolver is left out of routing, so no wallet, signing
 * or execution service took part in reaching it.
 */

export interface SimulatedAmount {
  /** Exact smallest-unit value, as the application holds it. */
  value: string;
  assetId: string;
  decimals: number;
  /** The same amount as the person was shown it. */
  display: string;
}

export interface SimulatedOperation {
  type: "swap" | "transfer";
  /** The currency each side is in, by ISO code where the asset stands for one; otherwise the token's symbol. */
  from?: string | undefined;
  to?: string | undefined;
  currency?: string | undefined;
  amount?: SimulatedAmount | undefined;
  recipient?: string | undefined;
}

export interface SimulatedExecutionIntent {
  intent: "payment" | "conversion";
  executionMode: "simulation";
  /** The stored intent this describes, so it can be matched against the database. */
  intentId: string;
  revision: number;
  recipient?: string | undefined;
  sourceCurrency?: string | undefined;
  targetCurrency?: string | undefined;
  senderSpends?: SimulatedAmount | undefined;
  recipientReceives?: SimulatedAmount | undefined;
  /** EXACT_INPUT: the sender's side is fixed. EXACT_OUTPUT: the recipient's side is. */
  amountMode?: string | undefined;
  operations: SimulatedOperation[];
  /** Why no operations could be listed, when the turn stopped before routing priced anything. */
  note?: string | undefined;
}

/** The ISO code an asset stands for, else its ticker. Display only. */
function currencyOf(view: MoneyView | undefined): string | undefined {
  if (!view) return undefined;
  return view.symbol;
}

function amountOf(view: MoneyView | undefined): SimulatedAmount | undefined {
  return view
    ? { value: view.amount, assetId: view.assetId, decimals: view.decimals, display: view.display }
    : undefined;
}

/**
 * Builds the event from a priced payment answer. `route.hops` are the provider's own steps, so a swap appears only when the
 * route really has one, and a same-currency payment is a plain transfer with no swap at all.
 */
export function buildSimulatedExecution(
  intent: Intent,
  response: AgentResponse,
): SimulatedExecutionIntent | null {
  if (intent.type !== "SEND" && intent.type !== "CONVERT") return null;

  const base: SimulatedExecutionIntent = {
    intent: intent.type === "SEND" ? "payment" : "conversion",
    executionMode: "simulation",
    intentId: intent.id,
    revision: intent.revision,
    operations: [],
  };
  if (intent.amount) base.amountMode = intent.amount.mode;

  // Priced and ready: the real route, its real figures, and the recipient the application resolved.
  if (response.type === "PAYMENT_READY") {
    const spends = response.senderSpends.expected;
    const receives = response.recipientReceives.expected;
    const operations: SimulatedOperation[] = response.route.hops.map((hop) => ({
      type: "swap" as const,
      from: hop.from,
      to: hop.to,
    }));
    operations.push({
      type: "transfer",
      ...(currencyOf(receives) && { currency: currencyOf(receives) }),
      amount: amountOf(receives),
      ...(response.recipient && { recipient: response.recipient }),
    });
    return {
      ...base,
      ...(response.recipient && { recipient: response.recipient }),
      ...(currencyOf(spends) && { sourceCurrency: currencyOf(spends) }),
      ...(currencyOf(receives) && { targetCurrency: currencyOf(receives) }),
      senderSpends: amountOf(spends),
      recipientReceives: amountOf(receives),
      operations,
    };
  }

  // Understood but not priced (a detail is still missing, or routing could not price it). Say so rather than invent a route.
  const missing = intent.missingFields.length > 0 ? intent.missingFields.join(", ") : undefined;
  return {
    ...base,
    note: missing
      ? `not priced: the application is still missing ${missing}`
      : `not priced: the turn ended with ${response.type}`,
  };
}

/** The sentence the playground shows under a simulated payment. It never claims anything was sent. */
export function describeSimulation(event: SimulatedExecutionIntent): string {
  if (event.operations.length === 0) {
    return "No transaction was executed: the playground never runs payments.";
  }
  const swaps = event.operations.filter((operation) => operation.type === "swap");
  const transfer = event.operations.find((operation) => operation.type === "transfer");
  const target = currencyByCode(event.targetCurrency)?.name ?? event.targetCurrency;
  const parts: string[] = [];
  if (swaps.length > 0 && target) parts.push(`convert the required amount into ${target}`);
  if (transfer?.amount) {
    parts.push(
      `send ${transfer.amount.display}${transfer.recipient ? ` to ${transfer.recipient}` : ""}`,
    );
  }
  return parts.length > 0
    ? `I would ${parts.join(", then ")}. No transaction was executed in this playground.`
    : "No transaction was executed in this playground.";
}
