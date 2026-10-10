# Textile RFQ adapter (Build 9)

Kaada prices Celo routes with Textile's RFQ API. **Quote only**: nothing here submits, cancels, executes
or signs, and there is no wallet. Source of truth: https://fx-docs.textilecredit.com (RFQ endpoints,
Authentication, Errors & limits, Fees, Testnet, Address book, `openapi-v2.json`).

## Environments are not networks

Textile has two API **environments**, separate from the blockchain **network**:

| Environment | Key           | Reaches                                                                | Kaada use                     |
| ----------- | ------------- | ---------------------------------------------------------------------- | ----------------------------- |
| `live`      | `tx_live_...` | mainnet corridors, including **Celo 42220**                            | the real adapter              |
| `test`      | `tx_test_...` | **only** BNB testnet (97) cNGN/USDT and Base Sepolia (84532) cNGN/USDC | the sandbox smoke script only |

Textile has **no Celo testnet deployment**. A test key sent with chain 42220 is a `400`, so the app refuses
`TEXTILE_ENV=test` in every `NODE_ENV` (Kaada settles on Celo). There is no automatic fallback between
environments, and no fallback to the mock.

## Configuration

```
FX_PROVIDER=textile            # none | mock | textile. mock is rejected in production.
TEXTILE_ENV=live               # required with textile; no default
TEXTILE_LIVE_API_KEY=tx_live_...   # required for live; must start tx_live_
TEXTILE_TEST_API_KEY=tx_test_...   # sandbox smoke script only
TEXTILE_API_URL=https://api.textilecredit.com   # host only; the client adds /v2/rfq/...
TEXTILE_TIMEOUT_MS=8000        # indicative quotes (firm quotes can block ~75 s; not used yet)
CELO_NETWORK=mainnet
CELO_CHAIN_ID=42220
```

Config validation fails with a `ConfigError` (never echoing a key) when: `FX_PROVIDER=textile` without
`TEXTILE_ENV`; `TEXTILE_ENV=live` without a `tx_live_` key; `TEXTILE_ENV=test` (cannot quote Celo); a
chain other than 42220. `loadTextileCredentials("test" | "live")` serves tools like the smoke script and
selects exactly the requested environment's key.

## What is implemented

Under `apps/api/src/infrastructure/fx/textile/`:

- `transport.ts`: the only HTTP code. `Authorization: Bearer <key>` (one consistent mechanism; the docs also
  allow `X-API-Key`). Timeout via `AbortController`. Errors never contain the key or URL.
- `schemas.ts`: Zod schemas for the documented fields only; `looseObject`, so unknown fields are ignored and
  never copied into a Kaada type.
- `client.ts`: builds the body, validates the response, normalises failures, retries conservatively. It
  has no method for submit, cancel, order or swap.
- `textile-fx-provider.ts`: implements `FxProvider` (id `textile`). `supports()` and `quote()` are real;
  `execute()` and `status()` reject with `EXECUTION_NOT_ENABLED`.
- `sandbox.ts`: the BNB-testnet and Base-Sepolia token table (separate from the Celo asset seed) and
  `assertChainForEnvironment`.

`RoutePlanner` is unchanged: it sees an ordinary `FxProvider`.

## Request mapping (documented)

`POST {base}/v2/rfq/preview`, JSON body:

| Kaada                | Textile field                                                |
| -------------------- | ------------------------------------------------------------ |
| EXACT_INPUT amount   | `sellAmount` (atomic units, exact-input spend cap)           |
| EXACT_OUTPUT amount  | `buyAmount` (atomic units, exact output)                     |
| input / output asset | `sellToken` / `buyToken` (addresses from the Asset registry) |
| chain                | `chainId` = 42220 (hard-coded for this provider)             |

Exactly one of `sellAmount`/`buyAmount` is sent. Amounts are canonical integer strings validated before any
request; fiat, inactive, non-Celo and identical assets are rejected locally.

## Response normalisation

Documented preview fields: `status` (`preview` | `no_quote`), `sellAmount`, `buyAmount`, `feeAmount`,
`takerPays`, `rateRay`. Mapping to `FxQuote`:

