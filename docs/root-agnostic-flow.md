# Root-agnostic user flow and the six-digit PIN

One normal flow for every Kaada wallet, whatever its root signs with.

| Concern         | Rule                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Login           | email / channel identity                                                                                                                   |
| Normal payments | a **six-digit PIN**; it creates a `PaymentAuthorization` only, and is never a wallet or root key                                           |
| Root            | a **passkey** (WebAuthn) where the device has one, or a **P-256 device key** (`KaadaDeviceKeyValidator`) where it does not                 |
| Root actions    | whichever root the wallet actually has signs, once, for the thing that needs a root (deploy, install a permission, rotate, enrol a backup) |
| Repeat payments | PIN only: the installed permission already covers them, so the root is not asked                                                           |
| Recovery        | unchanged: verified email + Recovery Code + attestor + timelock, for the exact committed new root (`docs/recovery-orchestration.md`)       |

Nothing in the payment, authorization, execution or recovery logic branches on how a root signs. The two root types differ in exactly
one place per layer (below), and the client is told which one to show by the server.

## The six-digit PIN

- Exactly six digits (`^[0-9]{6}$`), checked by `isValidPinFormat` before any hash is read, so a four-, five- or seven-digit value or a
  non-digit is not a guess: it costs no attempt and can never verify.
- Unchanged: Argon2id (64 MiB, 3 passes, 1 lane), the server-side `PIN_PEPPER`, the per-user lockout ladder (3 wrong guesses lock for
  5 min, then 15 min, then 1 h), no PIN in a log, a URL, browser storage or a channel message. The keypad is six dots.
- **Migration** `20261020000000_pin_six_digits`: every existing hash was made from a four-digit value and can never match a six-digit one,
  so the migration _deletes every `TransactionPinSecurity` row_ (development/test wallets only: nothing is in production). Each wallet is
  simply "no PIN yet" until its owner creates a six-digit PIN. No hash records its length, and nothing accepts both lengths, ever. A
  database test inserts a leftover four-digit hash and proves nothing verifies against it.
- Setting or changing the PIN needs a fresh proof by the wallet's root (below), on top of the setup link.
- The recovery PIN reset (through the verified recovery session) takes the same six digits.

## The root abstraction

`@kaada/domain` names it; adapters implement it; business logic never branches on it.

```ts
type RootType = "PASSKEY" | "DEVICE_KEY";
type RootCredential = PasskeyRoot | DeviceKeyRoot; // public data only: coordinates, ids, the validator instance
type RootProof = { type: "PASSKEY"; assertion } | { type: "DEVICE_KEY"; keyId; r; s; challenge? };
type RootChallenge =
  // what the CLIENT must sign; the server decides the shape from the wallet's root
  | { action: "ROOT_PASSKEY_REQUIRED"; type: "PASSKEY"; options } //   WebAuthn request options
  | { action: "ROOT_DEVICE_KEY_REQUIRED"; type: "DEVICE_KEY"; keyId; payload; format; challenge? };
```

