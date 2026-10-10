# Onchain execution, Textile submit and settlement (Build 13)

This is the first stage that can move funds. It is **off** unless `EXECUTION_ENABLED=true`, and with it on, startup
fails unless the bundler, the secret key, the kernel wallet stack, Textile pricing and the passkey settings are all
configured. Read "What was and was not verified" before enabling it with any value.

```
Execution READY (Build 12)
  -> recheck: authorization, firm quote window, intent revision, wallet, fresh balance, permission, allowance, gas
  -> [account missing / permission missing]  REQUIRES_USER_ACTION -> root action (passkey) -> chain read-back -> READY
  -> acquire:  lock the row, require READY, consume the PaymentAuthorization, READY -> SIGNING     (one winner)
  -> [APPROVAL_RESET (USDT-style, only if needed)] -> APPROVAL (exact amount) -> allowance visible on chain
  -> SWAP + PAYOUT in ONE UserOperation:  SUBMITTING -> SUBMITTED
  -> receipt (userOpHash -> txHash)  -> SETTLING:  POST /v2/rfq/{id}/submit {txHash}, GET /v2/rfq/{id}
  -> filled and inside the authorized bounds  -> COMPLETED  (claim token tombstoned)
```

`COMPLETED` is reached only through `SETTLING`, and `SETTLING` only after the swap UserOperation is **included and
successful on chain**. There is no `READY -> COMPLETED`. "Payment sent" is shown only for `COMPLETED`.

## Who signs what

| Step                                                        | Signer                                                | How                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy the smart account, install the restricted permission | the person's **passkey** (root)                       | The server prepares the UserOperation and its hash; the browser returns an assertion over exactly that hash; the adapter encodes it. No root key exists anywhere. The PIN is never involved. |
| Approval, swap, payout                                      | a per-permission **session key**, restricted on chain | `ValidatedExecutionSigner.signValidatedExecution(executionId)` - the only entry point.                                                                                                       |

The signer takes an execution id and nothing else (no bytes, calldata, address, amount, PIN or credential). It re-loads
the execution, re-validates the authorization against the operation (as of the moment the authorization was
consumed), re-derives the plan from stored facts plus fresh read-only chain state, checks the permission **on chain**,
builds the next unsent step itself, writes its `Transaction` row **before** sending, and sends once. A step that was
sent, or may have been, is never sent again.

### The on-chain restriction of the permission (one payment)

Call policy: `approve(spender, amount)` only on the sell token, spender pinned to the quote's, `amount <=` the exact
allowance the quote needs; `transfer(to, amount)` only on the buy token, `to` pinned to the recipient, `amount <=` the
firm output; the swap target (any function, no native value); native value 0 everywhere. Timestamp policy: a 15-minute
window. The session key is generated per permission, stored only as AES-256-GCM ciphertext bound to its record, and
decrypted only inside `sendDelegatedCalls`.

Textile has no recipient field, so the swap pays the **wallet** and the recipient is paid by a `transfer` in the same
UserOperation. The batch is atomic: if the swap delivers less than the transfer, everything reverts and nothing is paid.

## The execution lock and the authorization

`ExecutionPlanRepository.acquire` runs in one database transaction: `SELECT ... FOR UPDATE` on the execution, require
`READY`, consume the `PaymentAuthorization` (`ACTIVE` and unexpired), set `SIGNING` and `authorizationConsumedAt`. Many
racing callers produce exactly one winner; a failure rolls both back. The consumption therefore happens immediately
before the first irreversible payment step - **not** on quote, plan, deployment or permission install. A failure after
that point keeps the authorization consumed (no silent replay); the person authorizes again. A database check
(`Execution_consumed_before_signing`) refuses any payment status from `SIGNING` on without `authorizationConsumedAt`.

If the firm quote has too little time left, **one** refresh is allowed under the same authorization (a new firm quote,
within its attempt cap). The second time it is a stop (`REAUTHORIZATION_REQUIRED`), not a loop.

## Never blindly resending

- Every irreversible step has a `Transaction` row with a unique `idempotencyKey` (`exec:<id>:<STEP>`), created **before**
  the send. A row that exists but was never marked sent becomes `UNKNOWN`; it is reconciled, not resent.
