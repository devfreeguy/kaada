import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { PIN_ATTEMPT_POLICY, isKaadaError } from "@kaada/domain";

import { PinEnrollmentService } from "../src/core/authorization/pin-enrollment.js";
import { TransactionPinService } from "../src/core/authorization/pin-service.js";
import type { AuthorizationUnitOfWork } from "../src/core/authorization/ports.js";
import { RateLimiter } from "../src/core/authorization/rate-limiter.js";
import { PasskeyService } from "../src/core/wallets/passkey-service.js";
import {
  Argon2PinHasher,
  PIN_ARGON2_PARAMS,
} from "../src/infrastructure/auth/argon2-pin-hasher.js";
import { SimpleWebAuthnVerifier } from "../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { createAuthorizationStores } from "./support/authorization-memory.js";
import { TestPinHasher } from "./support/payment-world.js";
import { createSoftwareAuthenticator } from "./support/software-authenticator.js";
import { createWalletService, createWalletWorld } from "./support/wallet-memory.js";

const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";
// Not 1234 or 0000: easy to spot if it ever leaks into a log, an audit row or a stored message.
const PIN = "7351";
const WRONG = "2468";

function build() {
  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const now = () => clock.now;
  const stores = createAuthorizationStores(now);
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const uow = {
    read: stores.repositories,
    transaction: (work: (r: typeof stores.repositories) => Promise<unknown>) =>
      work(stores.repositories),
  } as unknown as AuthorizationUnitOfWork;
  const hasher = new TestPinHasher();
  const pins = new TransactionPinService({
    unitOfWork: uow,
    hasher,
    now,
    log: (level, event, fields) => void logs.push({ level, event, fields }),
  });
  return { clock, stores, pins, hasher, logs, userId: randomUUID() };
}

describe("PIN storage", () => {
  it("creates a PIN for a user and replaces it later", async () => {
    const b = build();
    assert.equal(await b.pins.setPin(b.userId, PIN), "CREATED");
    assert.equal((await b.pins.status(b.userId)).isSet, true);
    assert.equal(await b.pins.setPin(b.userId, WRONG), "CHANGED");
    assert.deepEqual(await b.pins.verify(b.userId, WRONG), { status: "VERIFIED" });
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "INVALID");
  });

  it("accepts exactly four digits, including weak-looking ones, and nothing else", async () => {
    const b = build();
    for (const weak of ["0000", "1111", "1234", "9999"]) {
      await b.pins.setPin(b.userId, weak);
      assert.equal((await b.pins.verify(b.userId, weak)).status, "VERIFIED");
    }
    for (const bad of ["123", "12345", "12a4", "", " 123", "1 23", "١٢٣٤", "-123", "12.4"]) {
      await assert.rejects(b.pins.setPin(b.userId, bad), (e) => isKaadaError(e, "PIN_REJECTED"));
    }
  });

  it("stores an Argon2id hash with the documented parameters", async () => {
    const hasher = new Argon2PinHasher();
    const hash = await hasher.hash(PIN);
    assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    assert.deepEqual(PIN_ARGON2_PARAMS, { memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    assert.equal(await hasher.verify(hash, PIN), true);
    assert.equal(await hasher.verify(hash, WRONG), false);
    assert.equal(
      await hasher.verify("not-a-hash", PIN),
      false,
      "a malformed hash is a failed check",
    );

    const b = build();
    await b.pins.setPin(b.userId, PIN);
    assert.match(b.stores.pins.get(b.userId)?.pinHash ?? "", /^\$argon2id\$/);
  });

  it("a pepper makes the hash unverifiable without it", async () => {
    const peppered = new Argon2PinHasher({
      pepper: "p".repeat(32),
      params: { memoryCost: 8, timeCost: 1, parallelism: 1 },
    });
    const hash = await peppered.hash(PIN);
    assert.equal(await peppered.verify(hash, PIN), true);
    const without = new Argon2PinHasher({ params: { memoryCost: 8, timeCost: 1, parallelism: 1 } });
    assert.equal(await without.verify(hash, PIN), false);
  });

  it("never persists the PIN, in the PIN row, the audit trail or the logs", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    await b.pins.verify(b.userId, WRONG);
    await b.pins.verify(b.userId, PIN);
    const everything = JSON.stringify([[...b.stores.pins.values()], b.stores.audit, b.logs]);
    assert.equal(everything.includes(PIN), false);
    assert.equal(everything.includes(WRONG), false);
    const row = JSON.stringify([...b.stores.pins.values()]);
    assert.equal(/"pin":/.test(row), false);
    // The hash never appears in the audit trail or logs either.
    const hash = b.stores.pins.get(b.userId)?.pinHash ?? "";
    assert.equal(JSON.stringify([b.stores.audit, b.logs]).includes(hash), false);
  });

  it("audits creation and change without any secret", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    await b.pins.setPin(b.userId, WRONG);
    const types = b.stores.audit.map((e) => e.type);
    assert.deepEqual(types, ["authorization.pin_created", "authorization.pin_changed"]);
  });
});

