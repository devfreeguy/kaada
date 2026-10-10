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
