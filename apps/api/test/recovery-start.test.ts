import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OPAQUE_TOKEN_PATTERN } from "../src/core/authorization/token.js";
import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";

/*
 * The first half of recovery: starting, the email challenge, and what an email alone can never do. Everything here runs the
 * REAL services over in-memory repositories and a semantic stand-in for the chain.
 */

describe("starting a recovery", () => {
  it("emails a code to the registered address and returns only an opaque token", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    assert.match(token, OPAQUE_TOKEN_PATTERN);
    assert.equal(world.email.sent.length, 1);
    const mail = world.email.sent[0]!;
    assert.equal(mail.to, user.email);
    assert.match(mail.text, /verification code is \d{6}/);
    // Nothing in the email is a token, a Recovery Code or an address.
    assert.ok(!mail.text.includes(token));
    assert.ok(!mail.text.includes(user.code.canonical()));
    assert.ok(!mail.text.toLowerCase().includes(user.account));
  });

  it("answers the same for an unknown email, a user without a wallet, without recovery set up, and a valid one", async () => {
    const world = createRecoveryWorld();
    const valid = await world.createUser();
    const unarmed = await world.createUser({ armed: false });
    const results = [
      await world.flow.start({ email: "nobody@example.com" }),
      await world.flow.start({ email: unarmed.email }),
      await world.flow.start({ email: valid.email }),
    ];
    for (const result of results) {
      assert.deepEqual(Object.keys(result), ["token"]);
      assert.match(result.token, OPAQUE_TOKEN_PATTERN);
    }
    // Only registered, armed accounts get a CODE; the unknown address gets nothing at all.
    assert.equal(world.email.sent.filter((m) => m.to === "nobody@example.com").length, 0);
    assert.equal(
      world.email.sent.filter((m) => m.to === valid.email && /code is/.test(m.text)).length,
      1,
    );
    // The account without recovery is told how to set it up, never given a code.
    const notice = world.email.sent.find((m) => m.to === unarmed.email);
    assert.ok(notice && !/\d{6}/.test(notice.text));
  });

  it("gives the same error for every wrong way to verify: unknown token, wrong code, malformed code", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    const ghost = await world.flow.start({ email: "ghost@example.com" });
    const wrong = world.email.codeFor(user.email) === "000000" ? "000001" : "000000";
    const failures = [
      world.flow.verifyEmail(ghost.token, "123456"),
      world.flow.verifyEmail(token, wrong),
      world.flow.verifyEmail(token, "12345"),
      world.flow.verifyEmail("not-a-token", "123456"),
    ];
    const messages = new Set<string>();
    for (const failure of failures) {
      const error = await expectKaada(failure, "RECOVERY_SESSION_INVALID");
      messages.add(error.message);
    }
    assert.equal(messages.size, 1, "one message for all of them: no oracle");
  });

  it("verifies the email: the attempt moves on, and nothing reaches the chain or the attestor", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    let attestorCalls = 0;
    const original = world.attestor.signInitiate.bind(world.attestor);
    world.attestor.signInitiate = (message) => {
      attestorCalls += 1;
      return original(message);
    };
    const token = await world.startAndVerify(user.email);
    const view = await world.flow.status(token);
    assert.equal(view.status, "EMAIL_VERIFIED");
    assert.equal(view.nextStep, "CREATE_CREDENTIAL");
    assert.equal(
      view.account,
      user.account,
      "the wallet is shown only after the email was verified",
    );
    assert.equal(view.recoveryAddress, user.recoveryKey.address.toLowerCase());
    assert.equal(attestorCalls, 0);
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    // Email alone cannot jump ahead: no proof can be submitted without a proposed root.
    await expectKaada(world.flow.submitProof(token, `0x${"11".repeat(65)}`), "RECOVERY_REJECTED");
    assert.equal(attestorCalls, 0);
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("before the email is verified the token reveals nothing", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    await expectKaada(world.flow.status(token), "RECOVERY_SESSION_INVALID");
    await expectKaada(world.flow.beginNewPasskey(token), "RECOVERY_SESSION_INVALID");
  });
});

