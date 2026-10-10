-- Hand-written. Prisma cannot express partial unique indexes or CHECK constraints and does not manage them.

-- One non-revoked EMBEDDED wallet per user and chain: a retry or a concurrent call can never create a second
-- active smart account for the same user. A REVOKED wallet frees the slot (history is kept).
CREATE UNIQUE INDEX "Wallet_embedded_per_user_chain_key"
  ON "Wallet" ("userId", "chainId")
  WHERE "type" = 'EMBEDDED' AND "status" <> 'REVOKED';

-- An ACTIVE wallet always has an address; only a PROVISIONING one may not have derived it yet.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_active_has_address"
  CHECK ("status" <> 'ACTIVE' OR "address" IS NOT NULL);

-- A smart account is never "deployed" unless it is an embedded wallet with an address.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_deployment_shape"
  CHECK (
    ("type" = 'EXTERNAL' AND "deployment" = 'NOT_APPLICABLE')
    OR ("type" = 'EMBEDDED' AND ("deployment" = 'NOT_APPLICABLE' OR "address" IS NOT NULL))
  );

-- Passkey public coordinates are 32 bytes of lower-case hex; a revoked credential stays for history.
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_key_hex"
  CHECK ("publicKeyX" ~ '^[0-9a-f]{64}$' AND "publicKeyY" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_signCount_nonnegative"
  CHECK ("signCount" >= 0);

-- A delegated permission cannot be unbounded: it names contracts, assets and operations, has a per-transaction
-- limit (the NOT NULL columns), and a window that ends after it starts. Contract addresses are lower-case.
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_bounded"
  CHECK (
    cardinality("allowedOperations") > 0
    AND cardinality("allowedContracts") > 0
    AND cardinality("allowedAssetIds") > 0
    AND "expiresAt" > "validFrom"
  );
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_amounts_integer_string"
  CHECK (
    "perTransactionAmount" ~ '^(0|[1-9][0-9]*)$'
    AND ("cumulativeAmount" IS NULL OR "cumulativeAmount" ~ '^(0|[1-9][0-9]*)$')
    AND ("cumulativeAmount" IS NULL) = ("cumulativeAssetId" IS NULL)
  );
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_contracts_lowercase"
  CHECK (array_to_string("allowedContracts", ',') = lower(array_to_string("allowedContracts", ',')));
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_revoked_has_time"
  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL));
