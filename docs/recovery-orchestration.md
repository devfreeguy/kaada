# Account recovery orchestration

The backend that turns the validated recovery contracts (see `docs/recovery-contracts.md`) into Kaada's real flow. Everything below
runs in `apps/api` over `@kaada/domain` ports, with the chain behind `RecoveryChainPort` (`@kaada/blockchain`). There is no attestor, no
KMS signer and no registry: Kaada holds no key that can start, approve, veto or complete a recovery.

## The model (locked)

| Concern         | Rule                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login           | email / channel identity                                                                                                                                                                        |
| Normal payments | PIN creates a `PaymentAuthorization` only; it is never a wallet or root key                                                                                                                     |
| Root            | a passkey validator clone, or a `KaadaDeviceKeyValidator` clone with a P-256 device key                                                                                                         |
| Recovery        | verified registered email **and** a Recovery Code signature **and** a current authenticator-app (TOTP) code **and** a timelock (default 72 h, floor 24 h), for the **exact** committed new root |
| Stop            | only the existing root can cancel (a normal root-signed UserOperation). Nobody else, Kaada included, can stop or approve a recovery                                                             |
| Finish          | one atomic batch: `changeRootValidator(committed root)` + `invalidateNonce(currentNonce + 1)`                                                                                                   |
| After           | the old credential is replaced, sessions and permissions are retired, the PIN must be reset, a **new** authenticator app and a **new** Recovery Code must be set up                             |

Email alone, the Recovery Code alone and the authenticator code alone can each do nothing: the state machine below has no edge to the
chain that skips any of them (and the database refuses a chain-stage attempt with no recorded authenticator code), and the contract
independently refuses anything without the Recovery Code's signature.

**The invariant that matters:** the server cannot recover a wallet by itself. A full copy of Kaada's database, the TOTP encryption key
and the email inbox still lacks the Recovery Code, and the contract will not start a recovery without a signature from the key that
Code derives. The email and authenticator checks are Kaada's gates in front of its relayer, and the contract accepts `initiate` from that relayer
ONLY (see `docs/recovery-contracts.md`): a Recovery Code holder cannot submit a recovery themselves and so cannot skip the email and the
authenticator code, and a compromised relayer still cannot produce the Recovery Code signature.

## Persistence

All in Postgres (migrations `20261019000000` to `20261019000003`), with the hard rules also as CHECK constraints and partial unique indexes.

- **`WalletCredential`**: every root a wallet has had. PUBLIC data only: kind (`PASSKEY` | `DEVICE_KEY`), role (`PRIMARY` | `BACKUP` | `RECOVERY`), status (`PENDING` |
  `ACTIVE` | `REPLACED` | `REVOKED`), `isRoot`, the validator **instance** address, the factory purpose and salt, the credential reference and public
  coordinates, the security tier (`UNKNOWN` | `WEB_NON_EXTRACTABLE` | `TRUSTED_DEVICE`), timestamps. Constraints: a validator instance is recorded **once per wallet,
  ever** (so none can be reused), at most one ACTIVE root per wallet, well-formed addresses and keys.
- **`RecoveryConfiguration`**: the wallet's on-chain arrangement: the recovery validator, the PUBLIC verifier address derived from the Recovery
  Code, the delay, a status (`PENDING_INSTALL` | `ACTIVE` | `CONSUMED` | `SUPERSEDED` | `DISABLED`), the stored install operation. At most one ACTIVE per wallet.
  **No Recovery Code and no key derived from it is stored anywhere.**
- **`RecoveryAttempt`**: the state machine (below), the exact committed new root (validator, install data, hashes, hook, hook data, commitment hash, recovery
  nonce), when the authenticator code was accepted and for which time step (`totpVerifiedAt`, `totpStep`; never the code), the on-chain progress
  (`executeAfter`, tx and UserOperation hashes, the nonce read before finalization), the finalizer lease, the cancel operation, the termination
  (`ROOT` | `SYSTEM`) and the post-recovery steps. Only SHA-256 digests of tokens. At most one live attempt per wallet.