- `BUNDLER_REJECTED` (definite: the bundler refused it) marks the step failed. Any other error after a send began
  (timeout, dropped connection) marks it `UNKNOWN`. An RPC outage while waiting for a receipt is not a failure.
- `userOpHash` and `txHash` are stored separately. A reverted inclusion fails the payment.
- After an approval is confirmed, the chain must **show** the allowance before the swap is sent.

## Settlement

`COMPLETED` needs (1) the swap UserOperation included and successful, and (2) the provider reporting the order
`filled`. The settled amounts are then checked against what the person authorized (EXACT_INPUT: input within the
authorized input and output at least the minimum; EXACT_OUTPUT: output at least the exact amount and input within the
maximum). Outside the bounds the execution is `FAILED` with `SETTLEMENT_POLICY_VIOLATION` and audited; the
authorization stays consumed. A failed or expired order that the provider says could still flip to filled is a state to
keep watching (`PAYMENT_PENDING`), never a verdict. The provider `submit` is a documented courtesy, idempotent for the
same hash; an unreachable provider is pending, not failed.

The claim token is decrypted only for the request that needs it and tombstoned (`ExecutionSecret.ciphertext = NULL`,
`tombstonedAt`) once the order is done or the execution failed. It is never logged and never part of an error.

## Recovery

`ExecutionRunner.run(executionId)` reads persisted state every time and continues from there, so it is safe to call
again at any point. `reconcile()` (a timer, `EXECUTION_RECONCILE_INTERVAL_SECONDS`, plus a first pass shortly after
start; no queue) runs every unfinished execution. Running it twice, concurrently, or after a crash is safe because the
lock is a conditional database update.

## User-facing states

`ROOT_ACTION_REQUIRED` ("Confirm wallet setup to continue payment") - `PROCESSING_PAYMENT` - `PAYMENT_SENT` -
`PAYMENT_PENDING` ("don't send it again") - `PAYMENT_FAILED` - `REAUTHORIZATION_REQUIRED` - `GAS_FUNDING_REQUIRED` -
`INSUFFICIENT_BALANCE` - `EXECUTION_ROUTE_UNSUPPORTED`. The API returns a state, a sentence and (for failures) a short
code. Never a claim token, UserOperation internals, calldata, a hash or an amount.

HTTP (`/api/v1`): `POST execution/run`, `GET execution/status`, `POST execution/root-action-link` (Bearer = the
authorization link token); `GET root-action/view`, `GET root-action/options`, `POST root-action/complete` (Bearer = the
opaque root-action link token; the body is the passkey assertion and nothing else).

## Gas

There is **no paymaster**: the smart account itself must hold native CELO. Below `EXECUTION_MIN_NATIVE_WEI` the person
sees `GAS_FUNDING_REQUIRED` before anything is consumed. A paymaster can be added later behind `KernelExecutionPort`.

## Not in this build

Same-asset direct transfers (deferred to Build 13.1; a same-asset payment has no swap and is not planned), multi-hop
execution (still `EXECUTION_ROUTE_UNSUPPORTED`), Telegram/WhatsApp, recovery, scheduled/recurring payments, treasury
automation, a paymaster, arbitrary signing.

## What was and was not verified