| Operation requested            | Where it lives                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareRootChallenge`         | `RootCredentialAdapter.prepareOperationChallenge` (per type); `RootProofService.begin` for off-chain proofs                                              |
| `signRootAction`               | **client only**: the person's authenticator or device key. The server has no signing method of any kind                                                  |
| `verifyRootCredential`         | `RootCredentialAdapter.verifyOperationProof`, `DeviceKeyRootAdapter.verifyProof`, `RootProofService.complete`                                            |
| `buildKernelRoot`              | `toRootValidator` (blockchain): the Kernel sudo plugin of the type (`ZeroDev passkey validator`, or the device-key plugin)                               |
| `installPermission`            | `RootActionService` (`DEPLOY_AND_INSTALL_PERMISSION`), one root-signed UserOperation                                                                     |
| `rotateRoot`, backup enrolment | `RootChangeService` (`ROTATE_ROOT`, `ENROLL_BACKUP`), one root-signed UserOperation each                                                                 |
| which root a wallet has        | `RootCredentialService.activeRoot`: the recorded `WalletCredential` root; a wallet predating credential tracking falls back to its oldest active passkey |

There is no `sign(bytes)`. The only signature the server ever produces is the attestor's typed `Initiate` message and the validated
session-key signature of a payment (both unchanged, in their own scoped locations); a root's proof is _checked_, never made.

### What each type signs

- **PASSKEY**: a WebAuthn assertion whose challenge is the UserOperation hash (user verification required, no `allowCredentials`). The
  Kernel adapter encodes it for the passkey validator (the stack's shared instance for a wallet created with one, or a clone for a root that
  came from a rotation or a recovery).
- **DEVICE_KEY**: ECDSA P-256 / SHA-256 over the documented 153-byte payload
  `"KaadaDeviceKey/v1" ‖ chainId ‖ validator ‖ account ‖ keyId ‖ userOpHash`, **low-s only**. `userOp.signature = keyId ‖ r ‖ s`. The
  server verifies it off-chain first (`verifyP256`), so a doomed operation is never sent.
- **Off-chain proofs** (PIN enrolment, device enrolment) use a _different_ domain tag, `"KaadaRootProof/v1" ‖ chainId ‖ validator ‖
account ‖ keyId ‖ purposeHash ‖ challenge`, with a single-use server nonce. A proof can therefore never pass as a UserOperation
  signature, and a proof for one purpose cannot be used for another.

### Where the passkey assumption lived, and what replaced it

The delegated-permission system itself is root-agnostic: the session key, its call and timestamp policies, the pre-installed enable data and
the delegated send never mention the root, and `deserializePermissionAccount` does not need it. The WebAuthn assumptions were all in the
_root-operation layer_ and in planning, and were replaced:

| Was                                                                                                    | Now                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `RootCredential = { credentialId, publicKeyX, publicKeyY, rpId }`                                      | the `PASSKEY \| DEVICE_KEY` union                                                                                                |
| `KernelExecutionPort.sendRootOperation({ prepared, assertion })`                                       | `({ prepared, proof })`; the adapter encodes the proof for the root's type and refuses another type                              |
| the Kernel adapter hard-wired `toPasskeyValidator` with the shared address                             | `toRootValidator(root)`; a deployed account's address is taken from the chain (a rotated wallet no longer derives from its root) |
| `RootActionService` listed the user's passkeys and verified a WebAuthn assertion                       | resolves the wallet's root, asks its adapter for the challenge and for the verification                                          |
| `accountRequirements.passkeyRootAvailable`, `installSigner: "ROOT_PASSKEY"`, blocker `NO_PASSKEY_ROOT` | `rootAvailable`, `installSigner: "ROOT"`, `NO_ROOT` (a device-key wallet is no longer "blocked for lacking a passkey")           |
| PIN enrolment required a passkey assertion                                                             | a `RootProof` through `RootProofService`                                                                                         |

## Onboarding

### Passkey (unchanged path)

`POST wallet/passkeys/registration/options` → browser `navigator.credentials.create` → `POST …/verify` → counterfactual Kernel account
derived from the passkey → wallet `ACTIVE`. Preferred where supported; never required.

### Device key (new)

For a browser or phone with no passkeys (or when the person chooses it). Enabled by `DEVICE_KEY_ROOTS_ENABLED=true` (it needs the validator
factory and implementation addresses and the relayer key file; production refuses to start without them).

1. The client generates a P-256 key with WebCrypto, **non-extractable**; the private key is an opaque `CryptoKey` kept in IndexedDB and is
   never read, serialized, stored elsewhere or sent. Only the public coordinates leave the device.
2. `POST wallet/device-keys/options {publicKeyX, publicKeyY}`: the server checks the point is on the curve, **derives the key id itself**
   (the client never supplies one) and issues a single-use challenge with the payload to sign (proof of possession).
3. The client signs it and `POST wallet/device-keys/register {publicKeyX, publicKeyY, challenge, r, s}`.
4. The server verifies the proof, decides the security tier **from the route** (the web route: `WEB_NON_EXTRACTABLE`; there is no field a
   client can claim a tier in, and without an attestation verifier nothing is ever `TRUSTED_DEVICE`), derives a **fresh deterministic
   PRIMARY clone** (`buildPrimaryRoot`: scope `address(0)`, purpose 0, salt = a hash of the wallet owner, so one key for two owners gets two
   instances), records the wallet and its `PRIMARY` root `WalletCredential` (`DEVICE_KEY`, `ACTIVE`, `isRoot`), and **deploys the clone
   through the relayer before deriving the account** (the SDK derives an address by simulating the account's creation, which installs the
   validator, so the clone must exist first; found live: derivation returned the zero address without it). The deployment is idempotent
   and holds no authority: its address is fixed by the key.
5. Then the six-digit PIN (a device proof) and the recovery arrangement, exactly as for a passkey wallet.

A validator instance is recorded once per wallet, ever (a unique index), so none can be reused.

## Root actions, the same two calls for both types

`GET root-action/view`, `GET root-action/options` (a `RootChallenge`), `POST root-action/complete {proof}` (opaque link token in the
`Authorization` header; the body can carry nothing but the proof). The server fixes the operation and its challenge; the page returns
the root's proof and nothing else.

Voluntary changes with the **current root** (identity: a security link, the same one that sets the PIN):

| Route                                                      | What it does                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST wallet/root/passkey/options`, `…/device-key/options` | registration options / enrolment challenge for the NEW credential                                                                |
| `POST wallet/root/changes {kind, credential}`              | deploys a fresh clone and prepares ONE operation; returns the `RootChallenge` for the CURRENT root (its type decides the prompt) |
| `POST wallet/root/changes/:id/complete {proof}`            | verifies the proof, claims the change (one sender), sends it, and confirms **only from the chain**                               |
| `GET wallet/root/changes/:id`                              | status                                                                                                                           |

