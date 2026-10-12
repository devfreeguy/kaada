# Account recovery orchestration

The backend that turns the validated recovery contracts (see `docs/recovery-contracts.md`) into Kaada's real flow. Everything below
runs in `apps/api` over `@kaada/domain` ports, with the chain behind `RecoveryChainPort` (`@kaada/blockchain`) and the attestor behind
`RecoveryAttestor`.

## The model (locked)

| Concern         | Rule                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login           | email / channel identity                                                                                                                                                           |
| Normal payments | PIN creates a `PaymentAuthorization` only; it is never a wallet or root key                                                                                                        |
| Root            | a passkey validator clone, or a `KaadaDeviceKeyValidator` clone with a P-256 device key                                                                                            |
| Recovery        | verified registered email **and** a Recovery Code signature **and** a Kaada attestor signature **and** a timelock (default 72 h, floor 24 h), for the **exact** committed new root |
| Stop            | the existing root can cancel (a normal root-signed UserOperation); the attestor can veto; neither can approve                                                                      |
| Finish          | one atomic batch: `changeRootValidator(committed root)` + `invalidateNonce(currentNonce + 1)`                                                                                      |
| After           | the old credential is replaced, sessions and permissions are retired, the PIN must be reset, a **new** Recovery Code must be created                                               |

Email alone, the Recovery Code alone and the attestor alone can each do nothing: the state machine below has no edge to the chain
that skips any of them, and the contract independently refuses it.

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
  nonce), the on-chain progress (`executeAfter`, tx and UserOperation hashes, the nonce read before finalization), the finalizer lease, the cancel
  operation, the termination (`ROOT` | `ATTESTOR` | `SYSTEM`) and the post-recovery steps. Only SHA-256 digests of tokens. At most one live attempt per wallet.
- **`RecoveryEmailChallenge`**: a keyed hash (HMAC-SHA-256 bound to the attempt) of the 6-digit email code, an attempt budget, single use, and the session token it unlocks.

## Recovery Code

Generated and used **only on the person's device** (`@kaada/contracts`, `recovery-code.ts`).

- 26 characters of Crockford base32 = **130 bits**, shown once as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. The `RecoveryCode` object prints as `[Recovery Code redacted]` in
  `toString`, JSON and `util.inspect`; the only way out is the explicit `reveal()`.
