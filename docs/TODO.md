# TODO

Things we chose not to build yet, and the decisions that now stand in their way. Read the relevant section before building the feature.

## Scheduled, recurring and other unattended payments

Not built. Examples: "send ₦5,000 to @daniel every Friday", a payment at a set time, standing orders, auto top-ups.

**Why it is blocked today.** A direct transfer is now confirmed by the person's own wallet root (a passkey, or a device key plus the PIN),
which signs the transfer itself (`RootPaymentService`, `docs/authorization.md`). Nothing is installed on chain for Kaada's server-held
session key, so **the server cannot move funds unless the person is on the confirmation page at that moment.** That is deliberate: it
removed the standing authority a stolen server key could have used. A scheduled payment needs exactly that authority, so it cannot ride on
this path.

**What to do when we build it** (do not reuse the per-payment flow; add a separate, clearly consented one):

1. A **standing permission**, installed once with the root, that lets the session key `transfer` ONE token to ONE pinned recipient (or an
   allow-listed set), up to a per-payment cap and a cumulative cap per period, valid for a bounded time (renewed by the root). The call-policy
   machinery already exists (`policiesForScope` in `packages/blockchain`, `PermissionScope`, `ValidatedExecutionSigner.signTransfer`,
   `buildTransferPlan`'s permission requirement). Reinstate it as the path for scheduled runs only.
2. A **schedule record** (owner, recipient, token, amount, cadence, next run, end date, status) with its own consent screen showing the
   whole commitment (who, how much, how often, until when, the cap) and a root signature (passkey, or device key plus PIN) to create it.
3. A **runner** that, at the due time, creates a payment authorization from the schedule (not from a PIN), runs it through the existing
   execution path, and records the result. It must respect the double-spend guard (`hasSpendingExecution`), the per-period cap, and the
   balance and CELO-fee checks (`RootPaymentService.shortfall`, the runner's fee reserve).
4. **Failure handling:** insufficient balance, missing CELO for the fee, recipient wallet changed, permission expired. Tell the person on
   Telegram, never retry blindly, and pause the schedule after repeated failures.
5. **Cancel and pause** in the chat and on the web, effective immediately (revoke the permission on chain when the schedule ends).

**Changes that already affect it (so we remember what to revisit):**

- Direct transfers no longer install a permission, so the standing permission from step 1 must be requested explicitly. The old per-payment
  permission (15 minutes, one recipient, one amount) is still used by swap payments.
- `PaymentAuthorization` is created from a PIN or from a root proof (`PaymentAuthorizationService.authorizeVerified`). A scheduled run needs a
  third source ("a schedule the person consented to"). Add it there, with the schedule id on the record, rather than bypassing it.
- The authorization page asks `GET /authorization/root/method` which way to confirm; a scheduled flow does not use it.
- `ExecutionRunner.transferFromReady` still handles a delegated (session-key) transfer; it is the right place for scheduled runs, and is
  currently exercised only by tests and the swap-style permission flow.
- Native CELO sends reserve the network fee (`isNativeCelo`, `enoughForFees`, the runner and `RootPaymentService`): a scheduled CELO send
  must keep the same reserve.
- The `@username` / "him" recipient resolution (`recipient-resolver.ts`, `coordinator.withPreviousRecipient`) resolves at confirmation time.
  A schedule must pin the resolved wallet address when it is created and say so, because a username can change hands.

## Swap payments with the passkey

Payments that need a conversion (a swap through Textile) still use the older flow: PIN, then a one-time passkey step to install a
permission. Moving them to a single passkey confirmation means batching approve, swap and payout into one root-signed operation. Do this
after the direct-transfer path has run on real devices.

## Other

- Invite flow for people who are not on Kaada yet (a `@username` with no account).
- Index on `Identity.username` if the table grows large (lookups are case-insensitive).
- Persistent Docker logs on the API host (journald), so logs survive a redeploy.
