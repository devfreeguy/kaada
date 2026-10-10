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

## Live validation (Build 9.1)

Quote-only throughout: only `POST /v2/rfq/preview` was called. No firm request, submit, cancel, signing or execution.
Amounts below are atomic units; the keys were never printed (only the public prefix).

### TEXTILE TEST environment (chain 97, BNB testnet, `tx_test_` key)

Auth succeeded (`Authorization: Bearer`), the response matched the Zod schema, and the 5 bps testnet fee matched the docs.

| Request                          | sellAmount        | takerPays         | feeAmount      | buyAmount                 | latency |
| -------------------------------- | ----------------- | ----------------- | -------------- | ------------------------- | ------- |
| exact-input 100 cNGN -> USDT     | 100000000         | 100000000         | 49975          | 73490754631875000         | 880 ms  |
| exact-output 0.05 USDT from cNGN | 68035768          | 68035768          | 34000          | 50000000000000000 (exact) | 611 ms  |
| exact-input 0.05 USDT -> cNGN    | 50000000000000000 | 50000000000000000 | 24987506246876 | 67954198                  | 241 ms  |
| exact-output 100 cNGN from USDT  | 73578971100000000 | 73578971100000000 | 36771100000000 | 100000000 (exact)         | 236 ms  |

**Base Sepolia (84532, cNGN <-> USDC) is documented but returned `400 invalid_request` / `corridor_unavailable`** for all
four requests. Docs and live differ; it mapped correctly to `PAIR_NOT_SUPPORTED`. Only chain 97 works as a sandbox.

### LIVE Celo (chain 42220, `tx_live_` key)

| Request                     | sellAmount           | takerPays            | feeAmount       | buyAmount                                          | latency |
| --------------------------- | -------------------- | -------------------- | --------------- | -------------------------------------------------- | ------- |
| exact-input 2 USDT -> wBRL  | 2000000              | 2000000              | 199             | 10037001222382469411                               | 700 ms  |
| exact-output 10 wBRL (USDT) | 1992627              | 1992627              | 199             | 10000000000000000000 (exact)                       | 254 ms  |
| exact-input 2 USDT -> USDC  | 2000000              | 2000000              | 199             | 1998182                                            | 259 ms  |
| exact-output 2 USDC (USDT)  | 2001800              | 2001800              | 200             | 2000000 (exact)                                    | 357 ms  |
| exact-input 10 wBRL -> USDT | 10000000000000000000 | 10000000000000000000 | 999900009999000 | 1991233                                            | 258 ms  |
| exact-input 2 USDC -> USDT  | -                    | -                    | -               | `no_quote` / `no_makers_online` (also on a repeat) | 261 ms  |
| direct USDC -> wBRL         | -                    | -                    | -               | HTTP 400 `invalid_request` (no corridor)           | -       |

- **Unsupported direct pair**: USDC -> wBRL is refused by Textile itself (400 `invalid_request`) and by Kaada's capability
  registry (`supportsPair` = false). It is not treated as a direct corridor; the planner reaches wBRL from USDC only
  through USDT.
- **Multi-hop through the real `RoutingService`** (plan only, nothing persisted): `wBRL -> USDT -> USDC` worked with two
  live previews: hop 1 in 10 wBRL, out 1.991193 USDT (fee 0.000999900009999 wBRL); hop 2 in 1.991193 USDT (exactly hop 1's
  output), out 1.989382 USDC (fee 0.000199 USDT); route fees kept per asset, never summed; the route expires with its
  earliest quote; `indicative`. `USDC -> USDT -> wBRL` could not be planned **because USDC -> USDT had no makers at the
  time** (live liquidity, not a code fault). Both directions are seeded as capabilities, so a seeded capability does not
  guarantee live liquidity: the planner correctly reports `ROUTING_UNAVAILABLE` and tries other paths.

### Answers to the open questions

1. **EXACT_INPUT**: `takerPays == sellAmount` in 3 of 3 live and 2 of 2 test samples. `sellAmount` behaved as the **exact
   debit**; Textile documents it as a cap `takerPays` never exceeds. Keep input = the requested amount and `takerPays`
   in metadata; tighten later only if a response ever shows less.
2. **EXACT_OUTPUT**: the returned `buyAmount` equalled the request exactly (live 2 of 2, test 2 of 2). `sellAmount ==
takerPays` in every sample, and **`takerPays` is the user's real, fee-inclusive debit**.
3. **`rateRay`**: a RAY (1e27) scaled **price of the non-USDT token in USDT, with a fixed orientation in both directions**
   (about 0.1992e27 USDT per wBRL in both USDT->wBRL and wBRL->USDT; about 1.0008e27 USDT per USDC). Applied to the net
   amount: selling the base token `buy = (takerPays - fee) x rate`; selling USDT `buy = (takerPays - fee) / rate`. It differs slightly
   between an exact-input and an exact-output quote of the same pair. It stays **metadata only**.