describe("PIN verification and lockout", () => {
  it("verifies the correct PIN", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    assert.deepEqual(await b.pins.verify(b.userId, PIN), { status: "VERIFIED" });
  });

  it("reports a wrong PIN with the attempts left, not the PIN", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    assert.deepEqual(await b.pins.verify(b.userId, WRONG), {
      status: "INVALID",
      attemptsRemaining: 2,
    });
    assert.deepEqual(await b.pins.verify(b.userId, WRONG), {
      status: "INVALID",
      attemptsRemaining: 1,
    });
  });

  it("locks after three wrong attempts, and respects the lock even for the right PIN", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    await b.pins.verify(b.userId, WRONG);
    await b.pins.verify(b.userId, WRONG);
    const third = await b.pins.verify(b.userId, WRONG);
    assert.equal(third.status, "INVALID");
    assert.ok(third.status === "INVALID" && third.attemptsRemaining === 0 && third.lockedUntil);

    const checksBefore = b.hasher.verifyCalls;
    const locked = await b.pins.verify(b.userId, PIN);
    assert.equal(locked.status, "LOCKED");
    assert.equal(b.hasher.verifyCalls, checksBefore, "a locked PIN is not even hashed against");

    b.clock.now = new Date(b.clock.now.getTime() + 5 * 60_000 + 1);
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "VERIFIED");
    const types = b.stores.audit.map((e) => e.type);
    assert.ok(types.includes("authorization.pin_locked"));
    assert.ok(types.includes("authorization.pin_unlocked"));
    assert.ok(types.includes("authorization.pin_verification_failed"));
  });

  it("locks for longer each time: 5 minutes, 15 minutes, then an hour", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    const lockOnce = async () => {
      let last;
      for (let i = 0; i < PIN_ATTEMPT_POLICY.maxAttempts; i += 1) {
        last = await b.pins.verify(b.userId, WRONG);
      }
      return last?.status === "INVALID" ? last.lockedUntil : undefined;
    };
    const minutes: number[] = [];
    for (let level = 0; level < 4; level += 1) {
      const until = await lockOnce();
      assert.ok(until);
      minutes.push((until.getTime() - b.clock.now.getTime()) / 60_000);
      b.clock.now = new Date(until.getTime() + 1);
    }
    assert.deepEqual(minutes, [5, 15, 60, 60]);
  });

  it("a correct PIN clears the failures and the ladder", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    await b.pins.verify(b.userId, WRONG);
    await b.pins.verify(b.userId, WRONG);
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "VERIFIED");
    // Two more wrong guesses are again only two: the earlier ones were forgiven.
    assert.deepEqual(await b.pins.verify(b.userId, WRONG), {
      status: "INVALID",
      attemptsRemaining: 2,
    });
    assert.equal(b.stores.pins.get(b.userId)?.lockLevel, 0);
  });

  it("a burst of parallel guesses never exceeds the attempt budget", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => b.pins.verify(b.userId, WRONG)),
    );
    assert.equal(b.hasher.verifyCalls, PIN_ATTEMPT_POLICY.maxAttempts, "three guesses, no more");
    assert.equal(results.filter((r) => r.status === "INVALID").length, 3);
    assert.equal(results.filter((r) => r.status === "LOCKED").length, 9);
  });

  it("a correct PIN racing wrong ones is decided deterministically and safely", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    const results = await Promise.all([
      b.pins.verify(b.userId, WRONG),
      b.pins.verify(b.userId, PIN),
      b.pins.verify(b.userId, WRONG),
      b.pins.verify(b.userId, WRONG),
      b.pins.verify(b.userId, PIN),
    ]);
    // Three attempts are admitted in arrival order; the rest hit the lock. The right PIN is only ever
    // VERIFIED if it was admitted, and nobody gets more than three checks.
    assert.equal(b.hasher.verifyCalls <= PIN_ATTEMPT_POLICY.maxAttempts, true);
    assert.deepEqual(
      results.map((r) => r.status),
      ["INVALID", "VERIFIED", "INVALID", "LOCKED", "LOCKED"],
    );
  });

  it("a malformed value is not a guess: it costs no attempt", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    for (const bad of ["1", "abcd", "12345", ""]) {
      assert.equal((await b.pins.verify(b.userId, bad)).status, "INVALID_FORMAT");
    }
    assert.deepEqual(await b.pins.verify(b.userId, WRONG), {
      status: "INVALID",
      attemptsRemaining: 2,
    });
  });

  it("no PIN, or a PIN flagged for recovery, cannot be verified", async () => {
    const b = build();
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "NOT_SET");
    await b.pins.setPin(b.userId, PIN);
    await b.pins.requireReset(b.userId, "TEST");
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "RESET_REQUIRED");
    assert.equal((await b.pins.status(b.userId)).resetRequired, true);
  });

  it("forgot PIN has no self-service reset: recovery is required", () => {
    const b = build();
    assert.deepEqual(b.pins.forgotPin(), { status: "PIN_RESET_REQUIRED", supported: false });
  });

  it("the lock belongs to the user, so nothing else can reset it", async () => {
    const b = build();
    await b.pins.setPin(b.userId, PIN);
    for (let i = 0; i < 3; i += 1) await b.pins.verify(b.userId, WRONG);
    // Another caller path (a new session, another device) goes through the same user row.
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "LOCKED");
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "LOCKED");
  });
});

