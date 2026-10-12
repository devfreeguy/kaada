# Wallet and security architecture (frozen for the MVP)

This is the reference for what protects a Kaada wallet and what may no longer change without a security review. It ties
together the pieces documented in detail elsewhere: [wallet-architecture](wallet-architecture.md),
[root-agnostic-flow](root-agnostic-flow.md), [recovery-contracts](recovery-contracts.md),
[recovery-orchestration](recovery-orchestration.md), [device-attestation](device-attestation.md) and
[authorization](authorization.md).

## The model in one page

- **The wallet** is a ZeroDev Kernel v3.3 smart account (EntryPoint 0.7) on Celo. Kaada never holds a key that can move funds.
- **The root** is the one credential that controls the account: a passkey (WebAuthn P-256) **or** a device key (raw P-256 through
  `KaadaDeviceKeyValidator`, RIP-7212). Both are fresh validator clones per credential; a validator instance is never reused.
- **The delegated permission** is Kaada's restricted session signer: it can only pay what a PIN-confirmed `PaymentAuthorization`
  allows (asset, recipient, amount, expiry). It is installed and removed by the root, never by Kaada alone.
- **The 6-digit PIN** confirms one payment. It is Argon2id-hashed, locks after three wrong guesses (in the database, not in memory)
  and is never a way into the wallet.
- **Recovery** moves the root to a new credential. It needs the registered email, the **Recovery Code** (a 130-bit secret that only
  the user holds; the chain stores the address of the key derived from it) and a **delay** of at least 24 h enforced by the contract.
  The current root can **cancel**; Kaada security can **veto** (the attestor can only stop, never approve or complete).
- **Device attestation** classifies where a device key lives (`TRUSTED_DEVICE`, `APP_ATTESTED_DEVICE`, `WEB_NON_EXTRACTABLE`,
  `UNKNOWN`) from server-verified evidence only.

## Trust boundaries and who can do what

| Actor                                   | Can                                                                                             | Cannot                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Kaada backend (relayer, bundler client) | Deploy validator clones, send operations a root signed, top up gas within a cap                 | Sign for a root, move funds, start or finish a recovery on its own                            |
| Attestor                                | Sign the typed `Initiate` of one validator on one chain; send `attestorCancel`                  | Sign bytes, transactions, payments, UserOperations; approve or complete a recovery            |
| Attestor key holder                     | File key (**development and tests only**) or a KMS/HSM signer through `AttestorSigner`          | Production refuses a file key at startup                                                      |
| Recovery Code holder + email            | Start a recovery that still waits out the delay and can be cancelled or vetoed                  | Skip the delay, avoid the notifications                                                       |
| Current root                            | Rotate, add a backup, cancel a pending recovery, install/replace the Recovery Code, set the PIN |                                                                                               |
| Any client                              | Present evidence and proofs                                                                     | Choose its own security tier; name a user, wallet or amount; read a PIN or Recovery Code back |

## What is frozen

These are the MVP contract. Changing any of them needs a deliberate security review, a migration plan and new regression tests:

1. The root is exactly one of passkey or device key, behind the `RootCredential` / `RootProof` / `RootChallenge` abstraction. No new
   validator types, no new recovery contracts, no social recovery.
2. A validator instance is never reused (`validatorEverUsed`), and every root change uses a fresh deterministic clone.
3. Recovery: email code + Recovery Code proof + contract delay (≥ 24 h) + root cancel + attestor veto. One non-terminal attempt per
   wallet (partial unique index). The attestor surface stays at `signInitiate` and `veto`.
4. The PIN is exactly six digits, hashed with Argon2id, locked by the database, and confirms one payment only.
5. Security tiers are derived only from verified evidence on a native route; a tier never rises after the credential exists
   (`canChangeTier`). The web route refuses evidence outright.
6. Secrets: nothing sensitive in a URL path or query (setup tokens in the path are single-use and short-lived; recovery cancel
   tokens are in the URL **fragment**), the Recovery Code never leaves the browser, and logs redact tokens, PINs and codes.
7. Rate limits fail **closed**: unreachable Redis means a refused request, never an open door.

## Production requirements (enforced at startup)

