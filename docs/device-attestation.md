# Device attestation

How Kaada decides, from proof, where a device key lives. Nothing a client says ever raises a tier.

## Tiers

| Tier (internal)       | Product label                    | What the server has proven                                                                                                                                                                                                                                                                                                                                        | What it has NOT proven                                                                                                                                            |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUSTED_DEVICE`      | Hardware-verified device         | A Google-rooted, unrevoked chain certifies that **exactly this P-256 key** was generated inside Android secure hardware (TEE or StrongBox, per policy), is sign-only, was attested for **this one-time server challenge**, the device boots verified with a locked bootloader, and the key belongs to an allow-listed app (package + signing-certificate digest). | The person. That the app was not repackaged _and_ signed by us is covered by the signing digest; a rooted device that still reports verified boot is not covered. |
| `APP_ATTESTED_DEVICE` | Verified app on a genuine device | An Apple-rooted attestation says a **genuine instance of our app** (App ID hash) on **genuine Apple hardware** presented this wallet public key for this one-time challenge.                                                                                                                                                                                      | That the wallet key itself is in the Secure Enclave. See "iOS".                                                                                                   |
| `WEB_NON_EXTRACTABLE` | Browser-protected key            | Only that it enrolled through the web route. Never attested. JavaScript on the origin can still ask the key to sign.                                                                                                                                                                                                                                              | Everything else.                                                                                                                                                  |
| `UNKNOWN`             | Unverified key                   | Nothing: native key with no, failed, software-only or non-qualifying evidence, and passkeys.                                                                                                                                                                                                                                                                      |                                                                                                                                                                   |

Ranking: `UNKNOWN` < `WEB_NON_EXTRACTABLE` < `APP_ATTESTED_DEVICE` < `TRUSTED_DEVICE`.
`deriveDeviceTier` (`packages/domain/src/attestation`) is the one deterministic policy; the database also refuses combinations the proof does not support (migration `device_attestation_constraints`).

## Android trust model

- Verifier: `packages/attestation/src/android.ts`, version `ANDROID_VERIFIER_VERSION` (stored with every result).
- Trust anchors, pinned by SHA-256 in `roots.ts` (fetched from Google over HTTPS on 2026-10-12):
  - Hardware Attestation Root (RSA, 2022-2042) `cedb1cb6…0dfc`
  - Key Attestation CA1 (EC, 2025-2035) `6d9db4ce…bcc0`
    A chain must end at a pinned root (byte-identical) or at a certificate issued and signed by one. Nothing in the evidence can add a root: a self-signed or other-vendor chain (incl. the software-attestation root) is `CHAIN_UNTRUSTED_ROOT`. **Rotation:** Google publishes new roots rarely; add the new root next to the old ones (never replace first), ship, then retire the old one after devices have moved. The fingerprints are asserted in tests.
- Revocation: Google's list (`ATTESTATION_REVOCATION_URL`), serials in decimal and hex spellings, cached, **fail-closed** (unreachable and no recent copy → evidence refused, `REVOCATION_UNAVAILABLE`).
- Checks, in order: base64/DER, chain signatures + CA flags + validity at `now`, revocation, key description extension present and parseable, leaf public key is P-256 and **equals the enrolled key**, `attestationChallenge` **equals the issued nonce**, key not created before the challenge was issued.
- Then policy (a failing item makes the evidence _authentic but not qualifying_ → `UNKNOWN`, recorded as shortfalls): attestation and keymaster security level both ≥ the minimum (`ATTESTATION_ANDROID_MIN_LEVEL`, default TEE; the weaker of the two counts); attestation version ≥ 3; hardware-enforced purpose is sign (and optionally verify) only; EC / P-256 / SHA-256; origin = generated on device; verified boot + locked bootloader; exactly one package and every signing digest in the allow-list (`ATTESTATION_ANDROID_APPS`). Properties are read from the **hardware-enforced list only**; the same claim in the software list is not trusted.
- Assumptions: Google's roots and the device OEM's attestation key are trustworthy; revoked keys appear on Google's list; Android Keystore enforces what it attests.
- `pnpm --filter @kaada/attestation verify:android <evidence.json> pkg=<digest>` runs a real device's chain through the production verifier (Google roots).

### Android client (reference)

```kotlin
val nonce = hexToBytes(challenge.nonce)           // from POST .../attestation/challenge
val spec = KeyGenParameterSpec.Builder("kaada-root", KeyProperties.PURPOSE_SIGN)
    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setAttestationChallenge(nonce)               // bind the key to the server's challenge
    .setIsStrongBoxBacked(strongBoxAvailable)     // optional; falls back to TEE
    .build()
KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    .apply { initialize(spec) }.generateKeyPair()
val chain = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    .getCertificateChain("kaada-root").map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
// send: { platform: "ANDROID", challengeId, certificateChain: chain } with the public key and proof of possession
```

## iOS trust model (read this before assuming parity)

1. **What App Attest proves:** a genuine, unmodified instance of the app (rpIdHash = SHA-256(TeamID.BundleID)) on genuine Apple hardware generated an _App Attest key_; the credential certificate chains to Apple's App Attestation root (pinned: `1cb9823b…c932`) and carries a nonce = SHA-256(authData ‖ clientDataHash).
2. **Can it bind the exact Secure Enclave wallet key?** No. The attested key is a separate App Attest key whose private half cannot sign arbitrary data.
3. **Does the Secure Enclave attest ordinary keys to apps?** No; iOS exposes no such attestation.
4. **What Kaada states:** "a genuine Kaada app on genuine Apple hardware presented this wallet key for this challenge". The wallet point is bound **by claim**, hashed into the client data: `clientDataHash = SHA-256("KaadaAppAttest/v1" ‖ challenge ‖ x ‖ y)`. The verifier returns `provesWalletKeyHardware: false`, and it is stored with the facts.
5. **Tier:** `APP_ATTESTED_DEVICE`, never `TRUSTED_DEVICE`. Counter must be 0, keyId = SHA-256(key point), App ID allow-listed (`ATTESTATION_IOS_APP_IDS`), environment `appattest`; `appattestdevelop` only with `ATTESTATION_IOS_ALLOW_DEVELOPMENT` (refused in production). Apple's fraud-metric receipt is not used.

## Enrolment flow (all three paths: setup, root change, recovery)

1. Native client asks for a challenge: `POST wallet/device-keys/attestation/challenge`, `POST wallet/root/attestation/challenge` (`kind`), `POST recovery/root/attestation/challenge`. Server stores a 32-byte random nonce, TTL `ATTESTATION_CHALLENGE_TTL_SECONDS` (30-900, default 300), bound to **user, wallet (absent for a first wallet), platform, purpose**.
2. Device generates the P-256 key attested to that nonce (Android: `setAttestationChallenge`; iOS: `generateKey` + `attestKey(clientDataHash)`).
3. Device registers on the **native route** (`wallet/device-keys/native/register`, `wallet/root/native/changes`, `recovery/root/device-key/native`) with the public key, the usual proof of possession and `attestation`.
4. Server consumes the challenge **atomically and first** (one verification attempt per challenge, however it ends), verifies, records a `DeviceAttestation` (hashes and extracted facts, never the raw chain), derives the tier, stores the credential with that tier, and continues.
5. Missing, failed or non-qualifying evidence never blocks enrolment: the key is recorded as `UNKNOWN`.

**Public key binding.** An Android attestation challenge is given at key generation, before the public key exists server-side, so the challenge cannot name the key. The binding is the attested leaf certificate: its public key must equal the enrolled key, and the key hash is written to the challenge when it is consumed. A chain for another key, or for another challenge, is rejected; a second verified attestation for the same key is refused by a unique index.

**Web.** The web routes use strict schemas: a body with `attestation`, `tier`, `hardwareBacked`, … is a 400. The services also refuse evidence on the web route, before spending anything. Nothing is inferred from user agent, OS or `navigator`.

**Tiers never rise.** After a credential exists its tier can only fall (`canChangeTier`): an existing key cannot be re-attested, because attestation is made at generation. `DeviceTierService.reevaluate` re-derives a stored attestation under today's policy for revocation sweeps or policy tightening.

## Configuration

`DEVICE_ATTESTATION_ENABLED` (needs `DEVICE_KEY_ROOTS_ENABLED` and an app identity), `ATTESTATION_ANDROID_APPS` (`pkg=sha256hex|sha256hex,…`), `ATTESTATION_ANDROID_MIN_LEVEL`, `ATTESTATION_IOS_APP_IDS`, `ATTESTATION_IOS_ALLOW_DEVELOPMENT`, `ATTESTATION_CHALLENGE_TTL_SECONDS`, `ATTESTATION_REVOCATION_URL`, `ATTESTATION_REVOCATION_CACHE_SECONDS`. With no app configured nothing can rise above `UNKNOWN`, so that combination refuses to start.

## Validation status

Verified with generated chains under a private test CA (unit and real-Postgres tests), not with real hardware: **no physical Android device or iPhone was available**, and an emulator/simulator would not prove anything. A real device must be run through `verify:android` (Android) and an App Attest object through `verifyAppAttest` before this is relied on in production. Open points: the exact encoding of a real device's key description across OEMs (a non-standard ordering parser exists but is untested on hardware), and Apple App Attest on a real iPhone.