4. **Fee**: `feeAmount = floor(sellAmount x bps / (10000 + bps))` in every sample (live Celo 1 bps: 2000000 -> 199; test
   5 bps: 100000000 -> 49975), charged on the sell side and **contained in `takerPays`**. Kaada stores `fee = feeAmount` and never adds it
   to the input.
5. **Minimum size**: a preview did **not** return a 400 below the documented floors. On Celo, 0.01 USDT -> wBRL returned
   HTTP 200 `no_quote` / `no_valid_quote` (with `availableSellAmount`, about 94 thousand USDT of depth), and 1 USDT was
   quoted. The accepted minimum lies between 0.01 and 1 USDT; I did not narrow it further (no spam). On testnet, 1 cNGN
   (about $0.0007) was quoted and 1 atom gave `no_valid_quote`. A universal $1 minimum is **not** confirmed for preview.
6. **Rate limit**: headers `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds) on every
   response; no `Retry-After` was seen and the limit was never approached (about 15 preview calls).
7. **Schema differences**: none needed. Responses add the documented `routing {...}` and `availableSellAmount`, which the
   loose schemas ignore. Regression fixtures with these shapes are in `textile.test.ts`.

### Firm RFQ (`POST /v2/rfq/request`): what Build 10+ must provide (documented; none requested)

- **Request**: `chainId` (must match the key's environment), `sellToken`, `buyToken`, exactly one of `sellAmount` (exact
  input, a gross fee-inclusive spend cap) or `buyAmount` (exact output), and **`taker`** (required; the quote is bound to
  it). Optional: `preferredLiquidityWallets` / `restrictedLiquidityWallets` (max 10, mutually exclusive).
- **Auth**: with a partner API key (`Authorization: Bearer`) no `takerProof` is needed; without one, the first firm request
  needs `takerProof` (EIP-712 signature by the taker over `(taker, chainId, nonce, issuedAt)`, valid 12 h per wallet+chain).
  Scope `trades:write` for request/cancel/submit, `trades:read` for status.
- **Funding**: the taker must hold enough sell token, otherwise `400 invalid_request` with `details.reason:
insufficient_funds` (`required` / `available` / `committed`). **A funded taker wallet is required before a firm quote.**
- **Allowance**: the user approves `takerPays` of the sell token to the quote's `spender` (the OpenAPI notes it can differ
  from `reactor`), confirmed before the swap is sent; USDT-style tokens may need the allowance reset to 0 first. Whether
  Permit2 is part of the RFQ flow is **not stated** on the RFQ page (Permit2 is listed in the address book).
- **Response** (`status: quoted`): `rfqId` (`rfq_...`), `claimToken` (`rfqc_...`, **returned once**; authorises cancel/submit/status),
  `quote {sellAmount, buyAmount, feeAmount, takerPays, rateRay, expiresAt, orderDeadline, latestOrderDeadline, reactor,
spender, taker, encodedOrder, signature, orders[]}`, and `transactions {approval, swap}` (unsigned). Always broadcast
  `transactions.swap` (it may be an `executeBatch`), never the top-level `encodedOrder`.
- **Expiry**: `quote.expiresAt` is the accept cutoff (earliest maker cutoff; corridor cap 60 s). `orderDeadline` is when the
  signed order can no longer settle fully; `latestOrderDeadline` is when the reserved funds and the slot are released. After
  `expiresAt`, `/submit` is rejected.
- **Capacity**: 4 outstanding RFQs per key. A slot is held while a firm quote is live, **released immediately on `no_quote` or
  error, not released by cancelling or reporting a tx**, and frees at `latestOrderDeadline`. The cap returns `429` with no
  `Retry-After`. Firm requests can block about 70 s; use a 75 s client timeout. No partial fills.

### Recommended payment lifecycle

1. Conversational intent, deterministic intent state.
2. **Indicative preview** (`/v2/rfq/preview`): discovery and UX; no wallet, no reserved quote, safe to repeat (60/min).
3. Show the user an estimate, marked `indicative`.
4. The user continues; wallet and authorization are available.
5. **Only then** request the FIRM quote with the user's taker wallet (needs funding; consumes one of 4 slots).
6. Show the final firm summary (exact `takerPays` / max spend, `expiresAt`).
7. PIN authorization binds to that firm quote and its limits.
8. Approve if needed, sign and submit before `expiresAt`.

**Principle: never request firm quotes** while extracting an intent, to display an estimate, per keystroke, or when
retrying. Previews cover discovery; a firm quote is requested once, close to authorization, and a failed firm request is not
retried blindly. `PAYMENT_READY` built from a preview stays `indicative: true` and can never flow straight into
authorization or execution; it needs the firm step first. This matches the documented API behaviour; the product flow is
unchanged in code for now.