describe("the email challenge", () => {
  it("is single use: replaying the correct code fails", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    const code = world.email.codeFor(user.email);
    await world.flow.verifyEmail(token, code);
    await expectKaada(world.flow.verifyEmail(token, code), "RECOVERY_SESSION_INVALID");
  });

  it("expires", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    const code = world.email.codeFor(user.email);
    world.advance(world.policy.emailCodeTtlMs + 1_000);
    await expectKaada(world.flow.verifyEmail(token, code), "RECOVERY_SESSION_INVALID");
  });

  it("dies after too many wrong guesses, even for the right code afterwards", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    const right = world.email.codeFor(user.email);
    const wrong = right === "000000" ? "000001" : "000000";
    for (let i = 0; i < world.policy.emailMaxAttempts; i++) {
      await expectKaada(world.flow.verifyEmail(token, wrong), "RECOVERY_SESSION_INVALID");
    }
    await expectKaada(world.flow.verifyEmail(token, right), "RECOVERY_SESSION_INVALID");
  });

  it("counts parallel guesses atomically: they can never exceed the budget", async () => {
    const world = createRecoveryWorld({ policy: { emailMaxAttempts: 3 } });
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    const right = world.email.codeFor(user.email);
    const wrong = right === "000000" ? "000001" : "000000";
    // Rate limiter off the table: use a fresh limiter-free sequence of parallel calls on the repository.
    const challenge = world.recovery.challenges[0]!;
    const reservations = await Promise.all(
      Array.from({ length: 10 }, () =>
        world.repositories.recoveryEmailChallenges.reserveAttempt(challenge.id, world.now()),
      ),
    );
    assert.equal(reservations.filter((r) => r.state === "ADMITTED").length, 3);
    void token;
    void wrong;
  });

  it("can be re-sent a limited number of times, with a cooldown", async () => {
    const world = createRecoveryWorld({ policy: { emailMaxIssues: 3 } });
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    await world.flow.resend(token); // inside the cooldown: ignored
    assert.equal(world.email.sent.filter((m) => /code is/.test(m.text)).length, 1);
    world.advance(2_000);
    await world.flow.resend(token);
    assert.equal(world.email.sent.filter((m) => /code is/.test(m.text)).length, 2);
    world.advance(2_000);
    await world.flow.resend(token);
    world.advance(2_000);
    await world.flow.resend(token); // over the budget: ignored
    assert.equal(world.email.sent.filter((m) => /code is/.test(m.text)).length, 3);
    // The newest code is the one that works.
    await world.flow.verifyEmail(token, world.email.codeFor(user.email));
  });

  it("rate limits starts per email", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    for (let i = 0; i < 5; i++) await world.flow.start({ email: user.email });
    await expectKaada(world.flow.start({ email: user.email }), "RECOVERY_RATE_LIMITED");
    // A different email is unaffected.
    const other = await world.createUser();
    await world.flow.start({ email: other.email });
  });

  it("refuses a malformed email without touching anything", async () => {
    const world = createRecoveryWorld();
    await expectKaada(world.flow.start({ email: "not an email" }), "RECOVERY_REJECTED");
    await expectKaada(world.flow.start({ email: 42 }), "RECOVERY_REJECTED");
    assert.equal(world.email.sent.length, 0);
  });

  it("tolerates a failing mail provider: the person just asks again", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    world.email.fail = true;
    const { token } = await world.flow.start({ email: user.email });
    assert.match(token, OPAQUE_TOKEN_PATTERN);
    assert.ok(world.logs.some((l) => l.event === "recovery.email_delivery_failed"));
    // The failure log never carries a code or an address.
    assert.ok(!JSON.stringify(world.logs).includes(user.email));
  });
});

describe("cooldown and risk", () => {
  it("refuses a fourth start in a day with a generic answer and an explanatory email", async () => {
    const world = createRecoveryWorld({
      policy: { maxStartsPerDay: 2, cooldownAfterCompletionMs: 0 },
    });
    const user = await world.createUser();
    for (let i = 0; i < 2; i++) {
      const token = await world.startAndVerify(user.email);
      // End the live attempt so the next start is a new one.
      await world.repositories.recoveryAttempts.advance({
        id: (await world.attemptOf(token)).id,
        from: ["EMAIL_VERIFIED"],
        to: "EXPIRED",
        patch: { terminatedBy: "SYSTEM", terminatedAt: world.now() },
      });
      world.advance(2_000);
    }
    const before = world.email.sent.length;
    const { token } = await world.flow.start({ email: user.email });
    assert.match(token, OPAQUE_TOKEN_PATTERN);
    const mail = world.email.sent.slice(before);
    assert.equal(mail.length, 1);
    assert.ok(!/\d{6}/.test(mail[0]!.text), "no code is sent");
    assert.equal(world.recovery.attempts.length, 2, "no third attempt exists");
  });
});

describe("resuming a live attempt", () => {
  it("a new start gives a NEW token that only replaces the old one after its code is verified", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const first = await world.startAndVerify(user.email);
    world.advance(2_000);
    const { token: second } = await world.flow.start({ email: user.email });
    // Unverified: the new token does nothing, the old one still works (an outsider cannot kick the person out).
    await expectKaada(world.flow.status(second), "RECOVERY_SESSION_INVALID");
    assert.equal((await world.flow.status(first)).status, "EMAIL_VERIFIED");
    assert.equal(world.recovery.attempts.length, 1, "still one attempt");
    await world.flow.verifyEmail(second, world.email.codeFor(user.email));
    assert.equal((await world.flow.status(second)).status, "EMAIL_VERIFIED");
    await expectKaada(world.flow.status(first), "RECOVERY_SESSION_INVALID");
  });

  it("two simultaneous starts end up in one attempt", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await Promise.all([
      world.flow.start({ email: user.email }),
      world.flow.start({ email: user.email }),
    ]);
    assert.equal(world.recovery.attempts.length, 1);
  });
});

describe("stale attempts", () => {
  it("expire and free the wallet for a new attempt", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    world.advance(world.policy.tokenTtlMs + 1_000);
    await expectKaada(world.flow.status(token), "RECOVERY_SESSION_INVALID");
    assert.equal(await world.repositories.recoveryAttempts.expireStale(world.now()), 1);
    assert.equal((await world.attemptOf(token)).status, "EXPIRED");
    const next = await world.startAndVerify(user.email);
    assert.notEqual(next, token);
    assert.equal(world.recovery.attempts.length, 2);
  });
});
