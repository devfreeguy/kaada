# Firm quote and pre-signing execution plan (Build 12)

```
PAYMENT_READY (indicative) -> AUTHORIZATION_REQUIRED -> PIN -> PaymentAuthorization ACTIVE
  -> ONE firm Textile quote -> FirmQuote -> FirmExecutionCandidate -> checked against the authorization
  -> account / permission / allowance requirements -> ExecutionPlan -> Execution READY      (STOP)
```

Nothing in this stage signs, broadcasts, deploys, approves, submits an order, or consumes the authorization. A
failed signing in the next build must not burn the person's approval, so `validate` (read) and `consume` (take) are
separate; planning only validates.

## Guards before the provider is called

Authorization ACTIVE and unexpired; intent revision, recipient, route and wallet still match (checked by the same pure
policy, with the authorized limits standing in for the price, so a changed payment never costs a slot); single-hop
route; Kaada's own count of held provider slots; a **fresh** chain balance covering the authorized ceiling (EXACT_INPUT:
the authorized input; EXACT_OUTPUT: the **maximum** input). The attempt is recorded first and a database index allows
one live attempt per authorization and provider, so duplicate deliveries and concurrent processes make one call.

## Outcomes (never "sent", never "paid")

`EXECUTION_READY` ("Payment authorized and final pricing confirmed.") - `EXECUTION_BLOCKED` (the plan found something to
review) - `REAUTHORIZATION_REQUIRED` (price outside the limits, or the approval is no longer valid; the authorization is
left untouched) - `FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY` (< `FIRM_QUOTE_MIN_WINDOW_SECONDS`, default 12 s, no automatic retry)

- `FINAL_PRICE_UNAVAILABLE` - `PROVIDER_CAPACITY_REACHED` - `INSUFFICIENT_BALANCE` - `EXECUTION_ROUTE_UNSUPPORTED`.

A better price than the estimate is accepted without another PIN.

## The plan

Account (deployment required? root signature required? passkey available? RPC / bundler configured?), permission (an
**installed** ACTIVE permission that covers this payment, or INSTALLATION_REQUIRED - a PENDING record is never
authority), token approval (allowance read from the chain, required vs current, USDT reset-to-zero), the swap
(provider quote id, target, expiry) and which key signs each step: `ROOT_PASSKEY` for deployment and permission
installation, `DELEGATED_SIGNER` for the payment itself. The permission scope is exactly this payment: Celo, the sell
token (if an approval is needed) and the swap target, the two operations, one asset, a per-transaction limit never above
the authorized maximum, and a 15-minute window.

## MVP restriction: single-hop execution only

Indicative routing still finds two-hop routes (USDC -> USDT -> wBRL), but they are **not executable**:
`EXECUTION_ROUTE_UNSUPPORTED`, before any provider call. Two hops would need two firm quotes (two slots, doubled expiry
pressure) with no atomicity between them, so hop 1 could settle and hop 2 fail.

## For Build 13

Consume the authorization atomically with execution; request the bundler and deploy / install the permission with the
passkey; sign the approval and swap with the delegated signer; submit with the stored claim token; track settlement.
