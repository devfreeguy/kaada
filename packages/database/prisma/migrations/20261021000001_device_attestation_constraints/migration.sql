-- A challenge is a 32-byte nonce, consumed at most once, and consumed together with the key it was consumed for.
ALTER TABLE "DeviceAttestationChallenge" ADD CONSTRAINT "DeviceAttestationChallenge_wellformed" CHECK (
  "nonce" ~ '^[0-9a-f]{64}$'
  AND ("consumedAt" IS NULL) = ("consumedPublicKeyHash" IS NULL)
  AND ("consumedPublicKeyHash" IS NULL OR "consumedPublicKeyHash" ~ '^[0-9a-f]{64}$')
  AND "expiresAt" > "createdAt"
);

-- An attestation record holds hashes and facts only, and names its key.
ALTER TABLE "DeviceAttestation" ADD CONSTRAINT "DeviceAttestation_wellformed" CHECK (
  "credentialRef" ~ '^0x[0-9a-f]{64}$'
  AND "publicKeyHash" ~ '^[0-9a-f]{64}$'
  AND "verifierVersion" > 0
  AND ("result" <> 'REJECTED' OR "reason" IS NOT NULL)
  -- The tier follows the proof: only a qualified Android hardware key is TRUSTED_DEVICE, only a verified iOS app instance is
  -- APP_ATTESTED_DEVICE, and anything not qualified is UNKNOWN. The database refuses any other combination.
  AND ("derivedTier" <> 'TRUSTED_DEVICE' OR ("platform" = 'ANDROID' AND "result" = 'VERIFIED_QUALIFIED' AND "hardwareLevel" IN ('STRONGBOX', 'TEE')))
  AND ("derivedTier" <> 'APP_ATTESTED_DEVICE' OR ("platform" = 'IOS' AND "result" = 'VERIFIED_QUALIFIED'))
  AND ("result" = 'VERIFIED_QUALIFIED' OR "derivedTier" = 'UNKNOWN')
);

-- A key can hold at most one VERIFIED attestation: the same evidence cannot be presented a second time, for another challenge.
CREATE UNIQUE INDEX "DeviceAttestation_one_verified_per_key"
  ON "DeviceAttestation" ("platform", "publicKeyHash") WHERE "result" IN ('VERIFIED_QUALIFIED', 'VERIFIED_NOT_QUALIFIED');
