-- Hand-written. Prisma cannot express expression indexes and does not manage them.
--
-- A capability is identified by provider + type + chain + input asset + output asset + country,
-- where the last four may be NULL ("not narrowed"). Postgres treats NULLs as distinct in a plain
-- unique constraint, so the key maps NULL to a sentinel that no real value can equal. This makes a
-- duplicate capability impossible even under concurrent seed runs. Seeding stays a find-or-create.

CREATE UNIQUE INDEX "ProviderCapability_identity_key" ON "ProviderCapability" (
  "providerId",
  "capability",
  COALESCE("chainId", -1),
  COALESCE("inputAssetId", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("outputAssetId", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("countryCode", '--')
);