- `ROTATE_ROOT`: `changeRootValidator(new clone)` + `invalidateNonce(currentNonce + 1)` (the same two calls a recovery runs). Confirmed
  only when the chain shows the new validator as the root **and** the nonce advanced. Then, in one transaction: the new credential is the
  only root (the old one `REPLACED`), a new passkey is mirrored for the existing passkey flows and the old passkeys are revoked, every
  delegated permission is revoked and its session key and approval destroyed, and pending authorizations, payment authorizations,
  root-action sessions and setup links are cancelled. The PIN is not touched: it was never tied to the root.
- `ENROLL_BACKUP`: `installValidations` + `grantAccess(execute)` for a second fresh clone; confirmed when the lane is installed on the
  account; the credential becomes an `ACTIVE`, non-root `BACKUP`. Nothing else changes (the next rotation voids the lane).
- One live change per wallet (a partial unique index); two simultaneous completions send exactly once; a definite bundler refusal fails
  the change and drops the pending credential; an ambiguous send stays `SUBMITTED` and `reconcile()` finishes it from the chain without
  resending; stale `PREPARED` changes expire.
- Recovery configuration (arming a Recovery Code) and cancelling a pending recovery are root-signed operations that already took either
  root type (`encodeRootSignature`, `checkSignature`); they are unchanged.

## Structured actions for the client

The client never guesses which signer to show.