| Setting                      | Rule                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIS_URL`                  | **Required** in production for wallets and recovery: every API instance shares the same limits and they survive restarts. `rediss://` sets the TLS server name explicitly (managed Redis routes by SNI).                                                                       |
| `RECOVERY_ATTESTOR_SIGNER`   | `kms` in production; the file signer is refused. `RECOVERY_ATTESTOR_KMS_KEY_ID` names the key; the deployment installs the adapter through the `ATTESTOR_SIGNER_FACTORY` provider (built on `createExternalSigner`). With `kms` and no adapter the process **does not start**. |
| `RECOVERY_EMAIL_PROVIDER`    | `smtp` (`RECOVERY_SMTP_URL`, `RECOVERY_EMAIL_FROM`); the file outbox is refused in production.                                                                                                                                                                                 |
| `TELEGRAM_BOT_TOKEN`         | Optional. When set, linked Telegram identities get the same recovery alerts.                                                                                                                                                                                                   |
| `RECOVERY_MIN_DELAY_SECONDS` | Never below 24 h (the contract floor).                                                                                                                                                                                                                                         |
| Key files                    | Relayer and (dev) attestor keys must live outside the repository.                                                                                                                                                                                                              |

## Rate limits

Redis fixed windows (`RedisRateLimiter`, one atomic Lua script: `INCR` + `PEXPIRE`, with a TTL guard so a key can never live forever).

| Limiter                                                                     | Limit              |
| --------------------------------------------------------------------------- | ------------------ |
| `recovery:start` (per email hash)                                           | 5 / hour           |
| `recovery:ip`                                                               | 20 / hour          |
| `recovery:step` (resend, verify, proof, root steps; per session or attempt) | 30 / 10 min        |
| `authorization:token`, `authorization:address` (PIN endpoint)               | 12 / min, 30 / min |

These are a second line of defence. The authoritative controls are in the database: the PIN lockout, one-time email codes with an
attempt budget, one active recovery per wallet, and the contract's own checks.

## Notifications

Recovery **started, cancelled, vetoed** and **completed** are sent to every linked channel by `RecoveryNotifier`: email always, Telegram
when a bot token is configured and the person linked Telegram. A failing channel is recorded (`recovery.notification_failed`) and never
blocks the other channels or the recovery. The start message is the only one carrying a link (the "this was not me" link, in the URL
fragment). Subjects differ so the four events are distinguishable at a glance. SMTP rejects any recipient or subject with a line break
(header injection); Telegram errors never include the bot token.

## User interface

Minimal pages in `apps/web` (all `no-store`, `no-referrer`, not frameable, not indexed):

| Page                                                           | What it does                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/recovery`                                                    | Start recovery, verify the email code, create a new passkey or device key, enter the Recovery Code (checked locally against the on-chain verifier, signed locally), countdown while pending, prove the new credential, reset the PIN, create a new Recovery Code. The server's `nextStep` decides what is shown; the session token lives in this tab's `sessionStorage`. |
| `/recovery/report#token`                                       | "This was not me": report (Kaada security vetoes) or cancel with the current root. The token is moved from the fragment into memory and removed from the address bar immediately.                                                                                                                                                                                        |
| `/security/[token]`                                            | Voluntary root rotation, backup credential enrolment and a new Recovery Code, from a security link.                                                                                                                                                                                                                                                                      |
| `/setup/[token]`, `/root-action/[token]`, `/authorize/[token]` | Unchanged.                                                                                                                                                                                                                                                                                                                                                               |

The browser twins of server logic (`recovery-code.ts`, `device-key-id.ts`) are tested for **exact parity** with `@kaada/contracts`.
Honest limit: these pages are verified by type-checking, linting, a production build, unit tests of the cryptography and the HTTP
contract tests on the server side; they have **not** been exercised end to end in a real browser against a live chain.

## Security regression suite

`pnpm --filter @kaada/api test:security` runs the manifest in `apps/api/test/security/manifest.json` (16 areas: passkey root,
device-key root, 6-digit PIN, delegated permission, recovery, cancellation, attestor veto, root rotation, backup credential, replay
protection, restart and reconciliation, race conditions, rate limits, notifications, attestor signer, device attestation).
`--integration` adds the real-database and real-Redis tests. `test/security-manifest.test.ts` fails if a listed file disappears or an
area becomes empty, so the suite cannot shrink silently. It is part of the normal `pnpm test` too.

## Remaining blockers (true ones only)

1. **A production KMS/HSM attestor adapter does not exist yet.** The interface, the digest-signing wrapper and the startup refusal are
   done and tested; a deployment must supply the cloud adapter (`DigestSigningService`) before production recovery can start.
2. **Real-device attestation** has not been validated on a physical Android device or iPhone (see device-attestation.md).
3. **The recovery and security pages have not been driven in a real browser against a live chain.**
4. **Native clients** (Android, iOS) that produce attestation evidence are not built.
