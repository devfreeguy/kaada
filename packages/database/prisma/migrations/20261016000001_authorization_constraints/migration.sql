-- Authorization constraints (hand-written). The database, not the application, refuses states that
-- would make the PIN or an approval unsafe.

-- PIN state: counters are never negative, and only an Argon2id hash may be stored.
ALTER TABLE "TransactionPinSecurity" ADD CONSTRAINT "TransactionPinSecurity_counters_nonnegative" CHECK ("failedAttempts" >= 0 AND "lockLevel" >= 0);
ALTER TABLE "TransactionPinSecurity" ADD CONSTRAINT "TransactionPinSecurity_hash_is_argon2id" CHECK ("pinHash" LIKE '$argon2id$%');

-- Authorization sessions: the token is stored only as a SHA-256 digest, a token exists iff it was
-- issued, time moves forward, and the terminal fields agree with the status.
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_tokenHash_sha256" CHECK ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_token_issued_together" CHECK (("tokenHash" IS NULL) = ("tokenIssuedAt" IS NULL));
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_used_iff_authorized" CHECK (("status" = 'AUTHORIZED') = ("usedAt" IS NOT NULL));
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_reason_iff_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelReason" IS NOT NULL));
-- One live session per user, intent revision and route: duplicate deliveries share it.
CREATE UNIQUE INDEX "AuthorizationSession_one_pending_key" ON "AuthorizationSession" ("userId", "intentId", "intentRevision", "routeId") WHERE "status" = 'PENDING';

-- Payment authorizations: canonical positive smallest-unit amounts, a bounded life, terminal fields
-- that agree with the status, and at most ONE active approval per intent.
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_operation_pays" CHECK ("operation" IN ('SEND', 'CONVERT'));
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_amounts_canonical" CHECK ("maxInputAmount" ~ '^[1-9][0-9]*$' AND "minOutputAmount" ~ '^[1-9][0-9]*$');
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_consumed_iff_consumed" CHECK (("status" = 'CONSUMED') = ("consumedAt" IS NOT NULL));
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_revoked_iff_revoked" CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL) AND ("revocationReason" IS NULL OR "status" = 'REVOKED'));
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_recipient_address_lowercase" CHECK ("recipientAddress" IS NULL OR "recipientAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_chain_positive" CHECK ("chainId" > 0 AND "intentRevision" >= 1);
-- The route shape starts at the funding asset and ends at the destination asset.
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_path_matches_assets" CHECK (cardinality("routeAssetPath") >= 1 AND "routeAssetPath"[1] = "inputAssetId" AND "routeAssetPath"[cardinality("routeAssetPath")] = "outputAssetId");
CREATE UNIQUE INDEX "PaymentAuthorization_one_active_per_intent_key" ON "PaymentAuthorization" ("intentId") WHERE "status" = 'ACTIVE';