Verified offline (no network, chain or signer): the state machine, the lock under concurrency (in memory and on the
real database), authorization consumption and rollback, idempotency, the signer boundary and its refusals, never
resending after an ambiguous send, outage handling, settlement bounds, the claim-token lifecycle, secrets never in
audit/logs/Transactions, the passkey assertion encoding (against the validator's ABI), the policy construction, and
the source-scan guards.

**NOT verified, because it needs a funded wallet, a real bundler and a real Textile order:**

- the real ZeroDev/Kernel adapter (`packages/blockchain/src/execution/zerodev-kernel-adapter.ts`) has been type-checked
  against the pinned SDK versions and its pure parts tested, but **has never been run against a bundler or a chain**;
- that explicit `installValidations`-style installation of the permission through the SDK helper succeeds, and that the
  serialized permission account (marked pre-installed) is accepted on first use;
- that the call policy treats an omitted selector on the swap target as "any function" (the SDK pads it to
  `0x00000000`; its on-chain meaning was not confirmed);
- that a permission id (derived from policies and signer) read back from the account proves the policy _parameters_;
  it proves the permission exists with the intended signer and policy set, and the parameters are the ones in the enable
  data the passkey signed in the same operation;
- Textile's `submit`/status behaviour beyond its documentation, and the exact order of the user-visible states at the
  provider;
- ERC-4337 on Celo is not described in Textile's documentation; the bundler requirement is Kaada's, not Textile's.

Do not run this with meaningful funds. A first live test should use a throwaway wallet, a tiny amount and exactly one
payment, and the observed sequence should be written back here.

## Testing policy and testnet readiness (decided after Build 13)

No Celo mainnet execution testing during development (no budget for real CELO/USDT or a paid mainnet bundler). Mainnet
stays read-only (and Textile preview). Execution is validated in three separate places, and **nothing below is a
Celo/Textile end-to-end validation; that happens once, at the end, on mainnet, if budget permits**:

1. **Celo testnet (Celo Sepolia, chain 11142220)** - the Kernel/ERC-4337 side only: derivation, passkey root, bundler,
   deployment, permission install/read-back, restricted signing, receipts, restart.
2. **Textile test environment (BNB testnet 97, Base Sepolia 84532)** - the provider contract only: firm RFQ, exact
   input/output, claim token, approvals, submit, status, slots, failures. Not a change to Kaada's Celo architecture.
3. **Offline** - fake bundler, scripted Textile, PostgreSQL integration, deterministic plans.

### Findings: Celo Sepolia, read-only (chain id confirmed 11142220 via `eth_chainId` on the official Forno RPC)

Contract code at the SDK's pinned addresses (`eth_getCode`; the same addresses as mainnet):

| Contract                                                                             | Celo Sepolia                    |
| ------------------------------------------------------------------------------------ | ------------------------------- |
| EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`                         | present                         |
| Kernel v3.3 implementation, factory, meta factory                                    | present                         |
| CallPolicy v0.0.4, TimestampPolicy, ECDSA signer                                     | present                         |
| **Passkey (WebAuthn) validator v0.0.3 `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`** | **ABSENT** (present on mainnet) |

So the passkey root validator does not exist on Celo Sepolia. A testnet run of the passkey path needs either a copy of
that validator deployed there by us (its address is a parameter of the SDK) or a different root for testnet only. This
is a testnet-fixture decision, not a change to the production design. Celo Sepolia chain facts (from the Celo docs): RPC
`https://forno.celo-sepolia.celo-testnet.org`, Blockscout `celo-sepolia.blockscout.com`, faucets at
`faucet.celo.org/celo-sepolia` and the Google Cloud Web3 faucet. Alfajores (44787) is being retired.

The configured ZeroDev project answers HTTP 402 ("No Plan found for projectId") on every call, so that URL is unusable
for any network until a plan exists. No bundler for Celo Sepolia has been confirmed yet.

The RIP-7212 P-256 precompile (`0x100`) accepts a valid signature on **both** Celo Sepolia and mainnet (checked with a
freshly generated key; it returns `1`). The SDK's own list of precompile networks does not include Celo Sepolia, so the
adapter now takes an explicit `KernelNetwork` (chain, optional passkey-validator address, `p256Precompile`) that
defaults to Celo mainnet. The Daimo fallback P-256 verifier is absent on Sepolia, so the testnet must use the
precompile path.

Decided: bundler = an Alchemy key for Celo Sepolia (separate `BUNDLER_URL` for the testnet run), and the passkey
validator is deployed to Celo Sepolia from a faucet-funded throwaway key as a testnet-only fixture.

## Celo Sepolia validation (testnet; Kernel / ERC-4337 side only)

Run with `packages/blockchain/src/testnet/celo-sepolia-harness.ts` (standalone; state and throwaway keys live outside
the repository; nothing imports it; mainnet configuration untouched). Chain 11142220, faucet CELO only, a
**software** P-256 passkey (not a real browser authenticator), the passkey-validator fixture deployed to Sepolia (runtime
byte-identical to mainnet), the RIP-7212 precompile path. **Nothing here validates Textile, USDT, wBRL or Celo mainnet.**

### Verified on Celo Sepolia

| Property                                                                            | Result                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counterfactual Kernel v3.3 address from a passkey root (with the fixture validator) | derived; no code until first use                                                                                                                                                                                                                                                            |
| Deployment + permission install                                                     | **one** UserOperation does both (account `initCode`, then `installValidations` + `grantAccess`); `UserOperationEvent.success = true`; account is a 61-byte proxy; root validator = the fixture                                                                                              |
| Passkey root signing                                                                | an assertion over the server-fixed challenge (= the UserOperation hash) is encoded by the adapter and accepted on chain through the P-256 precompile                                                                                                                                        |
| Permission installation                                                             | succeeded with the **corrected** install calls (see below)                                                                                                                                                                                                                                  |
| Permission read-back                                                                | exact: `permissionConfig(id)` returns the ECDSA signer module and the ordered policy contracts; the id matches only for the exact scope. A changed spender reads back `false`                                                                                                               |
| Policy parameters verifiable on chain?                                              | **Yes, by id.** Kernel's permission id hashes the policy contracts _and their data_ (call rules, timestamp window) plus the signer, so an id match proves the exact parameters. The window is part of that hash                                                                             |
| Omitted selector                                                                    | **NOT a wildcard.** It is the literal selector `0x00000000`: an arbitrary call to the swap target was refused. The scope now pins the swap's real 4-byte selector (`swapSelector`)                                                                                                          |
| Restricted session-key signing                                                      | `approve(spender, 1000)` on the token succeeded; allowance read 1000. A swap-shaped call (pinned selector) plus `transfer(recipient, 100)` in one batch succeeded; the recipient received exactly the amount                                                                                |
| Refusals (estimation only, nothing sent)                                            | approve to another spender; approve above the limit; transfer to another recipient; transfer above the payout limit; a different selector on the swap target; native value on the swap target; an unlisted address; an unlisted selector (`transferFrom`) - all refused in `validateUserOp` |
| Receipts and restart                                                                | a brand-new adapter recovers each operation from its stored `userOpHash` (bundler, with a chain fallback on the EntryPoint `UserOperationEvent`) and confirms the account, allowance and permission from persisted state                                                                    |

### Defects the validation found (all fixed offline and covered by tests)

1. **Wrong install calls.** The SDK helper `getValidatorPluginInstallModuleData` is for ordinary validators; for a permission it reverts with
   no reason. The install is `installValidations(0x02 ++ permissionId, {nonce, hook}, enableData)` plus `grantAccess(id, execute, true)`,
   as the SDK's own `toInitConfig` does.
2. **Omitted selector** was assumed to mean "any function" (it does not); the real swap selector is now pinned (and a calldata without one is a plan blocker).
3. **Read-back used a fresh window.** The permission id hashes the validity window, so read-back with a window recomputed from "now" could
   never match; read-back now uses the stored permission's window (`installedScope`).
4. **Stub signature** selected the on-chain fallback P-256 verifier, which does not exist on Sepolia (validation reverts, `AA23`); the stub now follows the network's precompile flag.
5. **Fee estimation** used `zd_getUserOperationGasPrice`, a ZeroDev-only method; Alchemy answers "Unsupported method". Fees now come from the chain.
6. **RPC node lag.** Immediately after inclusion an RPC node can be a block behind: the permission read-back returned `false` and the next
   operation was rejected with `AA25 invalid account nonce`. The runner now waits until its RPC node has seen a transaction before reading or building the next step.
7. **Receipt lookup** depended on one bundler's index; it now falls back to the chain.

### Open: the Alchemy Celo Sepolia bundler does not mine

Capability check passed (chain id, EntryPoint v0.7 among the supported entry points, `eth_getUserOperationReceipt` present). But **three
operations** sent through its `eth_sendUserOperation` (root, delegated, and a one-wei probe) were **accepted and never bundled** (10+ minutes), although
`EntryPoint.handleOps` simulated cleanly on the chain for the same operation and the operations mined when submitted directly (the harness's
`HARNESS_SUBMIT=self`, a testnet-only seam; it is not wired into the application). Cause unknown. Until a bundler lands operations on
Celo Sepolia, "real bundler inclusion" is **not** verified; consider a self-hosted bundler or another provider.

### Not verified (still open)

A real browser passkey (only a software authenticator was used); USDT and the USDT reset-to-zero path (the test token was CELO's ERC-20 face, which
does not need one); the `ExecutionRunner` end to end on a chain (it was exercised against fakes and the real database, and its pieces against
Sepolia, not as one run); bundler inclusion (above); Textile (not touched); anything on Celo mainnet.