- **Fee**: `takerPays` is the gross, fee-inclusive debit and `feeAmount` is **contained in it** (documented),
  and `buyAmount` is net. Kaada stores `fee = feeAmount` (sell asset) and never adds it on top of the input, so
  there is no double counting. The 1 bps Celo protocol fee is not injected anywhere; Textile's own figure is used.
- **EXACT_INPUT**: `input` = the requested cap; `output` = `buyAmount`. Textile calls `sellAmount` a cap and says
  `takerPays` is never more than it (it can differ by the odd atomic unit); that real debit is kept in metadata.
  A `takerPays` above the cap is rejected.
- **EXACT_OUTPUT**: `output` must equal the requested `buyAmount`; `input` = `takerPays`.
- **Not provided, so not invented**: slippage (`slippageBps` is absent), a quote id (`providerQuoteId` is
  absent), and an expiry.
- Failures: `400` corridor unavailable -> `PAIR_NOT_SUPPORTED`; other `400` and `no_quote` ->
  `NO_ROUTE_AVAILABLE`; timeouts, 429, 5xx, 401/403, malformed or mismatched responses ->
  `PROVIDER_UNAVAILABLE`. The planner continues with other paths and providers. No provider text reaches a user.

## Retries

At most one retry (hard cap two), only for: a timeout/network error, the documented transient 500/502/503, and
a `429` that carries a `Retry-After` of at most 2 s. Never retried: `400`, `401`, `403`, `404`, `409`, a `429`
without `Retry-After` (the outstanding-RFQ cap), and a `2xx` that fails the schema.

## Safety

The key is only ever in the `Authorization` header. Logs carry provider, pair, mode, latency, HTTP status,
attempts and Textile's request id, never a header, key or payload. Stored quotes keep only
`{source, indicative, expiryBasis, takerPays, rateRay, adapter}`: no calldata, signatures, claim tokens or
credentials.

## Open points that need live confirmation (Build 9B)

1. **A preview is not a firm quote.** `/v2/rfq/request` (firm) requires a `taker` wallet that holds the sell
   token (`insufficient_funds` otherwise), and each live firm quote holds one of 4 outstanding-RFQ slots per
   key until its order deadline (cancelling does not free it). Without a wallet, routing can only use previews:
   indicative prices, flagged `indicative: true` and worded that way in `PAYMENT_READY` / `QUOTE_RESULT`.
   Firm quotes belong to the wallet/authorization build. The client already has a validated `requestFirm`
   (documented `expiresAt`, `rfqId`) that nothing calls yet.
2. **Expiry**: a preview documents none. Kaada's 10 s freshness window (`DEFAULT_INDICATIVE_WINDOW_MS`) is its
   own policy, recorded as `expiryBasis: kaada-indicative-window`. A firm quote's `expiresAt` ("accept cutoff")
   is real and replaces it later.
3. **Quote id**: none on a preview; `rfqId` exists on firm quotes.
4. **Slippage**: no field; absent.
5. **EXACT_INPUT `takerPays` vs `sellAmount`**: documented as "never more than"; whether a preview can return
   less (rounding) is unverified live.
6. **`rateRay`** unit is undefined in the docs; stored for audit only, never used in arithmetic.
7. **Minimum size** (about $1 of notional on mainnet) and the real request rate limit (60/min per key) shape
   how many quotes a plan may request; routing memoises identical requests within a plan.
8. Whether Celo corridors accept every documented direction for `preview` as for `request`.

## Smoke script

`pnpm --filter @kaada/api smoke:textile -- --env=test` (sandbox chains 97 / 84532, cNGN <-> USDT / USDC) or
`-- --env=live --confirm-live` (Celo; optional `--routing` plans USDC -> USDT -> wBRL without persisting). The
environment is explicit and there is no default. With no credentials it prints
"Textile credentials are not configured. Live smoke test skipped." and exits 2 (never fakes success).

## Not implemented

Firm quotes in routing, `submit` / `cancel` / `GET status`, approvals, signing, wallets, settlement, webhooks.