| Where                                                | Field                           | Values                                                                                                                     |
| ---------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET authorization` (the PIN page)                   | `action`                        | `PIN_REQUIRED`                                                                                                             |
| `POST authorization/authorize`                       | `action`                        | `PAYMENT_READY`                                                                                                            |
| `POST execution/run`, `GET execution/status`         | `action` (when any)             | `ROOT_PASSKEY_REQUIRED` / `ROOT_DEVICE_KEY_REQUIRED` (a root action waits), `PIN_REQUIRED` (re-authorize), `PAYMENT_READY` |
| `GET root-action/view`                               | `action`, `rootType`            | `ROOT_PASSKEY_REQUIRED` / `ROOT_DEVICE_KEY_REQUIRED`                                                                       |
| `GET root-action/options`, `POST wallet/pin/options` | `RootChallenge`                 | the type-specific request                                                                                                  |
| `GET wallet`                                         | `rootType`, `deviceKeysEnabled` | what the setup page may offer                                                                                              |

## Payment UX, both root types

```
User instruction → quote → review → 6-digit PIN → PaymentAuthorization → run
   first payment only:  ROOT_*_REQUIRED → the wallet's root signs once → permission installed
   delegated execution → payment complete
repeat payment:  PIN → PaymentAuthorization → run → delegated execution → payment complete   (no root prompt)
```

A root prompt happens only when a privileged action is actually required: the account must be deployed, or no installed permission covers
the payment (`permissionRequirement.state = INSTALLATION_REQUIRED`). Once a covering permission is installed the plan says
`rootSignatureRequired = false` and the runner never asks. `PaymentAuthorization` bounds, the single-execution lock, the hash-before-send
rule and restart reconciliation are untouched.

## Security tiers

`classifyDeviceKey` is the only way a tier is assigned and it never reads a client claim. `WEB_NON_EXTRACTABLE` is the web WebCrypto path;
`UNKNOWN` is anything the server cannot place; `TRUSTED_DEVICE` requires a server-side `AttestationVerifier` reporting a verified
platform attestation that binds this exact key, hardware backing and the server challenge. **No verifier exists** (Apple App Attest and
Android Key Attestation are the next milestone), so nothing can be `TRUSTED_DEVICE`; a test proves a web enrolment stays
`WEB_NON_EXTRACTABLE` even where a verifier is wired.

## Signer boundaries (what stayed strict)

- `packages/blockchain/src/wallet/root-validator.ts` builds the device-key sudo plugin with **no signing members of any kind**; the Kernel
  adapter (the one file that sends operations) is given the device's signature from outside.
- The relayer's clone deployment (`ViemValidatorDeployer`, one `deploy` call, paid by a key outside the repository) joins the recovery
  attestor and chain adapter in the second sanctioned signer location, held to its own narrow scan (`recovery-security.test.ts`).
- The browser half (`apps/web/app/lib/device-key.ts`) is scanned too: non-extractable generation only, `exportKey("raw")` of the public key
  only, IndexedDB only (never `localStorage`, a cookie, a URL or a log), one `subtle.sign`, low-s normalisation.

## Tests

Offline (`pnpm test`): `root-agnostic.test.ts` (P-256 verification, device adapter, root service, device onboarding incl. fresh clone and
deployed-before-derive, PIN by a device root, replay, wrong purpose, wrong type), `root-actions.test.ts` (permission install by a device
key through the real service and runner, wrong key/high-s/wrong type, replay, first payment needs the root and the repeat does not, both
types), `root-change.test.ts` (rotation in all four type pairs, retirement, refusals, restart/reconcile, races, backups),
`root-http.test.ts` (the wire shapes, the structured actions, the same payment through the real HTTP edge for both roots),
`pin.test.ts` (six digits), `recovery-*.test.ts` (unchanged: both root types), the scans, and `apps/web/app/lib/device-key.test.ts`.
Real database (`pnpm --filter @kaada/api test:integration`): `root-agnostic.integration.test.ts`.

## Celo Sepolia validation

`apps/api/test/testnet/sepolia-roots.ts` boots the production `AppModule` (every controller, service and repository, the real Postgres, the
real Kernel/bundler adapter, the real relayer-paid clone deployment) and plays the person over plain HTTP, with software authenticators and
software P-256 device keys, against the local Alto bundler and the real EntryPoint/Kernel on Celo Sepolia. Only what is mainnet- or
Textile-bound is replaced behind the same ports (chain reads, the firm-quote and order providers, the two fixture tokens and the fixture
swap). The database keeps the logical chain id 42220. No mainnet, no Textile.

| Scenario                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. PASSKEY root                          | **19/19.** Onboard, six-digit PIN (4, 5, 7 digits and `12345a` refused; Argon2id hash only), **payment 1** (one `ROOT_PASSKEY_REQUIRED`, permission installed, +100 tBRL), **payment 2: PIN only, no root prompt**, one root-action session for two payments                                                                                                                                             |
| B. DEVICE-KEY root                       | **all checks pass.** Onboard (fresh PRIMARY clone deployed, account derived from it), six-digit PIN vouched for by a device-key signature, **payment 1** (one `ROOT_DEVICE_KEY_REQUIRED`, permission installed, +100 tBRL), **payment 2: PIN only, no root prompt**, one root-action session for two payments, the chain's root is the recorded clone                                                    |
| C. ROTATION passkey -> device -> passkey | **30/30.** Payment (root action), then rotation to a device key (the passkey signs; confirmed by the chain; fresh clone is the on-chain root), payment (the old permission is void, so one `ROOT_DEVICE_KEY_REQUIRED`), rotation back to a passkey (the device key signs; another fresh clone), payment (`ROOT_PASSKEY_REQUIRED`). The wallet address never changed and no validator instance was reused |

Scenario C also proves live the Kernel adapter's deployed-account path (a rotated wallet's address is taken from the chain) and a **passkey clone** as the sudo validator.

### Bugs found and fixed on the way

- **Counterfactual address was the zero address for a device-key wallet.** The SDK derives an address by simulating the account's creation,
  which installs the validator; the device clone did not exist yet. Fixed: the relayer deploys the fresh clone _before_ the account is
  derived (idempotent, also on the `finalize` retry path); a unit test pins the order.
- **A rotated or recovered wallet could not build its Kernel account.** The adapter derived the address from the root and refused when it
  did not match; after a rotation it never would. A deployed account's address is now taken from the chain.
- **Planning was passkey-only** (`passkeyRootAvailable`, `NO_PASSKEY_ROOT`): a device-key wallet would have been blocked at the first
  payment. Now `rootAvailable`, `NO_ROOT`.
- **Run errors were swallowed silently** (`RunTracker` reported any unexpected error only as "pending"): found because a slow database made
  transactions exceed Prisma's 5 s default and the payment looked stuck. The tracker now tells an operator what class of error ended a run
  (never a payload), and `DATABASE_TRANSACTION_TIMEOUT_MS` (default 5 s) lets a deployment far from its database raise the limit.
- The Sepolia helper's `clean` forgot the new tables and the harness leaked a fixture asset row when interrupted; both fixed.

## Remaining blockers

- No UI yet for a **voluntary rotation or backup enrolment** (the endpoints, the server and the client proof library exist; there is no page).
- Native iOS/Android clients and **App Attest / Android Key Attestation** (next milestone): until then nothing is `TRUSTED_DEVICE`, and a
  web device key is `WEB_NON_EXTRACTABLE`, not hardware.
- A device-key wallet's key lives in one browser profile's IndexedDB: clearing site data loses it (recovery, or a backup enrolled earlier, is
  the way back). Cross-device use needs the backup flow or recovery.
- Gas: the account pays its own prefund (no paymaster) and the relayer pays for clone deployment; a sponsorship policy and relayer funding
  alarms are production work.
- Rate limiting of the new endpoints is in-process (like the rest); the relayer-paid clone deployment makes per-link abuse limits worth
  tightening before launch.
- Real email, Telegram and WhatsApp senders, a KMS/HSM attestor and the other recovery blockers are unchanged
  (`docs/recovery-orchestration.md`).
