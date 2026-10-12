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
| Minimum delay (contract constant) | 24 h (`RECOVERY_MIN_DELAY_SECONDS`)                                                         |
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

## Tooling

- `pnpm --filter @kaada/contracts generate` compiles every `.sol` with solc-js into `src/generated/artifacts.ts` (EVM
  version `paris`); `build`, `typecheck`, `lint` depend on it through Turborepo.
- Tests run in-process on `@ethereumjs/evm`; no node, no network.
- `src/recovery.ts` is the shared client/backend definition of the typed data, commitment and install data.