- The signing key is `HKDF-SHA256(secret, salt = "Kaada Recovery Code v1", info = "kaada/recovery-key/v1" || chainId (8 bytes) || account (20 bytes))`
  reduced into the secp256k1 range. The server stores only the address of that key (the contract's `recoveryKey`). A known vector is pinned by a test.
- The page can compare a typed code against the verifier the API shows after email verification before it signs anything.

## HTTP flow (`/api/v1/recovery`)

Identity is always an opaque short-lived token in the `Authorization` header; a body or query can never name a user, account or attempt, and tokens are never in a URL.
Every response is `no-store`. `token` = session token, `cancel` = the one-use link token delivered only through notifications (in a URL **fragment**).

| Step | Route                                                                            | Notes                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /start {email}`                                                            | **Same answer for every email**: an opaque token. Only a registered, armed account is sent a code. Rate limited per email, per IP, per day                                                |
| 2    | `POST /verify-email {code}` (token)                                              | one generic error for every failure (unknown token, wrong, expired, used, exhausted); budget counted atomically; single use. Proves the email only                                        |
| 3    | `POST /passkey/options`, `POST /root/passkey` or `POST /root/device-key` (token) | the new device creates a credential; the server proposes the **exact** root: a fresh clone, its install data, no hook. Returns the EIP-712 typed data                                     |
| 4    | `POST /proof {signature}` (token)                                                | the Recovery Code key's signature; verified against the stored verifier; then (risk policy) the attestor signs the same message and `initiate` goes on chain. Every notification goes out |
| 5    | `GET /status`, `POST /finalize` (token)                                          | and the background sweeper. Nothing happens before maturity                                                                                                                               |
| 6    | `POST /signing-proof/options`, `POST /signing-proof` (token)                     | the NEW credential signs a fresh challenge; the on-chain validator says whether it is valid. Only then `COMPLETED`                                                                        |
| 7    | `POST /pin {pin}` (token)                                                        | PIN reset through the verified recovery session, once                                                                                                                                     |
| 8    | `POST /configuration/prepare`, `POST /configuration` (token or setup link)       | arm a new Recovery Code; the new root signs the install operation                                                                                                                         |
| stop | `POST /cancel/prepare`, `POST /cancel {material}` (cancel)                       | the existing root signs a stored cancel operation (a normal UserOperation)                                                                                                                |
| stop | `POST /report` (cancel)                                                          | "this was not me": the attestor vetoes                                                                                                                                                    |

`POST /root/device-key` is the **web** enrolment route: the server, not the client, decides the channel, so a key from it is at most `WEB_NON_EXTRACTABLE`.

## State machine

```
EMAIL_PENDING -> EMAIL_VERIFIED -> ROOT_PROPOSED -> INITIATING -> PENDING -> FINALIZING -> ROOT_CHANGED -> COMPLETED
      \               \                 \              \            |  ^         |
       `---> EXPIRED   `---> EXPIRED     `-> EXPIRED    `-> FAILED  |  `-- deferred (PENDING, blockedReason)
                                         `-> FAILED                 +--> CANCELLED (root)   +--> VETOED (attestor)   +--> FAILED
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

## Attestor boundary

`RecoveryAttestor` has three members: `address()`, `signInitiate(typedMessage)` and `veto({validator, account})`. There is no method that signs bytes, calldata, a transaction,
a transfer, a `PaymentAuthorization` or a UserOperation; it refuses another chain or validator; it is never an account root. The service calls it only after: email verified,
the risk policy allows (starts per day, quiet period after a recovery), the Recovery Code signature verified against the stored verifier, the commitment rebuilt and equal, and
no conflicting recovery pending on chain. The development key is read from a file **outside the repository** (`readKeyFileOutsideRepo`); production is a KMS/HSM signer behind the same interface.

## Concurrency and restarts

- one live attempt per wallet (partial unique index); two simultaneous starts join one attempt;
- every status change is a conditional update with one winner; two simultaneous proofs start exactly one recovery;
- the finalizer takes a **lease** in one conditional update (`PENDING and matured`, or `FINALIZING and lease expired`); many processes may run, one drives;
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

- `apps/api/test/recovery-start.test.ts`, `recovery-flow.test.ts`, `recovery-finalize.test.ts`, `recovery-controller.test.ts`: the real services over in-memory repositories and a semantic stand-in for the chain (it uses the real shared root, commitment and EIP-712 helpers).
- `apps/api/test/integration/recovery.integration.test.ts`: the same flow and the constraints on real Postgres.
- `packages/blockchain/src/recovery/recovery.test.ts`: the chain adapter's pure parts and the attestor boundary.
- `apps/api/test/testnet/sepolia-recovery.ts`: the live run below.

## Celo Sepolia validation (real HTTP/service path, TEST-ONLY 25 s delay)

`apps/api/test/testnet/sepolia-recovery.ts` boots the real Nest API over Postgres, the real `ViemRecoveryChain`, the self-hosted Alto bundler and the file-based attestor key outside the repo.
The 25 s delay exists only in the test-build recovery validator; the production minimum stays 24 h (72 h default) and is enforced by config validation.

| Scenario                           | Result                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. passkey root -> device-key root | all checks pass: arm, email, proof, attestor, maturity gate, finalize via Alto, nonce advanced, old passkey and lane W void, sessions/PIN retired, signing proof, PIN reset, new Recovery Code                         |
| B. device-key root -> passkey root | all checks pass, including a real WebAuthn registration and assertion accepted on chain                                                                                                                                |
| C. cancel by existing root         | all checks pass (non-root cancel refused; root-signed UserOperation cancels; never finalizable)                                                                                                                        |
| D. attestor veto                   | all checks pass with the final code: veto succeeds, attempt reaches VETOED (not PENDING), a stranger's `attestorCancel` is refused, a matured vetoed attempt cannot finalize, a sweep leaves it VETOED, root unchanged |

Final live results (final committed code): A and B passed in run 3; C and D passed 15/15 in a dedicated `SCENARIOS=C,D` run, which also checks the post-maturity finalize, the replayed signature, the stranger veto and a recovery sweep. The sweep runs `RecoverySweeper.sweepNow()` inside the same process; it exercises the reconciliation path a restarted process would take, but is not a literal process restart.

### Bugs found and fixed

- Status on an unverified token revealed account existence: tokens of unverified attempts are now invalid everywhere.
- `ROOT_PROPOSED` / `EMAIL_VERIFIED` could not move to `FAILED`: transitions added.
- Node read-lag on Sepolia left a vetoed attempt `PENDING` (`settleWhenGone` retries) and stranded an attempt in `INITIATING` (`finishInitiationPatiently`).
- The in-memory chain applied state at submit even when inclusion was held; it now applies on inclusion.

## Remaining production blockers

- No real email provider (file outbox only, refused in production); no Telegram or WhatsApp senders.
- No Apple App Attest / Android Key Attestation verifier: nothing can be `TRUSTED_DEVICE` yet.
- The attestor key is a file; production needs a KMS/HSM signer behind `RecoveryAttestor`.
- Gas for recovery and cancel needs a sponsor policy (`RECOVERY_GAS_TOPUP_MAX_WEI`).
- A batch that reverts after validation burns the Recovery Code; mitigated by bundler simulation, not eliminated.
- Device-key roots lack the payment and PIN-enrollment flows that need passkeys.
- The existing PIN is 4 digits; the locked model says 6.
- Rate limits are in-process; the sweeper needs a deployment; the email-challenge pepper needs managed rotation.
- No frontend UI for the flow yet.
