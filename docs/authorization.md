# PIN and payment authorization (Build 11)

Authentication proves who the user is. **Authorization** proves what they approved. A **delegated permission**
defines what Kaada can technically execute. All three must agree before funds move. This build is the middle one.

## The PIN

- Exactly four digits (0000-9999, weak-looking ones allowed). A convenience approval: not a wallet key, not an
  encryption key, not a recovery credential, and it cannot change account security settings.
- Stored only as an Argon2id hash (`@node-rs/argon2`: 64 MiB, 3 passes, 1 lane), mixed with an optional server-side
  `PIN_PEPPER` (required in production) so a leaked database alone cannot be brute-forced offline.
- Setting or changing it needs a fresh **passkey assertion** (`/api/v1/wallet/pin/*`) on top of the setup link.
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
  - Immutable, 3 minutes by default, single-use (`consume` is one conditional UPDATE), one ACTIVE per intent.
- A revised intent, or a new route for the same revision, cancels pending sessions and revokes approvals (history kept).
- `validateExecutionAgainstAuthorization` (pure, domain values only) lists every reason an execution does not fit.

## Not built

Textile firm RFQ, execution, signing, token approvals, delegated keys, Telegram/WhatsApp, email/passkey recovery.
