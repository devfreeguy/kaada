/**
 * The path every executable payment must follow. The agent core stops at ROUTING_REQUIRED today;
 * later builds add the rest, and no step may be skipped: a route that is ready is NOT cleared to
 * execute. Spending needs a payment-specific authorization first (PIN, delegated signing).
 *
 * Quote-only intents never leave ROUTING_REQUIRED.
 */
export const PAYMENT_STAGES = [
  "ROUTING_REQUIRED",
  "PAYMENT_READY",
  "AUTHORIZATION_REQUIRED",
  "AUTHORIZED",
  "EXECUTING",
] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];

/** The only stage that may follow `stage`, or undefined at the end of the path. */
export function nextPaymentStage(stage: PaymentStage): PaymentStage | undefined {
  return PAYMENT_STAGES[PAYMENT_STAGES.indexOf(stage) + 1];
}
