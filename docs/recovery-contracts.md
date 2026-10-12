# Recovery contracts

On-chain half of account recovery (`packages/contracts`). Locked model: recovery needs the **Recovery Code** (a key the
user derives locally), the **Kaada attestor**, and a **timelock** (default 72 h, hard minimum 24 h). Email alone, the code
alone and the attestor alone can do nothing. Recovery rotates the wallet's root and invalidates every older validator and
permission, atomically. It never moves funds.

Build order: `KaadaRecoveryValidator` (done), `TimelockedAttestorRegistry` (done), passkey validator clone factory,
`KaadaDeviceKeyValidator`, backend orchestration, UI, Celo Sepolia end-to-end.

## KaadaRecoveryValidator

An ERC-7579 / Kernel v3.3 **validator** installed at wallet creation, granted Kernel's `execute` selector (a batch needs
it). It is not upgradeable, has no owner and no admin, no `receive`/`fallback`, and no function that transfers, approves or
calls out.

**What it accepts.** `validateUserOp` accepts exactly one `userOp.callData`, rebuilt byte for byte from the committed
parameters and compared by hash:

```
execute(MODE_BATCH, abi.encode([
  Execution(account, 0, changeRootValidator(committed rootId, hook, validatorData, hookData)),
  Execution(account, 0, invalidateNonce(account.currentNonce() + 1))
]))
```

No third call, no value, no other target or selector, no other mode, no non-canonical encoding. Only for a pending, matured,
uncancelled recovery. The recovery is consumed during validation (one shot). It returns `validAfter = executeAfter`, so the
EntryPoint enforces maturity (no `TIMESTAMP` read in validation).

**How a recovery starts.** `initiate(account, RootCommitment, deadline, sigRecovery, sigAttestor)` is open to any
submitter. Both signatures are EIP-712 over one digest binding: chainId and this contract (domain), account, recovery
nonce, new validator id, hook, hash of the validator data, hash of the hook data, and deadline. The recovery signer is the
key stored for the account; the attestor is whatever the shared registry names **now**. Low-s only. The new root must be a
validator-type id (`0x01 ‖ address`) naming a contract that is not the module.

