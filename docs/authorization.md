# PIN and payment authorization (Build 11)

Authentication proves who the user is. **Authorization** proves what they approved. A **delegated permission**
defines what Kaada can technically execute. All three must agree before funds move. This build is the middle one.

## The PIN

- Exactly six digits (000000-999999, weak-looking ones allowed). The PIN was four digits in earlier development builds;
  migration `20261020000000_pin_six_digits` deleted every four-digit hash (non-production wallets only), so a person creates a
  six-digit PIN again and a four-digit value is rejected by format before any hash is read. No hash records its length and
  nothing accepts both lengths. A convenience approval: not a wallet key, not an
  encryption key, not a recovery credential, and it cannot change account security settings.
- Stored only as an Argon2id hash (`@node-rs/argon2`: 64 MiB, 3 passes, 1 lane), mixed with an optional server-side
  `PIN_PEPPER` (required in production) so a leaked database alone cannot be brute-forced offline.
- Setting or changing it needs a fresh proof by the wallet's **root** (`/api/v1/wallet/pin/*`) on top of the setup link: a passkey
  assertion with user verification, or, for a device-key wallet, a signature by the device key over a single-use challenge
  (see `docs/root-agnostic-flow.md`). The PIN is never a wallet key and never an input to the root.
  The old PIN alone never changes the PIN. Forgot PIN: `PIN_RESET_REQUIRED`, unsupported until account recovery.

## Lockout (per user, in the database)

3 wrong guesses lock the PIN for 5 min, then 15 min, then 1 h (repeating). An attempt is **reserved before** the hash
is compared, in one atomic UPDATE, so parallel guesses cannot exceed the budget. A correct PIN clears the ladder.
A new session cannot dodge a lock. HTTP throttling (per link and per address) is a second line of defence only.

## Sessions and approvals

- `AuthorizationSession` = the UI interaction. Created (idempotently) when a payment is priced; the secure link
  `/authorize/<token>` is issued later by the channel (`issueLink`), only its SHA-256 is stored, and the
  `AUTHORIZATION_REQUIRED` response carries a session reference, never a link.
- `PaymentAuthorization` = the durable record of what was approved, created when the PIN is verified:
  - EXACT_INPUT: spend at most `authorizedInput`, receive at least `minimumOutput`.
  - EXACT_OUTPUT: receive at least `exactOutput`, spend at most `maximumInput`.
  - Bound to user, wallet, chain, intent revision, route id, recipient, assets and the asset path/providers. Not to a
    provider quote: it survives indicative -> firm so long as the firm price fits the bounds.
  - Immutable, 10 minutes by default (`PAYMENT_AUTHORIZATION_TTL_SECONDS`, 30-600 s; a real first-time wallet setup on a browser needs more than the old 3), single-use (`consume` is one conditional UPDATE), one ACTIVE per intent.
- A revised intent, or a new route for the same revision, cancels pending sessions and revokes approvals (history kept).
- `validateExecutionAgainstAuthorization` (pure, domain values only) lists every reason an execution does not fit.

## Not built

Textile firm RFQ, execution, signing, token approvals, delegated keys, Telegram/WhatsApp, email/passkey recovery.

## Consumption (Build 13)

The authorization is consumed in the same database transaction that takes the execution lock (`READY -> SIGNING`), after
every precondition was re-checked, and **not before**: not on quote, plan, account deployment or permission install. A
failure after that point keeps it consumed. See `docs/execution.md`.