- **`RecoveryTotp`**: the wallet's authenticator-app factor: `PENDING` (secret generated, not yet proven) | `ACTIVE` (a code was entered) | `DISABLED`.
  Only the **AES-256-GCM ciphertext** of the secret is stored (`v<keyVersion>.<nonce>.<ciphertext+tag>`, bound to the wallet and the row), under a dedicated
  key (`RECOVERY_TOTP_SECRET_KEY`), plus the newest accepted time step (`lastUsedStep`, the replay guard). One PENDING and one ACTIVE per wallet.
- **`RecoveryEmailChallenge`**: a keyed hash (HMAC-SHA-256 bound to the attempt) of the 6-digit email code, an attempt budget, single use, and the session token it unlocks.

## Recovery Code

Generated and used **only on the person's device** (`@kaada/contracts`, `recovery-code.ts`).

- 26 characters of Crockford base32 = **130 bits**, shown once as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. The `RecoveryCode` object prints as `[Recovery Code redacted]` in
  `toString`, JSON and `util.inspect`; the only way out is the explicit `reveal()`.
- The signing key is `HKDF-SHA256(secret, salt = "Kaada Recovery Code v1", info = "kaada/recovery-key/v1" || chainId (8 bytes) || account (20 bytes))`
  reduced into the secp256k1 range. The server stores only the address of that key (the contract's `recoveryKey`). A known vector is pinned by a test.
- The page can compare a typed code against the verifier the API shows after email verification before it signs anything.

## Authenticator app (TOTP)

The second thing a person holds. Standard RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps, so it works with Google Authenticator, Microsoft
Authenticator, Authy, 1Password and any other standard app (SHA-1 is kept on purpose: it is what those apps default to, and an HMAC is not
weakened by SHA-1's collision weakness). Verified in `apps/api/src/core/recovery/totp.ts` against the RFC's published vectors.

- **Setup** (`POST /recovery/configuration/authenticator/begin`, `.../confirm`): the server draws a 160-bit secret from the OS CSPRNG, stores it
  encrypted as `PENDING`, and returns it **once** as an `otpauth://totp/...` URI (the page draws the QR code locally) and as a key to type. Setup is
  complete only when the person enters one valid code (`ACTIVE`). A Recovery Code cannot be armed before that.
- **Use**: a code is accepted within ±1 step of the clock, and only for a step newer than the last one used: the check and the spend are one
  conditional update, so the same code never works twice, in parallel or after a restart. A wrong Recovery Code never spends the authenticator step.
- **Rate limits**: per wallet (Redis in production; the limiter fails closed), plus the attempt's own failure budget. A refusal never says which factor failed.
- **Never logged**: not the secret, not the URI, not a code. The log redactor and a source scan enforce it.
- **After a recovery** the enrolment is retired (`DISABLED`) together with the Recovery Code it travelled with; the person sets up a new authenticator app
  and a new Recovery Code in the recovery session.

### What a person is told

Shown during setup, before the Recovery Code is confirmed, and on the recovery start page:

> To recover your Kaada wallet, you'll need both:
>
> - your Recovery Code
> - access to your authenticator app
>
> If you lose both recovery methods, Kaada cannot restore your wallet.

## HTTP flow (`/api/v1/recovery`)

Identity is always an opaque short-lived token in the `Authorization` header; a body or query can never name a user, account or attempt, and tokens are never in a URL.
Every response is `no-store`. `token` = session token, `cancel` = the one-use link token delivered only through notifications (in a URL **fragment**).

| Step | Route                                                                                                                                            | Notes                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /start {email}`                                                                                                                            | **Same answer for every email**: an opaque token. Only a registered, armed account is sent a code. Rate limited per email, per IP, per day                                                                    |
| 2    | `POST /verify-email {code}` (token)                                                                                                              | one generic error for every failure (unknown token, wrong, expired, used, exhausted); budget counted atomically; single use. Proves the email only                                                            |
| 3    | `POST /passkey/options`, `POST /root/passkey` or `POST /root/device-key` (token)                                                                 | the new device creates a credential; the server proposes the **exact** root: a fresh clone, its install data, no hook. Returns the EIP-712 typed data                                                         |
| 4    | `POST /proof {signature, authenticatorCode}` (token)                                                                                             | the Recovery Code key's signature (verified against the stored verifier) **and** the 6-digit authenticator code (checked and spent); then (risk policy) `initiate` goes on chain. Every notification goes out |
| 5    | `GET /status`, `POST /finalize` (token)                                                                                                          | and the background sweeper. Nothing happens before maturity                                                                                                                                                   |
| 6    | `POST /signing-proof/options`, `POST /signing-proof` (token)                                                                                     | the NEW credential signs a fresh challenge; the on-chain validator says whether it is valid. Only then `COMPLETED`                                                                                            |
| 7    | `POST /pin {pin}` (token)                                                                                                                        | PIN reset through the verified recovery session, once                                                                                                                                                         |
| 8    | `POST /configuration/authenticator/begin`, `.../confirm {code}`, then `POST /configuration/prepare`, `POST /configuration` (token or setup link) | set up the authenticator app first (a code proves it), then arm a new Recovery Code; the root signs the install operation                                                                                     |
| stop | `POST /cancel/prepare`, `POST /cancel {material}` (cancel)                                                                                       | the existing root signs a stored cancel operation (a normal UserOperation). The only way to stop a recovery                                                                                                   |

`POST /root/device-key` is the **web** enrolment route: the server, not the client, decides the channel, so a key from it is at most `WEB_NON_EXTRACTABLE`.

## State machine

```
EMAIL_PENDING -> EMAIL_VERIFIED -> ROOT_PROPOSED -> INITIATING -> PENDING -> FINALIZING -> ROOT_CHANGED -> COMPLETED
      \               \                 \              \            |  ^         |
       `---> EXPIRED   `---> EXPIRED     `-> EXPIRED    `-> FAILED  |  `-- deferred (PENDING, blockedReason)
                                         `-> FAILED                 +--> CANCELLED (root)   +--> FAILED
```

Every move is one conditional `UPDATE ... WHERE status IN (...)`; the legal moves are listed in `RECOVERY_TRANSITIONS` and enforced by the repository.
`ROOT_CHANGED` is reached only after the **chain** shows: the root is the committed validator, `currentNonce` advanced, and the old root lane and every installed
permission lane are void. `COMPLETED` additionally needs the new credential to sign a fresh challenge that the validator accepts.

### Exact root commitment format

`commitmentHash = keccak256(abi.encode(account, rootId, hook, validatorDataHash, hookDataHash))` where `rootId = 0x01 || newValidator` (bytes21),
`hook = 0x0…0`, `hookData = 0x`, `validatorData` = the 96-byte `abi.encode(x, y, idHash | keyId)` and the `*Hash` fields are `keccak256` of those bytes. The signed EIP-712
message (`KaadaRecovery` / `1`, chain id, the recovery validator) carries `account`, the recovery `nonce`, `rootId`, `hook`, both hashes and a `deadline`. The client can
recompute the validator address from public configuration (`buildRecoveryRoot` in `@kaada/contracts`) and refuse to sign anything else; Kaada cannot substitute a root
after the signature: the stored commitment is rebuilt from the stored public credential before the proof is accepted and again before the batch is built.

## No attestor

There is no attestor boundary because there is no attestor. Kaada's recovery code holds exactly one key: the **relayer** that pays gas
(`readKeyFileOutsideRepo`, a file outside the repository). It signs nothing but the transactions it sends; it is not an approver, a veto or a
root. A source scan (`recovery-security.test.ts`) fails the build if the recovery adapter ever mentions an attestor, a veto, a registry or a KMS.
Before it submits `initiate` the service has checked: email verified, the risk policy allows (starts per day, quiet period after a recovery),
the Recovery Code signature verified against the stored verifier, the authenticator code accepted and spent, the commitment rebuilt and equal,
and no conflicting recovery pending on chain.

## Concurrency and restarts

- one live attempt per wallet (partial unique index); two simultaneous starts join one attempt;
- every status change is a conditional update with one winner; two simultaneous proofs start exactly one recovery;
- the finalizer takes a **lease** in one conditional update (`PENDING and matured`, or `FINALIZING and lease expired`); many processes may run, one drives;
- an authenticator step is spent in one conditional update and survives restarts;
- the UserOperation hash is stored **before** sending; a restarted process asks the bundler about it and **does not resend**; "unknown" is the only case that builds a fresh operation
  (safe: the Kernel nonce lets at most one operation of the lane execute and the recovery is consumed once);
- confirmation reads the chain, never a return value; a crash between the chain and the database is repaired from the chain (root already changed: finish);
- cleanup is idempotent and resumed by the sweeper.

## Payments in flight

Before a matured recovery is finalized the wallet's executions are inspected. `SIGNING`, `SUBMITTING`, `SUBMITTED`, `AWAITING_CONFIRMATION`, `CONFIRMED`, `EXECUTING` and `SETTLING`
may already have reached the chain or the provider, so finalization is **deferred** (the attempt returns to `PENDING` with `blockedReason = PAYMENT_IN_FLIGHT`, shown as "waiting for a payment")
and retried by the sweeper; the existing `ExecutionReconciler` settles those payments and nothing is resent. States before `SIGNING` have sent nothing; their authorizations are revoked by
cleanup. An empty wallet, a bundler refusal and a failed pre-flight simulation also defer instead of failing.

## Post-recovery cleanup

At `ROOT_CHANGED`, in one idempotent pass: the old credential `REPLACED` and the new one the ACTIVE root (with a passkey mirror row for the existing passkey flows); the recovery configuration
`CONSUMED`; every delegated permission `REVOKED` and its encrypted session key and approval **tombstoned**; authorization sessions cancelled; active payment authorizations revoked (none can be revived);
root-action sessions cancelled; wallet setup links and web sessions revoked; the old passkeys revoked; the PIN marked reset-required. Then the person proves the new credential, sets a new PIN, and arms a **new** Recovery Code
(the old one is burnt on chain: `usedRecoveryKeys`).

## Device security tiers

`classifyDeviceKey` is the only way a tier is assigned; a client claim is never read. `TRUSTED_DEVICE` requires a server-side `AttestationVerifier` to report a verified platform attestation
that binds this exact key, hardware backing and the server challenge. **No verifier exists yet** (Apple App Attest and Android Key Attestation are a follow-up), so today nothing can become `TRUSTED_DEVICE`.

## Tests

- `apps/api/test/recovery-start.test.ts`, `recovery-flow.test.ts`, `recovery-finalize.test.ts`, `recovery-controller.test.ts`, `recovery-totp.test.ts`: the real services over in-memory repositories and a semantic stand-in for the chain (it uses the real shared root, commitment and EIP-712 helpers).
- `apps/api/test/integration/recovery.integration.test.ts`: the same flow and the constraints on real Postgres.
- `packages/blockchain/src/recovery/recovery.test.ts`: the chain adapter's pure parts (and that it has no attestor or veto surface).
- `apps/api/test/testnet/sepolia-recovery.ts`: the live run below.

## Celo Sepolia validation (real HTTP/service path, TEST-ONLY 25 s delay) — PREVIOUS DESIGN

> The tables below record the live run of the **previous** (attestor) design. They are history, not evidence for the current design.

`apps/api/test/testnet/sepolia-recovery.ts` boots the real Nest API over Postgres, the real `ViemRecoveryChain` and the self-hosted Alto bundler. **This run was made with the previous
attestor design and has not been repeated for the authenticator design**; the harness was updated but not re-run (see "Remaining production blockers").
The 25 s delay exists only in the test-build recovery validator; the production minimum stays 24 h (72 h default) and is enforced by config validation.

| Scenario                           | Result                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. passkey root -> device-key root | all checks pass: arm, email, proof, attestor, maturity gate, finalize via Alto, nonce advanced, old passkey and lane W void, sessions/PIN retired, signing proof, PIN reset, new Recovery Code |
| B. device-key root -> passkey root | all checks pass, including a real WebAuthn registration and assertion accepted on chain                                                                                                        |
| C. cancel by existing root         | all checks pass (non-root cancel refused; root-signed UserOperation cancels; never finalizable)                                                                                                |
| D. (previous design) attestor veto | REMOVED with the attestor. The harness scenario D now covers the authenticator gate and a cancel by the root; it has not been run live                                                         |

Final live results (final committed code): A and B passed in run 3; C and D passed 15/15 in a dedicated `SCENARIOS=C,D` run, which also checks the post-maturity finalize, the replayed signature, the stranger veto and a recovery sweep. The sweep runs `RecoverySweeper.sweepNow()` inside the same process; it exercises the reconciliation path a restarted process would take, but is not a literal process restart.

### Bugs found and fixed

- Status on an unverified token revealed account existence: tokens of unverified attempts are now invalid everywhere.
- `ROOT_PROPOSED` / `EMAIL_VERIFIED` could not move to `FAILED`: transitions added.
- Node read-lag on Sepolia left a vetoed attempt `PENDING` (`settleWhenGone` retries) and stranded an attempt in `INITIATING` (`finishInitiationPatiently`).
- The in-memory chain applied state at submit even when inclusion was held; it now applies on inclusion.

## Remaining production blockers

- No real email provider (file outbox only, refused in production); no Telegram or WhatsApp senders.
- No Apple App Attest / Android Key Attestation verifier: nothing can be `TRUSTED_DEVICE` yet.
- The recovery contracts changed (no attestor registry, a single-signature `initiate`): they must be redeployed and re-proved on Celo Sepolia before mainnet. Nothing is deployed on mainnet.
- The recovery relayer is a single hot key (`RECOVERY_RELAYER_KEY_FILE`, outside the repository, gas only). If it is down or unfunded nobody can start a recovery (by design). Fund it and monitor its balance; replacing it means a new validator deployment. Not yet exercised on Celo Sepolia after the relayer gate was added.
- A chain watcher (alert on initiated / cancelled / finalized events) is defence in depth, not built.
- Gas for recovery and cancel needs a sponsor policy (`RECOVERY_GAS_TOPUP_MAX_WEI`).
- A batch that reverts after validation burns the Recovery Code; mitigated by bundler simulation, not eliminated.
- (Closed in the root-agnostic milestone: onboarding, PIN enrolment, root actions and payments all work for a device-key root; see `docs/root-agnostic-flow.md`.)
- (Closed in the root-agnostic milestone: the PIN is six digits everywhere; see `docs/root-agnostic-flow.md`.)
- Rate limits are in-process; the sweeper needs a deployment; the email-challenge pepper needs managed rotation.
- No frontend UI for the flow yet.

## Security MVP additions

See [security-architecture](security-architecture.md) for the frozen architecture. Added on top of the orchestration above, without
changing it: Redis-backed rate limits (fail closed), SMTP email and Telegram delivery of the three recovery alerts (started, cancelled,
completed), the `/recovery`, `/recovery/cancel` and `/security/[token]` pages, and `device.keyId` / `device.payload` in every root signing request so a browser
can sign for a device-key root without re-deriving the payload.
