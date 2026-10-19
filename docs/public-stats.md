# Public totals for the marketing page

`GET /api/v1/stats/public` returns the totals a landing page may show. It is the only public, unauthenticated read in the API.

```json
{
  "completedPayments": 128,
  "volume": [
    { "currency": "NGN", "amount": "4200000", "payments": 71 },
    { "currency": "USD", "amount": "9800", "payments": 40 }
  ],
  "updatedAt": "2026-10-20T12:00:00.000Z"
}
```

## What makes it safe to publish

- **Aggregate only.** The body is these three fields and nothing else: no user, wallet, recipient, payment id or individual amount. It takes no
  input (a query string or header changes nothing), so there is nothing to probe.
- **Whole units, rounded down.** An exact amount is never published.
- **Small groups are withheld.** A currency appears in `volume` only when at least 5 payments make it up, so one person's payment cannot be
  read from it. Those payments still count in `completedPayments`.
- **Completed means settled.** Only payments whose execution reached `COMPLETED` with a recorded settled amount count; pending, failed and
  refused payments never do.
- **Currencies are not added together.** That needs an exchange rate, and a wrong rate on a public page is worse than none. Tokens of one
  currency are one line (USDT and USDC are both `USD`); a coin that is not a currency (CELO) is listed by its symbol. A single dollar figure
  needs an agreed rate source (see below).
- **It cannot load the database.** The answer is computed at most once per 5 minutes (concurrent callers share one read), the response carries
  `Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=600` so browsers and a CDN absorb the traffic, and each address is
  limited to 60 requests a minute. If a refresh fails, the last good answer is served and `public_stats.compute_failed` is logged; with nothing
  to serve the endpoint answers `503` with no detail.

## Using it

From the web app (same origin, through the runtime proxy), in a server component:

```ts
const response = await fetch(`${process.env.API_URL}/api/v1/stats/public`, { next: { revalidate: 300 } });
const stats = response.ok ? await response.json() : null; // show nothing when it is unavailable
```

From a different site, the browser needs CORS: add that site's origin to `CORS_ORIGINS` on the API.

## If you want one dollar total

Add it deliberately: pick a rate source, convert each currency at the time of display (not at the time of payment), say it is approximate, and
publish it only from the server (never convert in the browser). Until then the page can show the count and one currency's total.
