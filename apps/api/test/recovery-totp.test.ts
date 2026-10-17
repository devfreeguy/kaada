import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RateLimiter } from "../src/core/authorization/rate-limiter.js";
import { RecoveryTotpService } from "../src/core/recovery/recovery-totp.js";
import {
  TOTP_WINDOW_STEPS,
  base32Decode,
  base32Encode,
  matchTotp,
  newTotpSecret,
  otpauthUri,
  stepAt,
  totpAtStep,
} from "../src/core/recovery/totp.js";
import { AesGcmSecretCipher } from "../src/infrastructure/security/aes-gcm-cipher.js";
import { RedisRateLimiter } from "../src/infrastructure/redis/redis-rate-limiter.js";
import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";

/*
 * The authenticator-app factor: the RFC 6238 primitive against its published vectors, enrolment that only completes on a real
 * code, replay protection that survives concurrency and restarts, encryption at rest, and the Redis limiter that fails closed.
 */

/** RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("RFC 6238 time-based one-time passwords", () => {
  it("matches the published SHA-1 vectors (6 digits: the last 6 of each 8-digit value)", () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, expected] of vectors) {
      assert.equal(totpAtStep(RFC_SECRET, Math.floor(seconds / 30)), expected, String(seconds));
    }
  });

  it("round-trips base32 and generates a fresh 160-bit secret every time", () => {
    for (const length of [1, 5, 10, 20, 33]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 255));
      assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
    }
    const a = newTotpSecret();
    const b = newTotpSecret();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(a).length, 20);
    // Authenticator apps show secrets in groups and lower case: both decode.
    assert.deepEqual(base32Decode(`${a.slice(0, 8)} ${a.slice(8).toLowerCase()}`), base32Decode(a));
  });

  it("accepts the previous, current and next step and nothing else", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta++) {
      assert.equal(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + delta), now), step + delta);
    }
    for (const delta of [-3, -2, 2, 3]) {
      assert.equal(
        matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + delta), now),
        null,
        String(delta),
      );
    }
  });

  it("rejects anything that is not exactly six digits, and a code from another secret", () => {
    const now = 1_700_000_000_000;
    const good = totpAtStep(RFC_SECRET, stepAt(now));
    for (const bad of ["", "12345", "1234567", "abcdef", ` ${good}`, `${good} `, "٣٣٣٣٣٣"]) {
      assert.equal(matchTotp(RFC_SECRET, bad, now), null, JSON.stringify(bad));
    }
    assert.equal(matchTotp(newTotpSecret(), good, now), null);
  });

  it("builds the standard otpauth:// provisioning URI that Google Authenticator, Authy and 1Password read", () => {
    const secret = newTotpSecret();
    const uri = otpauthUri({ secret, issuer: "Kaada", account: "ada@example.com" });
    const parsed = new URL(uri);
    assert.equal(parsed.protocol, "otpauth:");
    assert.equal(parsed.host, "totp");
    assert.equal(decodeURIComponent(parsed.pathname), "/Kaada:ada@example.com");
    assert.equal(parsed.searchParams.get("secret"), secret);
    assert.equal(parsed.searchParams.get("issuer"), "Kaada");
    assert.equal(parsed.searchParams.get("algorithm"), "SHA1");
    assert.equal(parsed.searchParams.get("digits"), "6");
    assert.equal(parsed.searchParams.get("period"), "30");
  });
});

describe("authenticator enrolment", () => {
  async function fresh() {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: false });
    return { world, user };
  }

  it("is not complete until a valid code is entered; a wrong code completes nothing", async () => {
    const { world, user } = await fresh();
    const enrolment = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    assert.equal(await world.totp.isEnrolled(user.wallet.id), false, "pending protects nothing");
    const now = world.now().getTime();
    const wrong = totpAtStep(enrolment.secret, stepAt(now) + 7);
    await expectKaada(
      world.totp.confirm({ userId: user.userId, walletId: user.wallet.id, code: wrong }),
      "RECOVERY_REJECTED",
    );
    for (const bad of ["", "12345", "abcdef", null, undefined, 123456]) {
      await expectKaada(
        world.totp.confirm({ userId: user.userId, walletId: user.wallet.id, code: bad }),
        "RECOVERY_REJECTED",
      );
    }
    assert.equal(await world.totp.isEnrolled(user.wallet.id), false);
    await world.totp.confirm({
      userId: user.userId,
      walletId: user.wallet.id,
      code: totpAtStep(enrolment.secret, stepAt(now)),
    });
    assert.equal(await world.totp.isEnrolled(user.wallet.id), true);
  });

  it("only the wallet's own user can confirm it", async () => {
    const { world, user } = await fresh();
    const other = await world.createUser({ armed: false, authenticator: false });
    const enrolment = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    const code = totpAtStep(enrolment.secret, stepAt(world.now().getTime()));
    await expectKaada(
      world.totp.confirm({ userId: other.userId, walletId: user.wallet.id, code }),
      "RECOVERY_REJECTED",
    );
    assert.equal(await world.totp.isEnrolled(user.wallet.id), false);
  });

  it("starting again replaces an unconfirmed secret, and the old secret then confirms nothing", async () => {
    const { world, user } = await fresh();
    const first = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    const second = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    assert.notEqual(first.secret, second.secret);
    const now = world.now().getTime();
    await expectKaada(
      world.totp.confirm({
        userId: user.userId,
        walletId: user.wallet.id,
        code: totpAtStep(first.secret, stepAt(now)),
      }),
      "RECOVERY_REJECTED",
    );
    await world.totp.confirm({
      userId: user.userId,
      walletId: user.wallet.id,
      code: totpAtStep(second.secret, stepAt(now)),
    });
    assert.equal(world.recovery.totps.filter((t) => t.status === "ACTIVE").length, 1);
  });

  it("a completed enrolment cannot be replaced by starting another", async () => {
    const { world, user } = await fresh();
    const enrolment = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    await world.totp.confirm({
      userId: user.userId,
      walletId: user.wallet.id,
      code: totpAtStep(enrolment.secret, stepAt(world.now().getTime())),
    });
    await expectKaada(
      world.totp.begin({ userId: user.userId, walletId: user.wallet.id, accountName: user.email }),
      "RECOVERY_REJECTED",
    );
  });
});

describe("authenticator secrets at rest", () => {
  it("are stored only as AES-256-GCM ciphertext, bound to their record, and never appear in the database or the audit trail", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const row = world.recovery.totps.find(
      (t) => t.walletId === user.wallet.id && t.status === "ACTIVE",
    )!;
    assert.match(row.encryptedSecret, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!JSON.stringify(world.recovery.totps).includes(user.authenticatorSecret ?? "?"));
    assert.ok(!JSON.stringify(world.wallet.audit).includes(user.authenticatorSecret ?? "?"));
    // Decrypts only with the right key AND the right record: a copy moved to another wallet is garbage.
    const context = `recovery-totp:${row.walletId}:${row.id}`;
    assert.equal(world.totpCipher.decrypt(row.encryptedSecret, context), user.authenticatorSecret);
    assert.throws(() =>
      world.totpCipher.decrypt(row.encryptedSecret, `recovery-totp:${row.walletId}:other`),
    );
    assert.throws(() =>
      world.totpCipher.decrypt(row.encryptedSecret, `recovery-totp:other:${row.id}`),
    );
    const otherKey = new AesGcmSecretCipher([
      { version: 1, key: Buffer.alloc(32, 5).toString("base64") },
    ]);
    assert.throws(() => otherKey.decrypt(row.encryptedSecret, context));
  });

  it("a ciphertext copied onto another wallet's row verifies nothing there", async () => {
    const world = createRecoveryWorld();
    const victim = await world.createUser();
    const attacker = await world.createUser();
    const victimRow = world.recovery.totps.find((t) => t.walletId === victim.wallet.id)!;
    const attackerRow = world.recovery.totps.find((t) => t.walletId === attacker.wallet.id)!;
    attackerRow.encryptedSecret = victimRow.encryptedSecret;
    world.advance(31_000);
    // Neither the victim's code nor the attacker's own code works against a swapped ciphertext.
    for (const person of [victim, attacker]) {
      await expectKaada(
        world.totp.verifyAndConsume({
          userId: attacker.userId,
          walletId: attacker.wallet.id,
          code: world.authenticatorCode(person),
        }),
        "RECOVERY_REJECTED",
      );
    }
  });

  it("a secret rotated to a new encryption key still decrypts with the previous key during rotation", () => {
    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const newKey = Buffer.alloc(32, 2).toString("base64");
    const before = new AesGcmSecretCipher([{ version: 1, key: oldKey }]).encrypt("SECRET", "ctx");
    const during = new AesGcmSecretCipher([
      { version: 2, key: newKey },
      { version: 1, key: oldKey },
    ]);
    assert.equal(during.decrypt(before.ciphertext, "ctx"), "SECRET");
    assert.match(during.encrypt("SECRET", "ctx").ciphertext, /^v2\./);
  });
});

describe("replay protection and rate limits", () => {
  it("the same code is accepted once, in order, and never again", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const ids = { userId: user.userId, walletId: user.wallet.id };
    const code = world.authenticatorCode(user);
    const first = await world.totp.verifyAndConsume({ ...ids, code });
    assert.equal(first.step, stepAt(world.now().getTime()));
    await expectKaada(world.totp.verifyAndConsume({ ...ids, code }), "RECOVERY_REJECTED");
    // An OLDER step is refused even though the window would allow it: steps only move forward.
    const older = totpAtStep(user.authenticatorSecret!, stepAt(world.now().getTime()) - 1);
    await expectKaada(world.totp.verifyAndConsume({ ...ids, code: older }), "RECOVERY_REJECTED");
    world.advance(31_000);
    assert.ok(await world.totp.verifyAndConsume({ ...ids, code: world.authenticatorCode(user) }));
  });

  it("two simultaneous uses of one code: exactly one wins", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const ids = { userId: user.userId, walletId: user.wallet.id };
    const code = world.authenticatorCode(user);
    const results = await Promise.allSettled([
      world.totp.verifyAndConsume({ ...ids, code }),
      world.totp.verifyAndConsume({ ...ids, code }),
      world.totp.verifyAndConsume({ ...ids, code }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  it("the spent step survives a restart: a brand-new service over the same storage still refuses the code", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const ids = { userId: user.userId, walletId: user.wallet.id };
    const code = world.authenticatorCode(user);
    await world.totp.verifyAndConsume({ ...ids, code });
    const restarted = new RecoveryTotpService({
      totps: world.repositories.recoveryTotps,
      audit: world.repositories.audit,
      cipher: world.totpCipher,
      now: world.now,
    });
    await expectKaada(restarted.verifyAndConsume({ ...ids, code }), "RECOVERY_REJECTED");
  });

  it("a wallet without an enrolment says so, and another user's wallet is never checked", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: false });
    const other = await world.createUser();
    await expectKaada(
      world.totp.verifyAndConsume({
        userId: user.userId,
        walletId: user.wallet.id,
        code: "123456",
      }),
      "RECOVERY_TOTP_REQUIRED",
    );
    await expectKaada(
      world.totp.verifyAndConsume({
        userId: user.userId,
        walletId: other.wallet.id,
        code: world.authenticatorCode(other),
      }),
      "RECOVERY_TOTP_REQUIRED",
    );
  });

  it("guessing is rate limited per wallet: after the budget even the right code is refused", async () => {
    const world = createRecoveryWorld({ totpLimiter: new RateLimiter(5, 10 * 60 * 1000) });
    const user = await world.createUser({ armed: false, authenticator: false });
    const enrolment = await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    const ids = { userId: user.userId, walletId: user.wallet.id };
    for (let i = 0; i < 5; i++) {
      await expectKaada(
        world.totp.confirm({
          ...ids,
          code:
            "000000" === totpAtStep(enrolment.secret, stepAt(world.now().getTime()))
              ? "111111"
              : "000000",
        }),
        "RECOVERY_REJECTED",
      );
    }
    await expectKaada(
      world.totp.confirm({
        ...ids,
        code: totpAtStep(enrolment.secret, stepAt(world.now().getTime())),
      }),
      "RECOVERY_RATE_LIMITED",
    );
    assert.equal(await world.totp.isEnrolled(user.wallet.id), false);
  });

  it("the Redis limiter FAILS CLOSED: when Redis is down, no code is checked at all", async () => {
    const down = new RedisRateLimiter(
      { eval: () => Promise.reject(new Error("redis down")) },
      { name: "recovery:totp", limit: 10, windowMs: 600_000 },
    );
    const world = createRecoveryWorld({ totpLimiter: down });
    const user = await world.createUser({ armed: false, authenticator: false });
    await world.totp.begin({
      userId: user.userId,
      walletId: user.wallet.id,
      accountName: user.email,
    });
    await expectKaada(
      world.totp.confirm({ userId: user.userId, walletId: user.wallet.id, code: "123456" }),
      "RECOVERY_RATE_LIMITED",
    );
  });
});

describe("a recovery survives a restart of the services", () => {
  it("a fresh finalizer (a new process, a new lease owner) over the same storage carries a pending recovery to its end", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await world.startRecovery(user);
    world.advance(72 * 3600 * 1000 + 10_000);
    // "Restart": the services above the storage are rebuilt; the storage and the chain are what remember.
    const outcome = await world.finalizer("restarted-process").finalize(attempt.id);
    assert.equal(outcome.outcome, "ROOT_CHANGED");
    assert.equal(
      (await world.repositories.recoveryAttempts.findById(attempt.id))?.status,
      "ROOT_CHANGED",
    );
  });
});
