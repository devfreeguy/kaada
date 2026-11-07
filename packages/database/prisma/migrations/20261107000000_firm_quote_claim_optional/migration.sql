-- A firm quote that exists is complete: its id, amounts, accept cutoff and transactions. The encrypted claim token is NOT part of
-- that: a provider that reserves nothing (an AMM such as Uniswap) issues none, and the old rule rejected every one of its quotes
-- with "violates check constraint FirmQuoteAttempt_quoted_is_complete". A provider that does issue one still has it stored and
-- used by the application, which fails the quote if it is missing.
ALTER TABLE "FirmQuoteAttempt" DROP CONSTRAINT "FirmQuoteAttempt_quoted_is_complete";
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_quoted_is_complete" CHECK (
  "status" NOT IN ('QUOTED', 'UNUSABLE', 'EXPIRED')
  OR ("providerQuoteId" IS NOT NULL AND "inputAmount" IS NOT NULL AND "inputAssetId" IS NOT NULL
      AND "outputAmount" IS NOT NULL AND "outputAssetId" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "unsignedTransactions" IS NOT NULL)
);