**Cancel / veto.** `cancel()` (the account itself, i.e. a root-signed operation) and `attestorCancel(account)` (the
registry's current attestor). Both bump the recovery nonce, so the cancelled signatures can never be reused. The attestor
has no function that starts, advances or completes a recovery.

**One shot and re-arming.** On success the account's configuration is deleted and its recovery key is burnt
(`usedRecoveryKeys`): the old key can never be installed again. `recoveryNonce` never resets. Kernel's own
`invalidateNonce` voids the old installation. The new root must install the validator again with a **new** Recovery Code
(`onInstall`); on Celo Sepolia a plain `installValidations` of the same validator address works after a recovery (no
uninstall needed).

**Storage.** Everything is keyed by account (ERC-4337 associated storage). The registry is an immutable reference.

### Parameters

| Parameter                         | Value                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Minimum delay (contract constant) | 24 h (`RECOVERY_DELAYS` in `deployments.ts`)                                                |
| Default delay Kaada configures    | 72 h (`RECOVERY_DEFAULT_DELAY_SECONDS`), configurable above the floor via `setDelay`        |
| Recovery key                      | secp256k1 address derived from the Recovery Code; rotated via `setRecoveryKey` or reinstall |

`ShortDelayRecoveryValidator` (`contracts/testnet`) is identical except the floor is 10 s so a Sepolia run need not wait a
day. It is test-only and must never be deployed on a production chain.

### Guarantees and where each is tested

The 49 guarantees proven on Celo Sepolia by `recovery-atomic-probe.ts` split into validator logic (unit tested in
`packages/contracts/src/recovery-validator.test.ts`, in-process EVM) and Kernel behaviour (re-proved against the
production source by `packages/blockchain/src/testnet/recovery-validator-sepolia.ts`):

| Guarantee                                                                                                 | Unit test                                   | Sepolia (Kernel)                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| Hard minimum delay                                                                                        | install: delay floor; short-delay variant   |                                          |
| Recovery key alone / attestor alone cannot start                                                          | initiate: key alone; attestor alone         | yes                                      |
| Signatures bind chain, contract, account, nonce, new validator/data/hook                                  | binding test; digest parity with viem       |                                          |
| High-s, wrong length, bad `v`                                                                             | malformed or malleable signatures           |                                          |
| Exact batch accepted                                                                                      | exact batch validates                       | exact batch succeeds                     |
| 20+ variants refused (extra call, transfer, approve, target, value, order, arg, mode, selector, encoding) | 39 named variants + 300 random mutations    | different batch refused                  |
| Variants leave the recovery pending                                                                       | every variant refused and leaves pending    |                                          |
| Before `executeAfter`                                                                                     | `validAfter` returned equals `executeAfter` | refused by EntryPoint (AA22)             |
| No recovery pending                                                                                       | refused                                     |                                          |
| Replay                                                                                                    | replay fails; nonce strictly increases      | replay fails                             |
| Old root, old validators, sessions rejected                                                               |                                             | yes                                      |
| Cancel by root; signatures not reusable; attestor veto; stranger refused                                  | cancel and veto tests                       | root cancel and veto proved in the probe |
| Re-arm needs a NEW recovery key; old key refused                                                          | after success: replay, burnt key, new key   | yes                                      |

Not covered by unit tests, by design: anything that needs the real Kernel or EntryPoint (selector grants, `InvalidNonce`
voiding, `validAfter` enforcement). Those run on Celo Sepolia.

### Notes for the audit

- Kernel runs the module's `validateUserOp` **before** its own nonce check, so a replay on a voided module shows the
  module's error first; both paths fail.
- The recovery is consumed during validation. If the batch later reverts at execution, the recovery is lost and must be
  re-initiated (fail-safe, never a bypass).
- `currentNonce()` is read from the account during validation (the account's own storage).
- The account must hold gas, or a paymaster restricted to this selector must sponsor the operation.

## TimelockedAttestorRegistry

The shared record of which key is Kaada recovery attestor. Recovery validators depend on ONE function only,
`IAttestorRegistry.currentAttestor() returns (address)`, never on registry internals. Wallets reference the validator,
the validator references the registry (immutable), so rotating the attestor never touches a wallet.

| Role               | Can                                                                                                                                                                                    | Cannot                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**          | `proposeAttestor`, `cancelAttestorRotation`, `finalizeAttestorRotation` (after the delay), `setRotationDelay` (future proposals, none pending), `proposeAdmin` / `cancelAdminTransfer` | Touch any wallet, validator or recovery (the contract makes no external call: its runtime contains no CALL, STATICCALL, DELEGATECALL, CREATE or SELFDESTRUCT, checked in a test); sign or veto a recovery (it is not the attestor); renounce (the admin can never be zero) |
| **Attestor**       | Be the key `currentAttestor()` returns                                                                                                                                                 | Anything in the registry: it has no function there, so it cannot rotate itself, instantly or otherwise                                                                                                                                                                     |
| **Proposed admin** | `acceptAdmin`                                                                                                                                                                          | Anything else until it accepts                                                                                                                                                                                                                                             |

Rotation: `proposeAttestor(new)` records `pendingAttestor` and `executeAfter = now + rotationDelay`; nothing else changes.
`finalizeAttestorRotation()` works only at or after `executeAfter`, clears the proposal (so it cannot finalize twice) and sets
`currentAttestor`. `cancelAttestorRotation()` clears it; a cancelled proposal can never finalize. Zero address and the
current attestor are rejected; only one proposal is pending at a time (a second is refused, even once the first has
matured, until it is finalized or cancelled). The delay is 72 h by default, 24 h hard minimum, 30 days maximum (a typo
cannot lock rotation for years). Admin transfer is two-step; it never changes the attestor or a pending rotation, and a
rotation never changes a pending admin transfer. Not upgradeable; no payable function, no receive/fallback.

Events for audit: `AttestorRotationProposed/Cancelled/Finalized` (with a rotation id), `RotationDelayChanged`,
`AdminTransferProposed/Cancelled/Accepted`; the constructor emits the initial admin, delay and attestor.

**Security assumptions**

- The admin key is a high-value key: it can, after at least 24 h, name a new attestor. A new attestor alone still cannot
  recover a wallet (the Recovery Code signature and the timelock are also required), so admin compromise is a
  delayed, monitored event rather than an instant loss.
- Shortening the rotation delay to the 24 h floor is an admin action; the floor is the assumption, not the default.
- There is no emergency instant rotation by design: a compromised attestor key is replaced after the delay, and until
  then it can only veto or co-sign (never recover alone). Use a multisig (or hardware-backed key) for the admin.
- If admin and attestor are deliberately the same key, role separation is lost; deployment must use different keys.
- A lost admin key means the attestor cannot be rotated (nothing breaks; recovery continues with the current attestor).

`ShortDelayAttestorRegistry` (`contracts/testnet`) lowers the floor to 10 s for Sepolia runs and must never be deployed on a
production chain.

## KaadaPasskeyValidatorFactory

Source: `packages/contracts/contracts/KaadaPasskeyValidatorFactory.sol`; shared derivation: `src/passkey-factory.ts`.

The ZeroDev passkey validator (v0.0.3, the runtime already verified and used by Kaada) stores **one key per Kernel account**.
Kernel's `changeRootValidator` to an instance that is already initialized for the account is a silent no-op that keeps the
old key. So every root credential an account will ever use (initial, recovered, backup, rotated) needs its own
never-initialized instance at an address that can be committed to in advance (the recovery commitment names the new root
validator address). The factory creates those instances as deterministic EIP-1167 clones of the unmodified validator. It
has no owner, no upgrade path, no payable function, no token logic, and never calls an instance except the
`isInitialized` view.

### Exact salt derivation

```
credentialCommitment = keccak256(abi.encode(CREDENTIAL_DOMAIN, x, y, authenticatorIdHash))
    CREDENTIAL_DOMAIN = keccak256("kaada.passkey-credential")
    (x, y, authenticatorIdHash) are exactly the validator's onInstall data: abi.encode((uint256 x, uint256 y), bytes32 idHash)

salt = keccak256(abi.encode(SALT_DOMAIN, FACTORY_VERSION, scope, purpose, credentialCommitment, deploymentSalt))
    SALT_DOMAIN     = keccak256("kaada.passkey-validator-instance")
    FACTORY_VERSION = 1 (uint16)
    scope           = the Kernel account (address(0) only for PRIMARY, see below)
    purpose         = uint8: 0 PRIMARY, 1 RECOVERY, 2 BACKUP, 3 ROTATION (anything else reverts)
    deploymentSalt  = bytes32 chosen by the caller (zero is fine): a fresh instance for the same credential and role

instance = CREATE2(factory, salt, keccak256(initcode))
    initcode = 3d602d80600a3d3981f3 363d3d373d3d3d363d73 <IMPLEMENTATION> 5af43d82803e903d91602b57fd5bf3   (EIP-1167)
```

The address therefore commits to the factory, the exact implementation address, the account, the role, the credential and the
extra salt. Every field is fixed-width in `abi.encode`, so no two different inputs encode alike. `src/passkey-factory.ts`
(`passkeyInstanceSalt`, `predictPasskeyInstance`, `passkeyCredentialCommitment`) is byte-for-byte the same computation,
checked against the contract by unit tests (including a 300-input fuzz).

### Creation-time root

A Kernel account's address is derived from its initialization data, which names its root validator. The first root instance
therefore cannot commit to an account address that depends on it. `scope == address(0)` is accepted **only** for
`PURPOSE_PRIMARY`; the credential and a per-wallet `deploymentSalt` make it unique. This is safe because the validator keeps
its state per account: sharing an address never shares a key. Every later role must use the real, non-zero account, so a
recovery or rotation instance is always bound to the account it recovers.

### API

| Function                                | Purpose                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `credentialCommitment(validatorData)`   | Commitment from the exact install data; rejects bad length or a zero coordinate                                    |
| `saltFor`, `predictInstance`            | The derivation above                                                                                               |
| `isDeployed`                            | Does the predicted address have code?                                                                              |
| `statusOf(scope, account, ...)`         | `NOT_DEPLOYED`, `DEPLOYED_UNUSED` or `INITIALIZED_FOR_ACCOUNT`                                                     |
| `canUseForAccount(scope, account, ...)` | False when the instance is already initialized for `account`; never silently reuse it                              |
| `deploy`                                | Creates the clone if absent. Idempotent: returns `(instance, created)`, emits `InstanceDeployed` only when created |

Rejected inputs: zero scope for any role other than PRIMARY, zero credential commitment, purpose above 3 (and the preflight
refuses a zero `account`). The constructor requires the implementation to have code and its code hash to equal the expected,
pinned hash (`0x726d98…9eea`), and the implementation contains no `SELFDESTRUCT`, `DELEGATECALL`, `CALLCODE`, `CALL`,
`CREATE` or `ADDRESS` opcode (tested), which is what makes it safe behind a delegatecall proxy.

### Front-running and griefing

- **Anyone can deploy any instance, and that is harmless.** A fresh clone has empty storage. The validator writes its key under
  `msg.sender` inside `onInstall`, so only the Kernel account itself (running its own installation) can initialize its own
  entry. An attacker who deploys the instance early, or calls `onInstall` on it directly, only writes an entry for the
  attacker's own address. Tested in-process and on Celo Sepolia.
- **Deployment and initialization do not need to be atomic.** There is nothing to race: initialization is performed by
  Kernel inside the account's own batch (`changeRootValidator`, creation-time `initialize`, or recovery).
- **The attacker cannot occupy the address with other code.** The address is a CREATE2 of the factory with fixed initcode;
  only this factory can produce code there, and only this clone code.
- **The credential commitment in the address is a derivation convention, not enforced on-chain**: the validator does not check
  it. The binding that matters is the data the account installs, and for a recovery that is committed by the recovery
  validator's root commitment (`rootId` + hash of the install data).
- **A deployed instance is useless without the account's own install.** Deploying instances costs the attacker gas and
  yields nothing; the wallet owner pays nothing extra if the instance already exists.

### Assumptions

- The pinned ZeroDev runtime is correct and stateless apart from the per-account mapping (its code was scanned: no
  `SELFDESTRUCT`, no `DELEGATECALL`, no `ADDRESS`, no `CODECOPY`; the only external dependency is the P-256 verification,
  RIP-7212 at `0x100` on Celo).
- The factory address and the implementation address are part of every instance address: a new implementation or a new
  factory (`FACTORY_VERSION`) can never collide with an old address.
- Roles are a label in the salt only; the factory grants no authority to a purpose.
- The factory does not remove or rotate anything: an old instance keeps existing forever. After a rotation it is the
  Kernel-level `invalidateNonce` (part of the same atomic batch) that stops the old key from acting.

### Celo Sepolia proof (30/30)

`packages/blockchain/src/testnet/passkey-factory-sepolia.ts`, real Kernel v3.3, EntryPoint 0.7, the Sepolia copy of the
verified ZeroDev runtime behind clones, software WebAuthn authenticator, RIP-7212 precompile:

- Rotation: clone #1 is the creation-time root (P1); P1 rotates to clone #2 (P2) atomically with `invalidateNonce`. The wallet
  address is unchanged, P2 signs, P1 fails through the root (`AA24`) and through its own old instance (`InvalidNonce`).
  The old instance keeps its code and its initialized entry but cannot act.
- Front-running: an outsider calling `onInstall` on the predicted instance only initializes its own entry; the wallet's is
  untouched and the wallet later installs normally.
- Recovery: `KaadaRecoveryValidator` refuses a commitment to a clone with no code, accepts it once deployed, the exact batch
  switches the root to the predicted clone, P4 signs, P3 fails, replay fails (`NoPendingRecovery`).
- Gas: factory deployment 623,550 (runtime 2,609 B); a clone deployment 70,122 to 70,261 per transaction, including the
  21,000 base cost (about 48,000 execution).

## KaadaDeviceKeyValidator

Source: `packages/contracts/contracts/KaadaDeviceKeyValidator.sol`; shared client/backend definitions: `src/device-key.ts`.

An ERC-7579 validator for Kernel v3.3 whose signers are raw P-256 device keys, for users whose devices cannot do passkeys. It is
used exactly like the passkey validator (a Kernel root or secondary validator), so the Kernel wallet architecture is
unchanged. No owner, no admin, no upgrade path, no `CALL`/`DELEGATECALL`/`CREATE`/`SELFDESTRUCT`, no payable administration,
no secp256k1 or software fallback. Runtime 5,309 bytes.

### Signing domain (exact)

A device key signs, with ECDSA P-256 over SHA-256 (the native "SHA256withECDSA" of WebCrypto, Secure Enclave and Android
Keystore, which hash the message themselves), these 153 bytes:

```
payload = "KaadaDeviceKey/v1"     17 bytes ASCII: domain tag and version
       || chainId                  32 bytes big-endian
       || validator                20 bytes: the validator INSTANCE (the clone address when the root is a clone)
       || account                  20 bytes: the Kernel account (msg.sender of validateUserOp)
       || keyId                    32 bytes
       || userOpHash               32 bytes: the ERC-4337 userOpHash
digest  = sha256(payload)          what the RIP-7212 precompile at 0x100 verifies
```

`userOp.signature` is exactly 96 bytes: `keyId (32) || r (32) || s (32)`, with `0 < r < n` and `0 < s <= n/2` (low-s only).
Anything else (other lengths, zero or out-of-range r or s, a high-s twin, an unknown keyId) returns `SIG_VALIDATION_FAILED`
(1); the validator never reverts on a bad signature. A valid signature returns 0 with no validity window. The domain tag makes a
device signature useless on the passkey validator (whose signed message starts with a WebAuthn authenticator-data hash) and the
other way round; the 96-byte layout is incompatible with the passkey ABI encoding. `signingPayload` and `signingDigest` are
public views, and `deviceKeyPayload`/`deviceKeyDigest` in `src/device-key.ts` are checked against them by tests (including a
100-input fuzz). Clients normalise platform output with `parseDerSignature` (iOS/Android DER) and `normalizeLowS` (WebCrypto
returns raw r||s and can produce high-s).

### Keys and administration

- Install data: `abi.encode(uint256 x, uint256 y, bytes32 keyId)`: the first key. The same 96-byte shape as the passkey install
  data, so `KaadaPasskeyValidatorFactory.credentialCommitment` and the recovery commitment work on it unchanged.
- Per account: up to 16 keys, each with a non-zero `keyId`, an on-curve P-256 point (the contract checks `y² = x³ - 3x + b`, `0 < x, y < p`
  at enrolment), no duplicate `keyId`, and no duplicate point. `keyId` is an opaque id; descriptions such as "iPhone 14" stay off-chain.
- `addKey(keyId, x, y)`, `removeKey(keyId)`, `onInstall`, `onUninstall`, `isInitialized`, `keyCount`, `keyExists`, `keyOf`, `keyIds`.
  Every call is keyed by `msg.sender`, so only the Kernel account itself can change its own keys (through its own execution).
  An outsider that calls `onInstall` only creates an entry under its own address.
- All enrolled keys are equals: any one can sign for the account, and so can add or remove the others. That is the "root policy";
  a stolen enrolled device is full control until another key removes it (or recovery runs), which is why the tier below matters.
- ERC-1271 is intentionally unsupported (`isValidSignatureWithSender` returns `0xffffffff`): Kaada authorizes payments with
  UserOperations only. A device-key root therefore cannot sign dapp login messages.

### Final-key protection

Kernel exposes `rootValidator()`. `removeKey` and `onUninstall` read it from the calling account; while this validator instance is the
current root, removing the last key (or uninstalling) reverts (`CannotRemoveFinalKey`, `CannotUninstallWhileRoot`). A batch that
replaces the root first (`changeRootValidator`, then `removeKey`) is therefore allowed, which is exactly "unless the root is being
replaced". A validator that is not the root may lose its last key. Checked in-process with a settable mock root and live in Kernel.

### Fresh instances (important)

Kernel's `changeRootValidator` to a validator that is **already installed** for the account does not call `onInstall`: its old keys come
back to life. A root must therefore always be a never-used instance. Use `KaadaPasskeyValidatorFactory` with this contract as the
implementation (a second factory deployment; the factory is implementation-agnostic) and one clone per root period; `canUseForAccount`
flags a used one. The contract has no immutables and derives its domain from `address(this)`, so it is safe behind an EIP-1167 clone
(tested: the signature domain, the state and the root check all follow the clone address).

### Platform storage assumptions

| Platform | Expected key storage                                                                                                                                   | Notes                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS      | Secure Enclave P-256 key (`kSecAttrTokenIDSecureEnclave`), non-exportable, user presence / biometry (`.userPresence`) where the device supports it     | Signs with `ecdsaSignatureMessageX962SHA256` (DER; parse and low-s normalise). A device without a Secure Enclave must be treated as unknown.                                                                                                                                   |
| Android  | Hardware-backed Android Keystore key, StrongBox where available (`setIsStrongBoxBacked`), non-exportable, user authentication required where supported | `SHA256withECDSA`; DER output. Key Attestation proves hardware backing when the backend verifies the certificate chain.                                                                                                                                                        |
| Web      | Non-extractable WebCrypto P-256 `CryptoKey` persisted in IndexedDB                                                                                     | **Not hardware-backed.** The key cannot be exported, but any JavaScript running on the origin (including an XSS or a malicious extension with page access) can still ask the browser to sign; browser storage can be cleared; there is no attestation. WebCrypto returns raw r |     | s (normalise to low-s). |

### Security tier (policy input, never a client claim)

`DeviceKeyTier` (in `src/device-key.ts`) is `trusted-device`, `web-non-extractable` or `unknown`. It is assigned by the backend with
`classifyDeviceKey`: `trusted-device` only when a verifier reports a verified platform attestation that binds this exact public key,
reports hardware backing, and matches the server challenge, for a native enrolment channel observed by the server. Missing
evidence, a missing verifier, a platform mismatch, a verifier error or any false flag never upgrades. A web enrolment is capped at
`web-non-extractable`; anything else is `unknown`. The tier lives off-chain (nothing on-chain can verify attestation); spend-limit
policy that uses it is a later component. The real Apple App Attest / Android Key Attestation verifiers are part of the backend work.

### RIP-7212 assumptions

- Celo has the P-256 precompile at `0x100` (gas 3,450), already proven with the passkey validator. The validator treats the call as valid
  only when it returns exactly 32 bytes equal to 1. A chain without the precompile returns success with **empty** data, so every
  signature **fails closed** (tested with a chain that has no precompile). There is no software fallback by design; deploying on such
  a chain would make the root unusable, not insecure.
- Public ERC-4337 bundlers must accept a staticcall to `0x100` during validation. The self-hosted Alto bundler does; other bundlers
  (and ERC-7562 rule sets) should be checked before relying on them.

### Celo Sepolia proof (52/52 plus 8/8), through the self-hosted Alto bundler

`device-key-sepolia.ts` and `device-key-reuse-sepolia.ts` (`KAADA_VIA_ALTO=1`): every operation was sent with
`eth_sendUserOperation` to Alto and executed by Alto's own executor, against the real EntryPoint 0.7, Kernel v3.3 and the real
RIP-7212 precompile. Software P-256 keys.

- Device-key root creates the Kernel; a real UserOperation signed by the device key executes; a signature for another chain id,
  validator, account or an unenrolled key is refused (`AA24`).
- K1 adds K2; both sign; K2 revokes K1; K1 is refused. Removing the last key while the validator is root reverts with
  `CannotRemoveFinalKey` (selector `0x466b423b`, the operation is included with `success = false`) and the key count stays 1.
- Device root to passkey root (batch with `invalidateNonce`): the passkey signs; the old device key is refused through the root and its
  old validator lane is refused (`InvalidNonce`, `0x756688fe`). Passkey root back to a fresh device-key instance: the new key signs, the
  passkey and the old key are refused. The wallet address `0x7665…3cca` never changed.
- Recovery on one wallet, three times, each committing to the predicted clone and its install data: passkey to device key, device key
  to a different device key, device key to passkey. Each time a batch with different install data is refused (`NotTheCommittedBatch`,
  `0xe52331d3`), the exact batch executes, the recovered credential signs, the previous one is refused, and the new root re-arms recovery.
- Fresh instances are required, exactly as predicted: rotating back to an already-used instance U with install data for a new key
  left that key not enrolled (`onInstall` never ran, `AA24`) and revived a previously revoked-by-rotation key (it signed again).

Observed behavior worth knowing:

- Alto accepted the validator's staticcall to the `0x100` precompile during validation; a bad signature is rejected at
  `eth_sendUserOperation` with `AA24 signature error`; a reverting validator (the passkey validator on a foreign signature) shows as
  `AA23 reverted`.
- The RIP-7212 precompile behaved exactly as in the passkey proof: valid low-s signatures verify; nothing else did.

Measured on Sepolia (EntryPoint `actualGasUsed`, which includes the fixed verification and call overhead):

| Item                                                                       | Gas                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Device validator deployment (runtime 5,309 B)                              | 1,199,562                                                 |
| Clone factory deployment (reused implementation-agnostic factory, 2,609 B) | 623,550                                                   |
| Clone deployment (each)                                                    | 70,122 to 70,261 (about 48k execution)                    |
| Plain device-signed operation (validation + one 1-wei transfer)            | 192,463                                                   |
| Plain passkey-signed operation (for comparison)                            | 244,661 to 244,860                                        |
| Account creation with device root + first operation (includes `onInstall`) | 480,833                                                   |
| Operation with `addKey`                                                    | 292,506 (about 100k over a plain operation)               |
| Operation with `removeKey`                                                 | 221,730 (about 29k over a plain operation)                |
| Rotate device root to passkey root (batch with `invalidateNonce`)          | 263,185                                                   |
| Rotate passkey root to a fresh device root (includes `onInstall`)          | 396,833                                                   |
| Recovery batch, to device key / to passkey                                 | 426,771, 392,571 (device to device), 311,328 (to passkey) |

A device-signed operation is about 52k cheaper than a passkey-signed one (no WebAuthn parsing).

### Gas and size

Runtime 5,309 bytes. In-process EVM execution gas (a ratio guide, not a chain figure; clearing storage earns refunds that make
removal look small): `onInstall` about 138k (first key, cold storage), `addKey` about 116k, `removeKey` about 5k to 6k net,
`validateUserOp` about 13k including the 3,450 precompile.

## Tooling

- `pnpm --filter @kaada/contracts generate` compiles every `.sol` with solc-js into `src/generated/artifacts.ts` (EVM
  version `paris`); `build`, `typecheck`, `lint` depend on it through Turborepo.
- Tests run in-process on `@ethereumjs/evm`; no node, no network.
- `src/recovery.ts` is the shared client/backend definition of the typed data, commitment and install data.
