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
  the user holds; the chain stores the address of the key derived from it), a current code from the user's **authenticator app** (TOTP,
  checked by Kaada before it submits anything) and a **delay** of at least 24 h enforced by the contract. Only the current root can
  **cancel**; there is no attestor, no veto, no registry and no KMS key. Kaada alone can never recover a wallet.
- **Device attestation** classifies where a device key lives (`TRUSTED_DEVICE`, `APP_ATTESTED_DEVICE`, `WEB_NON_EXTRACTABLE`,
  `UNKNOWN`) from server-verified evidence only.

## Trust boundaries and who can do what

| Actor                                            | Can                                                                                             | Cannot                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Kaada backend (relayer, bundler client)          | Deploy validator clones, send operations a root signed, top up gas within a cap                 | Sign for a root, move funds, start or finish a recovery on its own                                         |
| Recovery Code holder + authenticator app + email | Start a recovery through Kaada that still waits out the delay and can be cancelled by the root  | Skip the delay, avoid the notifications                                                                    |
| Recovery Code holder alone                       | Nothing on chain: `initiate` accepts only the recovery relayer                                  | Skip Kaada's email and authenticator checks, start a recovery                                              |
| Compromised Kaada backend / relayer              | Read the encrypted authenticator secrets, hold the relayer key, forward signatures it is handed | Produce the Recovery Code signature the contract requires (so it cannot recover a wallet); cancel anything |
| Current root                                     | Rotate, add a backup, cancel a pending recovery, install/replace the Recovery Code, set the PIN |                                                                                                            |
| Any client                                       | Present evidence and proofs                                                                     | Choose its own security tier; name a user, wallet or amount; read a PIN or Recovery Code back              |

## What is frozen

These are the MVP contract. Changing any of them needs a deliberate security review, a migration plan and new regression tests:

1. The root is exactly one of passkey or device key, behind the `RootCredential` / `RootProof` / `RootChallenge` abstraction. No new
   validator types, no new recovery contracts, no social recovery.
2. A validator instance is never reused (`validatorEverUsed`), and every root change uses a fresh deterministic clone.
3. Recovery: email code + Recovery Code proof + authenticator code + contract delay (≥ 24 h) + root cancel. One non-terminal attempt per
   wallet (partial unique index). No attestor, veto or registry exists, and nothing may reintroduce a server-held recovery key.
4. The PIN is exactly six digits, hashed with Argon2id, locked by the database, and confirms one payment only.
5. Security tiers are derived only from verified evidence on a native route; a tier never rises after the credential exists
   (`canChangeTier`). The web route refuses evidence outright.
6. Secrets: nothing sensitive in a URL path or query (setup tokens in the path are single-use and short-lived; recovery cancel
   tokens are in the URL **fragment**), the Recovery Code never leaves the browser, and logs redact tokens, PINs and codes.
7. Rate limits fail **closed**: unreachable Redis means a refused request, never an open door.

## Configuration: what is an environment variable and what is not

Environment variables hold **secrets and per-deployment facts** only (about 30, listed in `.env.example`). Everything else is code:

- `packages/config/src/settings.ts`: tunables and **security floors** (authorization lifetimes, the recovery delay, timeouts, intervals,
  the attestation policy, the Groq model). They are deliberately **not** overridable from the environment, so a typo in a deployment
  cannot weaken a floor. A change is a reviewed, tested diff.
- `packages/config/src/deployments.ts`: per-network contract addresses and recovery delays (public). `RECOVERY_NETWORK` selects one;
  recovery and device keys refuse to start on a network whose contracts are not listed.
- Derived from `NODE_ENV`, never configured: production never accepts Apple's sandbox attestation, never uses the file outbox, and
  needs Redis for wallets and recovery.

Production rules enforced at startup:

