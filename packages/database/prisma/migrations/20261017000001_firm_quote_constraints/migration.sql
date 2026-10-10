-- Firm quote and execution plan constraints (hand-written). The database refuses states that would
-- double-spend a provider slot, store a malformed secret, or call a plan READY without a plan.

-- Encrypted execution secrets: a versioned AEAD envelope ("v<key version>.<nonce>.<ciphertext>"), never a
-- bare token. A raw provider token ("rfqc_...") cannot be stored by mistake.
ALTER TABLE "ExecutionSecret" ADD CONSTRAINT "ExecutionSecret_keyVersion_positive" CHECK ("keyVersion" >= 1);
ALTER TABLE "ExecutionSecret" ADD CONSTRAINT "ExecutionSecret_ciphertext_envelope" CHECK ("ciphertext" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');

-- Firm quote attempts: canonical smallest-unit amounts, lower-case addresses.
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_exactAmount_canonical" CHECK ("exactAmount" ~ '^[1-9][0-9]*$');
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_amounts_canonical" CHECK (
  ("inputAmount" IS NULL OR "inputAmount" ~ '^[1-9][0-9]*$')
  AND ("outputAmount" IS NULL OR "outputAmount" ~ '^[1-9][0-9]*$')
  AND ("feeAmount" IS NULL OR "feeAmount" ~ '^(0|[1-9][0-9]*)$')
);
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_addresses_lowercase" CHECK (
  "takerAddress" ~ '^0x[0-9a-f]{40}$'
  AND ("reactor" IS NULL OR "reactor" ~ '^0x[0-9a-f]{40}$')
  AND ("spender" IS NULL OR "spender" ~ '^0x[0-9a-f]{40}$')
);
-- A quote that exists is complete: its id, amounts, accept cutoff, transactions and encrypted claim token.
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_quoted_is_complete" CHECK (
  "status" NOT IN ('QUOTED', 'UNUSABLE', 'EXPIRED')
  OR ("providerQuoteId" IS NOT NULL AND "inputAmount" IS NOT NULL AND "inputAssetId" IS NOT NULL
      AND "outputAmount" IS NOT NULL AND "outputAssetId" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "unsignedTransactions" IS NOT NULL AND "claimSecretId" IS NOT NULL)
);
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_failure_has_code" CHECK (
  "status" NOT IN ('FAILED', 'TIMED_OUT') OR "failureCode" IS NOT NULL
);
-- At most ONE live attempt (requesting or quoted) per authorization and provider: the durable guard
-- that makes a duplicate delivery unable to take a second provider slot.
CREATE UNIQUE INDEX "FirmQuoteAttempt_one_live_per_authorization_key" ON "FirmQuoteAttempt" ("paymentAuthorizationId", "providerId") WHERE "status" IN ('REQUESTING', 'QUOTED');

-- Execution plans: a payment execution knows its wallet, a READY or BLOCKED one carries its plan, and a
-- plan stage is never EXECUTING/COMPLETED (those belong to a later build and other rows).
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_payment_has_wallet" CHECK ("paymentAuthorizationId" IS NULL OR "walletId" IS NOT NULL);
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_ready_has_plan" CHECK ("status" NOT IN ('READY', 'BLOCKED') OR "plan" IS NOT NULL);
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_plan_stage_is_pre_execution" CHECK (
  "paymentAuthorizationId" IS NULL OR "status" IN ('PREPARING', 'READY', 'BLOCKED', 'EXPIRED', 'FAILED')
);