describe("changing the PIN needs a strong credential", () => {
  async function enrolled() {
    const b = build();
    const wallet = createWalletWorld();
    const { service: wallets } = createWalletService(wallet, { now: () => b.clock.now });
    const passkeys = new PasskeyService({
      unitOfWork: wallet.unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now: () => b.clock.now,
    });
    const authenticator = createSoftwareAuthenticator();
    const registration = await passkeys.beginRegistration(b.userId);
    await passkeys.completeRegistration(
      b.userId,
      authenticator.register({ challenge: registration.challenge, origin: ORIGIN, rpId: RP_ID }),
    );
    await wallets.ensureEmbeddedWallet(b.userId);
    const enrollment = new PinEnrollmentService({ passkeys, pins: b.pins, wallets });
    let counter = 0;
    const assertion = async () => {
      const options = await enrollment.begin(b.userId);
      counter += 1;
      return authenticator.authenticate({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        counter,
      });
    };
    return { b, enrollment, assertion, authenticator, wallets, passkeys };
  }

  it("asks for a passkey assertion with user verification", async () => {
    const { b, enrollment } = await enrolled();
    const options = await enrollment.begin(b.userId);
    assert.equal(options.userVerification, "required");
    assert.equal(options.rpId, RP_ID);
    assert.equal(options.allowCredentials.length, 1);
  });

  it("creates and then changes the PIN only with a valid fresh assertion", async () => {
    const { b, enrollment, assertion } = await enrolled();
    assert.equal(
      await enrollment.complete(b.userId, { pin: PIN, assertion: await assertion() }),
      "CREATED",
    );
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "VERIFIED");
    assert.equal(
      await enrollment.complete(b.userId, { pin: WRONG, assertion: await assertion() }),
      "CHANGED",
    );
    assert.equal((await b.pins.verify(b.userId, WRONG)).status, "VERIFIED");
  });

  it("the old PIN alone cannot change the PIN, and neither can a missing or foreign assertion", async () => {
    const { b, enrollment } = await enrolled();
    await b.pins.setPin(b.userId, PIN);
    await assert.rejects(enrollment.complete(b.userId, { pin: WRONG, assertion: {} }), (e) =>
      isKaadaError(e, "CREDENTIAL_REJECTED"),
    );
    // An assertion from another authenticator does not belong to this user.
    const stranger = createSoftwareAuthenticator();
    const options = await enrollment.begin(b.userId);
    await assert.rejects(
      enrollment.complete(b.userId, {
        pin: WRONG,
        assertion: stranger.authenticate({
          challenge: options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter: 1,
        }),
      }),
      (e) => isKaadaError(e, "CREDENTIAL_REJECTED"),
    );
    assert.equal((await b.pins.verify(b.userId, PIN)).status, "VERIFIED", "the PIN is unchanged");
  });

  it("rejects a replayed assertion and a malformed PIN without spending the challenge", async () => {
    const { b, enrollment, authenticator } = await enrolled();
    const options = await enrollment.begin(b.userId);
    const signed = authenticator.authenticate({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      counter: 1,
    });
    await assert.rejects(enrollment.complete(b.userId, { pin: "12", assertion: signed }), (e) =>
      isKaadaError(e, "PIN_REJECTED"),
    );
    // The challenge survived the malformed PIN, so the same assertion still works once.
    await enrollment.complete(b.userId, { pin: PIN, assertion: signed });
    await assert.rejects(enrollment.complete(b.userId, { pin: WRONG, assertion: signed }), (e) =>
      isKaadaError(e, "CREDENTIAL_REJECTED"),
    );
  });

  it("a PIN flagged for recovery cannot be replaced here", async () => {
    const { b, enrollment, assertion } = await enrolled();
    await b.pins.setPin(b.userId, PIN);
    await b.pins.requireReset(b.userId, "TEST");
    await assert.rejects(
      enrollment.complete(b.userId, { pin: WRONG, assertion: await assertion() }),
      (e) => isKaadaError(e, "PIN_RESET_REQUIRED"),
    );
  });

  it("needs a wallet first", async () => {
    const b = build();
    const wallet = createWalletWorld();
    const { service: wallets } = createWalletService(wallet);
    const passkeys = new PasskeyService({
      unitOfWork: wallet.unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const enrollment = new PinEnrollmentService({ passkeys, pins: b.pins, wallets });
    await assert.rejects(enrollment.begin(b.userId), (e) => isKaadaError(e, "WALLET_NOT_ACTIVE"));
  });
});

describe("request throttling", () => {
  it("allows a burst up to the limit, then refuses until the window passes", () => {
    let t = 1_000;
    const limiter = new RateLimiter(3, 10_000, () => t);
    assert.deepEqual(
      [1, 2, 3, 4].map(() => limiter.allow("k")),
      [true, true, true, false],
    );
    assert.equal(limiter.allow("other"), true, "keys are independent");
    t += 10_001;
    assert.equal(limiter.allow("k"), true);
  });

  it("stays bounded under many distinct keys", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0, 100);
    for (let i = 0; i < 1_000; i += 1) assert.equal(limiter.allow(`k${i}`), true);
  });
});