| Setting              | Rule                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`          | **Required** for wallets and recovery: every API instance shares the limits and they survive restarts. `rediss://` sets the TLS server name explicitly.                                                        |
| Authenticator key    | `RECOVERY_TOTP_SECRET_KEY` (32 random bytes, base64) is required when recovery is on, must differ from `EXECUTION_SECRET_KEY`, and rotates with `_VERSION` / `_PREVIOUS`. There is no KMS or attestor setting. |
| Recovery email       | `RECOVERY_SMTP_HOST/PORT/USER/PASSWORD_FILE/SECURITY` + `RECOVERY_EMAIL_FROM` (legacy `RECOVERY_SMTP_URL`, exclusive); TLS always required; the file outbox is refused.                                                                                                                                       |
| `TELEGRAM_BOT_TOKEN` | Optional. When set, linked Telegram identities get the same recovery alerts.                                                                                                                                   |
| Recovery delay       | Fixed floor of 24 h (the contract's own), in `deployments.ts`.                                                                                                                                                 |
| Key files            | The relayer key (gas only) must live outside the repository.                                                                                                                                                   |

## Chat channels

Telegram (and later other chats) is an adapter in front of the unchanged Agent Core: [channels.md](channels.md). The security
properties: webhooks need Telegram's secret header (constant time); buttons carry only an opaque 22-character handle bound to the
Telegram account, conversation, expiry and a single use; the **PIN is entered only on the secure browser page** and a six-digit chat
message is deleted and never stored; payments are handled in private chats only; the status dispatcher only observes and never
advances a payment.

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

Recovery **started, cancelled** and **completed** are sent to every linked channel by `RecoveryNotifier`: email always, Telegram
when a bot token is configured and the person linked Telegram. A failing channel is recorded (`recovery.notification_failed`) and never
blocks the other channels or the recovery. The start message is the only one carrying a link (the cancel link, in the URL
fragment). Subjects differ so the three events are distinguishable at a glance. SMTP rejects any recipient or subject with a line break
(header injection); Telegram errors never include the bot token.

## User interface

Minimal pages in `apps/web` (all `no-store`, `no-referrer`, not frameable, not indexed):

| Page                                                           | What it does                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/recovery`                                                    | Start recovery, verify the email code, create a new passkey or device key, enter the Recovery Code (checked locally against the on-chain verifier, signed locally), countdown while pending, prove the new credential, reset the PIN, create a new Recovery Code. The server's `nextStep` decides what is shown; the session token lives in this tab's `sessionStorage`. |
| `/recovery/cancel#token`                                       | "This was not me": cancel with the current root (the only way to stop a recovery). The token is moved from the fragment into memory and removed from the address bar immediately.                                                                                                                                                                                        |
| `/security/[token]`                                            | Voluntary root rotation, backup credential enrolment and a new Recovery Code, from a security link.                                                                                                                                                                                                                                                                      |
| `/setup/[token]`, `/root-action/[token]`, `/authorize/[token]` | Unchanged.                                                                                                                                                                                                                                                                                                                                                               |

The browser twins of server logic (`recovery-code.ts`, `device-key-id.ts`) are tested for **exact parity** with `@kaada/contracts`.
Honest limit: these pages are verified by type-checking, linting, a production build, unit tests of the cryptography and the HTTP
contract tests on the server side; they have **not** been exercised end to end in a real browser against a live chain.

## Security regression suite

`pnpm --filter @kaada/api test:security` runs the manifest in `apps/api/test/security/manifest.json` (passkey root,
device-key root, 6-digit PIN, delegated permission, recovery, cancellation, authenticator factor, root rotation, backup credential, replay
protection, restart and reconciliation, race conditions, rate limits, notifications, recovery signer boundary, device attestation).
`--integration` adds the real-database and real-Redis tests. `test/security-manifest.test.ts` fails if a listed file disappears or an
area becomes empty, so the suite cannot shrink silently. It is part of the normal `pnpm test` too.

## Remaining blockers (true ones only)

1. **The recovery contracts changed and are not deployed anywhere.** The new `KaadaRecoveryValidator` (single Recovery Code signature,
   no registry) must be deployed, listed in `deployments.ts` and re-proved on Celo Sepolia before recovery can start on any network.
2. **Real-device attestation** has not been validated on a physical Android device or iPhone (see device-attestation.md).
3. **The recovery and security pages have not been driven in a real browser against a live chain.**
4. **Native clients** (Android, iOS) that produce attestation evidence are not built.
