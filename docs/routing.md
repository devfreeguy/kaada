# Routing (Build 8)

Kaada can now turn a ready request into a priced route, using **mock pricing only**. No live provider,
no authorization, no execution, no wallet balances.

> **MOCK / TEST / DEVELOPMENT.** Every rate, fee and slippage figure in this build is a made-up fixture.
> They say nothing about real prices or about Textile's terms. `FX_PROVIDER=mock` is rejected when
> `NODE_ENV=production` (config validation, and again in `createRoutingService`).

## Pipeline

```
RoutingRequest (Build 6)
  -> RoutingCandidateResolver (Build 7, maxHops = 2)     which assets / providers may be considered
  -> RoutePlanner                                         enumerate, price, validate, rank
  -> RoutingService.commit                                persist Quote / Route / RouteStep
  -> PAYMENT_READY | QUOTE_RESULT | ERROR
```

`AgentService` calls `RoutingService` after a turn ends in `ROUTING_REQUIRED` and `FX_PROVIDER` is not
`none`. Pricing runs **outside any transaction** (like the interpreter); the write is one short locked
transaction. The understood-request answer (`ROUTING_REQUIRED`) stays in the history and the priced answer
follows it as a second assistant message. If pricing itself breaks, the turn keeps the `ROUTING_REQUIRED`
answer. With `FX_PROVIDER=none` (the default) the agent behaves exactly as before.

## Rounding policy

All money arithmetic is BigInt (`packages/domain/src/money/rounding.ts`). Rates are exact rationals
(`numerator / denominator`, human units). The rule always favours the user, never a rounding error:

|                 | fixed side                           | rounded side                                          |
| --------------- | ------------------------------------ | ----------------------------------------------------- |
| EXACT_INPUT     | the input is exactly what was asked  | the **output is rounded DOWN** to a smallest unit     |
| EXACT_OUTPUT    | the output is exactly what was asked | the **required input is rounded UP** (and is minimal) |
| fees, max spend | rounded UP                           | minimum receive is rounded DOWN                       |

A fiat amount (R$500) is re-expressed at the settlement token's precision at par (that is what a
settlement asset's `fiatCode` metadata means): exact when precision grows, toward the user when it shrinks.

## Mock FX provider

`MockFxProvider` (`apps/api/src/infrastructure/fx/mock-fx-provider.ts`) implements `FxProvider` over fixtures
for the ten verified directions (USDT <-> wBRL, wARS, cNGN, IDRX, USDC; each direction its own rate). It
takes a fee of the input (basis points, rounded up), reports slippage, and quotes for 30 s (configurable).
It never executes. It reports id `mock-textile`, stored under an **inactive** `mock-textile` Provider row
(dev seed only), so nothing it prices is mistaken for a real Textile quote. Capabilities stay under
`textile`; `createFxProviderDirectory` maps a capability provider to the adapter that prices it.

## Planner

- **Search**: for each candidate source/destination pair, every simple path of 1 or 2 provider steps
  (`MAX_ROUTE_HOPS = 2`), each step with every provider that has `QUOTE`, `SWAP` and the amount mode.
  No asset repeats, so no cycles; a third step is never tried. `USDC -> USDT -> wBRL` is found this way.
- **Pricing**: EXACT_INPUT chains forward, EXACT_OUTPUT chains backward from the fixed output. Identical
  quote requests are priced once per plan.
- **Providers failing**: a failed step drops only that path; other providers/paths continue. If nothing
  priced: `PROVIDER_UNAVAILABLE` (nothing reachable) or `QUOTE_FAILED` (answered but unusable).
- **Validation** (`checkQuote`, `validatePlannedRoute`): Celo, active assets, contiguous steps, no repeated
  asset, at most 2 hops, quotes unexpired and exact on the fixed side, source preference and destination
  respected, slippage within the request's limit, candidate set bound to the same intent revision.
- **Ranking** (deterministic, no model): fixed-side first (EXACT_INPUT: highest output; EXACT_OUTPUT: lowest
  input, compared at par across assets of the same currency), then lower fees (per currency, never summing
  different assets), then fewer hops, then lower slippage, then a stable key. The first criterion is strict:
  a genuinely better two-step route beats a direct one; an equal one loses on hop count.

## Responses

- `PAYMENT_READY`: `senderSpends {expected, max}`, `recipientReceives {expected, min}`, fees per asset,
  slippage, `expiresAt`, route hops, `routeId`, `revision`. EXACT_INPUT: spend is exact, receive has a
  minimum. EXACT_OUTPUT: receive is exact, spend has a maximum. **This is not an authorization.**
- `QUOTE_RESULT`: informational (`source`, `destination`, fees, expiry). A QUOTE is never `PAYMENT_READY`
  and never becomes executable.
- `ERROR` with `ROUTING_UNSUPPORTED` (assets or providers not supported), `NO_ROUTE`, `ROUTING_UNAVAILABLE`
  or `ROUTING_STALE` (the request changed while it was being priced; the prices are discarded).

Mock prices are marked `mock: true` and say so in the text.

## Persistence and revisions

Quotes and routes carry `intentRevision` (migration `20261012000000_quote_route_intent_revision`; checked
`>= 1`, no default). Only the winning route and its quotes are stored. Quotes are immutable. When an
intent's financial details change, the `onIntentRevised` hook marks routes of older revisions `INVALID`
(`RouteRepository.invalidateOlderThan`); rows stay as history. `assertRouteUsable` also rejects a route of
another revision, an invalidated route, or an expired one, so nothing depends on the status alone.

Reuse: a stored `VALID` route for the same revision whose quotes are all unexpired is returned as is (no new
quote requests, no new rows); otherwise the request is re-priced. `commit` re-checks that the intent is still
at the planned revision and `RESOLVED` before writing anything.

## Not here

Live Textile, real rates, wallet balances (the planner never assumes the user can afford a candidate),
authorization, signing, execution.
