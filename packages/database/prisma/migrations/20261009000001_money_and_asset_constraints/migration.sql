-- Hand-written. Prisma cannot express partial unique indexes or CHECK constraints, and it does not
-- manage them: `prisma migrate dev` will neither drop nor regenerate anything in this file.
-- Keep this file separate from generated migrations. See docs/database.md.

-- ───────────── Money: canonical smallest-unit integer strings ─────────────
-- Digits only, no sign, no decimal point, no leading zeros ("0" is the only value starting with 0).

ALTER TABLE "Intent" ADD CONSTRAINT "Intent_amount_integer_string"
  CHECK ("amount" IS NULL OR "amount" ~ '^(0|[1-9][0-9]*)$');

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_amounts_integer_string"
  CHECK (
    "inputAmount" ~ '^(0|[1-9][0-9]*)$'
    AND "outputAmount" ~ '^(0|[1-9][0-9]*)$'
    AND ("feeAmount" IS NULL OR "feeAmount" ~ '^(0|[1-9][0-9]*)$')
  );

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_slippageBps_range"
  CHECK ("slippageBps" IS NULL OR "slippageBps" BETWEEN 0 AND 10000);

ALTER TABLE "Route" ADD CONSTRAINT "Route_amounts_integer_string"
  CHECK (
    "estimatedInput" ~ '^(0|[1-9][0-9]*)$'
    AND "estimatedOutput" ~ '^(0|[1-9][0-9]*)$'
    AND ("totalFeeAmount" IS NULL OR "totalFeeAmount" ~ '^(0|[1-9][0-9]*)$')
  );

ALTER TABLE "RouteStep" ADD CONSTRAINT "RouteStep_amounts_integer_string"
  CHECK (
    "inputAmount" ~ '^(0|[1-9][0-9]*)$'
    AND "outputAmount" ~ '^(0|[1-9][0-9]*)$'
  );

ALTER TABLE "RouteStep" ADD CONSTRAINT "RouteStep_position_non_negative"
  CHECK ("position" >= 0);

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_amounts_integer_string"
  CHECK (
    ("amount" IS NULL OR "amount" ~ '^(0|[1-9][0-9]*)$')
    AND ("gasAmount" IS NULL OR "gasAmount" ~ '^(0|[1-9][0-9]*)$')
    AND ("nonce" IS NULL OR "nonce" ~ '^(0|[1-9][0-9]*)$')
  );

ALTER TABLE "RampSession" ADD CONSTRAINT "RampSession_amount_integer_string"
  CHECK ("amount" IS NULL OR "amount" ~ '^(0|[1-9][0-9]*)$');

-- ───────────── Asset identity ─────────────
-- FIAT:   fiatCode set, no chain, no contract.
-- NATIVE: chain set, no contract.
-- Tokens: chain and contract set. (Fiat-pegged stablecoins may also carry a fiatCode.)

ALTER TABLE "Asset" ADD CONSTRAINT "Asset_shape"
  CHECK (
    ("kind" = 'FIAT' AND "fiatCode" IS NOT NULL AND "chainId" IS NULL AND "contractAddress" IS NULL)
    OR ("kind" = 'NATIVE_ASSET' AND "chainId" IS NOT NULL AND "contractAddress" IS NULL)
    OR (
      "kind" IN ('USD_STABLECOIN', 'LOCAL_STABLECOIN', 'CRYPTO')
      AND "chainId" IS NOT NULL
      AND "contractAddress" IS NOT NULL
    )
  );

ALTER TABLE "Asset" ADD CONSTRAINT "Asset_decimals_range"
  CHECK ("decimals" BETWEEN 0 AND 36);

-- Addresses are stored lowercase so the unique (chainId, contractAddress) cannot be bypassed by case.
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_contractAddress_lowercase"
  CHECK ("contractAddress" IS NULL OR "contractAddress" = lower("contractAddress"));

-- One FIAT row per currency code, one native asset per chain.
CREATE UNIQUE INDEX "Asset_fiatCode_fiat_key" ON "Asset" ("fiatCode") WHERE "kind" = 'FIAT';
CREATE UNIQUE INDEX "Asset_chainId_native_key" ON "Asset" ("chainId") WHERE "kind" = 'NATIVE_ASSET';

-- ───────────── Wallet ─────────────
-- Kaada targets EVM chains (chainId is an EVM chain id), so addresses are stored lowercase.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_address_lowercase"
  CHECK ("address" = lower("address"));

-- At most one primary wallet per user per chain.
CREATE UNIQUE INDEX "Wallet_userId_chainId_primary_key" ON "Wallet" ("userId", "chainId") WHERE "isPrimary";
