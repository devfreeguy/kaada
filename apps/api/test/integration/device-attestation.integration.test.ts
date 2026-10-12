/*
 * Device attestation on the REAL database: one-time challenge consumption under real concurrency, the unique "one verified
 * attestation per key" index, and the CHECK constraints that stop the database from recording a tier the proof does not
 * support. Every row belongs to uniquely named test users and is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  TEST_APP,
  createAttestationChain,
  createDeviceKey,
  createTestAuthority,
} from "@kaada/attestation/testing";
import type { TestAuthority } from "@kaada/attestation/testing";
import { createDatabase, createRepositories } from "@kaada/database";
import type { Database } from "@kaada/database";
import { createId } from "@kaada/domain";
import type { NewDeviceAttestation } from "@kaada/domain";

import { DeviceTierService } from "../../src/core/attestation/device-tier-service.js";

void webcrypto;

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

describe("device attestation on the real database", { skip }, () => {
  let database: Database;
  let authority: TestAuthority;
  const users: string[] = [];
  const now = new Date();

  before(async () => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
    authority = await createTestAuthority(now);
  });

  after(async () => {
    const where = { userId: { in: users } };
    await database.client.deviceAttestation.deleteMany({ where });
    await database.client.deviceAttestationChallenge.deleteMany({ where });
    await database.client.wallet.deleteMany({ where });
    await database.client.user.deleteMany({ where: { id: { in: users } } });
    await database.close();
  });

  const repositories = () => createRepositories(database);
  async function newUser(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await repositories().users.create({ id });
    return id;
  }
  const service = () =>
    new DeviceTierService({
      attestations: repositories().deviceAttestations,
      android: {
        applications: [
          { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
        ],
        minimumLevel: "TEE",
        anchors: [authority.anchor],
      },
      now: () => new Date(),
    });

  async function issue(userId: string, walletId?: string) {
    return repositories().deviceAttestations.issueChallenge(
      {
        id: createId(),
        userId,
        ...(walletId && { walletId }),
        platform: "ANDROID",
        purpose: "ROOT_ENROLLMENT",
        nonce: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 300_000),
      },
      new Date(),
    );
  }
  const consume = (challenge: { id: string }, userId: string, walletId?: string) =>
    repositories().deviceAttestations.consumeChallenge({
      id: challenge.id,
      userId,
      walletId,
      platform: "ANDROID",
      purpose: "ROOT_ENROLLMENT",
      publicKeyHash: "ab".repeat(32),
      now: new Date(),
    });

  const attestationRow = (
    userId: string,
    challengeId: string,
    over: Partial<NewDeviceAttestation> = {},
  ): NewDeviceAttestation => ({
    id: createId(),
    userId,
    challengeId,
    platform: "ANDROID",
    attestationType: "ANDROID_KEY_ATTESTATION",
    credentialRef: `0x${randomBytes(32).toString("hex")}`,
    publicKeyHash: randomBytes(32).toString("hex"),
    result: "VERIFIED_QUALIFIED",
    hardwareLevel: "TEE",
    derivedTier: "TRUSTED_DEVICE",
    verifierVersion: 1,
    facts: { packageName: TEST_APP.packageName },
    chainHashes: ["11".repeat(32), "22".repeat(32)],
    trustAnchor: "33".repeat(32),
    verifiedAt: new Date(),
    ...over,
  });

  it("hands a challenge to exactly one of many concurrent consumers", async () => {
    const userId = await newUser();
    const challenge = await issue(userId);
    const results = await Promise.all(Array.from({ length: 20 }, () => consume(challenge, userId)));
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await database.client.deviceAttestationChallenge.findUnique({
      where: { id: challenge.id },
    });
    assert.ok(stored?.consumedAt);
    assert.equal(stored.consumedPublicKeyHash, "ab".repeat(32));
    assert.equal(await consume(challenge, userId), null, "and never again");
  });

  it("binds a challenge to its user, wallet, platform, purpose and lifetime", async () => {
    const userId = await newUser();
    const other = await newUser();
    const wallet = await repositories().wallets.create({
      id: randomUUID(),
      userId,
      chainId: 42220,
      isPrimary: true,
      type: "EMBEDDED",
      status: "PROVISIONING",
      deployment: "NOT_APPLICABLE",
    });
    const forWallet = await issue(userId, wallet.id);
    assert.equal(await consume(forWallet, other, wallet.id), null, "another user");
    assert.equal(await consume(forWallet, userId), null, "no wallet where one was bound");
    assert.ok(await consume(forWallet, userId, wallet.id));

    const stale = await repositories().deviceAttestations.issueChallenge(
      {
        id: createId(),
        userId,
        platform: "ANDROID",
        purpose: "ROOT_ENROLLMENT",
        nonce: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 40),
      },
      new Date(),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await consume(stale, userId), null, "expired");

    const purpose = await issue(userId);
    const wrongPurpose = await repositories().deviceAttestations.consumeChallenge({
      id: purpose.id,
      userId,
      platform: "ANDROID",
      purpose: "RECOVERY_ROOT",
      publicKeyHash: "cd".repeat(32),
      now: new Date(),
    });
    assert.equal(wrongPurpose, null);
    const wrongPlatform = await repositories().deviceAttestations.consumeChallenge({
      id: purpose.id,
      userId,
      platform: "IOS",
      purpose: "ROOT_ENROLLMENT",
      publicKeyHash: "cd".repeat(32),
      now: new Date(),
    });
    assert.equal(wrongPlatform, null);
  });

  it("verifies real evidence end to end, stores hashes and facts, and lets one of many replays win", async () => {
    const userId = await newUser();
    const tiers = service();
    const device = await createDeviceKey();
    const issued = await tiers.issueChallenge({
      userId,
      platform: "ANDROID",
      purpose: "ROOT_ENROLLMENT",
    });
    const certificateChain = await createAttestationChain(
      authority,
      device.key.publicKey,
      { challenge: new Uint8Array(Buffer.from(issued.nonce, "hex")), level: "STRONGBOX" },
      new Date(),
    );
    const evidence = {
      platform: "ANDROID" as const,
      challengeId: issued.challengeId,
      certificateChain,
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        tiers.resolveTier({
          route: "native",
          userId,
          purpose: "ROOT_ENROLLMENT",
          point: device.point,
          evidence,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.tier === "TRUSTED_DEVICE").length, 1);
    assert.equal(results.filter((r) => r.outcome === "CHALLENGE_INVALID").length, 9);

    const rows = await database.client.deviceAttestation.findMany({ where: { userId } });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row?.result, "VERIFIED_QUALIFIED");
    assert.equal(row.hardwareLevel, "STRONGBOX");
    assert.equal(row.derivedTier, "TRUSTED_DEVICE");
    assert.equal(row.chainHashes.length, 3);
    const stored = JSON.stringify(row);
    for (const certificate of certificateChain) {
      assert.equal(stored.includes(certificate), false, "no raw certificate is persisted");
    }
    const read = await repositories().deviceAttestations.findById(row.id);
    assert.equal(read?.facts["packageName"], TEST_APP.packageName);
  });

  it("allows one VERIFIED attestation per key, but any number of rejected ones", async () => {
    const userId = await newUser();
    const hash = randomBytes(32).toString("hex");
    const repo = repositories().deviceAttestations;
    const first = await repo.issueChallenge(
      {
        id: createId(),
        userId,
        platform: "ANDROID",
        purpose: "ROOT_ENROLLMENT",
        nonce: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 300_000),
      },
      new Date(),
    );
    assert.ok(
      await repo.record(attestationRow(userId, first.id, { publicKeyHash: hash }), new Date()),
    );
    const second = await issue(userId);
    assert.equal(
      await repo.record(attestationRow(userId, second.id, { publicKeyHash: hash }), new Date()),
      null,
      "the same key cannot be verified twice",
    );
    assert.equal(
      await repo.record(
        attestationRow(userId, first.id, { publicKeyHash: randomBytes(32).toString("hex") }),
        new Date(),
      ),
      null,
      "one attestation per challenge",
    );
    for (let i = 0; i < 3; i += 1) {
      const challenge = await issue(userId);
      assert.ok(
        await repo.record(
          attestationRow(userId, challenge.id, {
            publicKeyHash: hash,
            result: "REJECTED",
            reason: "CHALLENGE_MISMATCH",
            derivedTier: "UNKNOWN",
          }),
          new Date(),
        ),
      );
    }
  });

  it("makes the database refuse a tier the proof does not support", async () => {
    const userId = await newUser();
    const repo = repositories().deviceAttestations;
    const bad: Partial<NewDeviceAttestation>[] = [
      { result: "REJECTED", reason: "X", derivedTier: "TRUSTED_DEVICE" },
      { result: "VERIFIED_NOT_QUALIFIED", derivedTier: "TRUSTED_DEVICE" },
      { derivedTier: "TRUSTED_DEVICE", hardwareLevel: "SOFTWARE" },
      { derivedTier: "APP_ATTESTED_DEVICE" },
      { platform: "IOS", derivedTier: "TRUSTED_DEVICE" },
      { result: "VERIFIED_NOT_QUALIFIED", derivedTier: "APP_ATTESTED_DEVICE", platform: "IOS" },
      { result: "REJECTED" },
      { credentialRef: "0x12" },
      { publicKeyHash: "xyz" },
      { verifierVersion: 0 },
    ];
    for (const over of bad) {
      const challenge = await issue(userId);
      const { hardwareLevel, ...base } = attestationRow(userId, challenge.id);
      await assert.rejects(
        repo.record(
          {
            ...base,
            ...(over.platform === "IOS" ? {} : { hardwareLevel }),
            ...over,
          },
          new Date(),
        ),
        Error,
        JSON.stringify(over),
      );
    }
    // The honest combinations are accepted.
    const ios = await issue(userId);
    const { hardwareLevel: _level, ...iosBase } = attestationRow(userId, ios.id);
    assert.ok(
      await repo.record(
        {
          ...iosBase,
          platform: "IOS",
          derivedTier: "APP_ATTESTED_DEVICE",
          attestationType: "IOS_APP_ATTEST",
        },
        new Date(),
      ),
    );
  });

  it("deletes expired unused challenges and keeps the ones an attestation refers to", async () => {
    const userId = await newUser();
    const repo = repositories().deviceAttestations;
    const old = new Date(Date.now() - 3_600_000);
    const make = (expiresAt: Date) =>
      repo.issueChallenge(
        {
          id: createId(),
          userId,
          platform: "ANDROID",
          purpose: "ROOT_ENROLLMENT",
          nonce: randomBytes(32).toString("hex"),
          // A challenge must expire after it was created: create it in the past.
          expiresAt,
        },
        new Date(expiresAt.getTime() - 1000),
      );
    const unused = await make(old);
    const used = await make(new Date(old.getTime() + 1));
    await repo.record(attestationRow(userId, used.id), new Date());
    const removed = await repo.deleteChallengesExpiredBefore(new Date(), 100);
    assert.ok(removed >= 1);
    assert.equal(
      await database.client.deviceAttestationChallenge.findUnique({ where: { id: unused.id } }),
      null,
    );
    assert.ok(
      await database.client.deviceAttestationChallenge.findUnique({ where: { id: used.id } }),
    );
  });

  it("refuses a challenge that expires before it was created", async () => {
    const userId = await newUser();
    await assert.rejects(
      repositories().deviceAttestations.issueChallenge(
        {
          id: createId(),
          userId,
          platform: "ANDROID",
          purpose: "ROOT_ENROLLMENT",
          nonce: randomBytes(32).toString("hex"),
          expiresAt: new Date(Date.now() - 1000),
        },
        new Date(),
      ),
    );
    await assert.rejects(
      repositories().deviceAttestations.issueChallenge(
        {
          id: createId(),
          userId,
          platform: "ANDROID",
          purpose: "ROOT_ENROLLMENT",
          nonce: "not-hex",
          expiresAt: new Date(Date.now() + 1000),
        },
        new Date(),
      ),
    );
  });
});
