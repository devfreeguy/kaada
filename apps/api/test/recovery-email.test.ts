import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KaadaError } from "@kaada/domain";

import { RecoveryEmailService, maskEmail } from "../src/core/recovery/recovery-email.js";
import { createRecoveryWorld } from "./support/recovery-world.js";

/*
 * Registering the email a person recovers with. Recovery starts from an email, so a person with none cannot recover at all: this
 * is the step that makes it possible. A wrong or stale code never registers anything, and the form is not an oracle for accounts.
 */

function world() {
  const w = createRecoveryWorld();
  const service = new RecoveryEmailService(w.context);
  const identitiesOf = (userId: string) => w.repositories.identities.listForUser(userId);
  return { w, service, identitiesOf };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof KaadaError && error.code === code);

describe("registering a recovery email", () => {
  it("sends a code, and only the right code makes the address the person's email", async () => {
    const { w, service, identitiesOf } = world();
    const user = await w.createUser({ noEmail: true });
    assert.deepEqual(await service.status(user.userId), { registered: false });

    await service.begin(user.userId, "  Ada.Lovelace@Example.com ");
    assert.equal(w.email.sent.length, 1);
    assert.equal(w.email.sent[0]?.to, "ada.lovelace@example.com", "normalized");
    assert.equal(
      (await identitiesOf(user.userId)).some((i) => i.type === "EMAIL"),
      false,
      "not yet",
    );

    const result = await service.confirm(user.userId, w.email.codeFor("ada.lovelace@example.com"));
    assert.equal(result.masked, "a***@example.com");
    const emails = (await identitiesOf(user.userId)).filter((i) => i.type === "EMAIL");
    assert.deepEqual(
      emails.map((i) => i.externalId),
      ["ada.lovelace@example.com"],
    );
    assert.deepEqual(await service.status(user.userId), {
      registered: true,
      masked: "a***@example.com",
    });
  });

  it("the code is never stored, only a keyed hash of it", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    await service.begin(user.userId, "a@example.com");
    const code = w.email.codeFor("a@example.com");
    const latest = await w.repositories.emailVerifications.findLatest(user.userId);
    assert.ok(latest);
    assert.equal(latest.codeHash.includes(code), false);
    assert.match(latest.codeHash, /^[0-9a-f]{64}$/);
  });

  it("a wrong code registers nothing, and five wrong guesses close it even for the right code", async () => {
    const { w, service, identitiesOf } = world();
    const user = await w.createUser({ noEmail: true });
    await service.begin(user.userId, "a@example.com");
    const right = w.email.codeFor("a@example.com");
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1)
      await rejects(service.confirm(user.userId, wrong), "RECOVERY_REJECTED");
    await rejects(service.confirm(user.userId, right), "RECOVERY_REJECTED");
    assert.equal(
      (await identitiesOf(user.userId)).some((i) => i.type === "EMAIL"),
      false,
    );
  });

  it("an expired code is refused", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    await service.begin(user.userId, "a@example.com");
    const code = w.email.codeFor("a@example.com");
    w.advance(11 * 60 * 1000);
    await rejects(service.confirm(user.userId, code), "RECOVERY_REJECTED");
  });

  it("a code cannot be used by another person", async () => {
    const { w, service } = world();
    const first = await w.createUser({ noEmail: true });
    const second = await w.createUser({ noEmail: true });
    await service.begin(first.userId, "a@example.com");
    await rejects(
      service.confirm(second.userId, w.email.codeFor("a@example.com")),
      "RECOVERY_REJECTED",
    );
  });

  it("an address that belongs to another account is never registered, and the answer gives nothing away", async () => {
    const { w, service, identitiesOf } = world();
    const owner = await w.createUser({ email: "taken@example.com" });
    const newcomer = await w.createUser({ noEmail: true });
    await service.begin(newcomer.userId, "taken@example.com"); // looks exactly like success
    assert.equal(w.email.sent.length, 0, "nothing was sent to the owner's inbox");
    await rejects(service.confirm(newcomer.userId, "123456"), "RECOVERY_REJECTED");
    assert.equal(
      (await identitiesOf(newcomer.userId)).some((i) => i.type === "EMAIL"),
      false,
    );
    assert.equal((await identitiesOf(owner.userId)).filter((i) => i.type === "EMAIL").length, 1);
  });

  it("a person who already has a recovery email cannot swap it from here", async () => {
    const { w, service } = world();
    const user = await w.createUser({ email: "mine@example.com" });
    await rejects(service.begin(user.userId, "other@example.com"), "RECOVERY_CONFLICT");
    assert.equal(w.email.sent.length, 0);
  });

  it("junk is refused before anything is sent", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    for (const junk of ["", "nope", "a@b", 42, null, "x".repeat(300) + "@example.com"]) {
      await rejects(service.begin(user.userId, junk), "RECOVERY_REJECTED");
    }
    assert.equal(w.email.sent.length, 0);
  });

  it("asking again straight away waits, and an hour's budget of codes is limited", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    await service.begin(user.userId, "a@example.com");
    await rejects(service.begin(user.userId, "a@example.com"), "RECOVERY_RATE_LIMITED");
    for (let i = 0; i < 4; i += 1) {
      w.advance(61_000);
      await service.begin(user.userId, "a@example.com");
    }
    w.advance(61_000);
    await rejects(service.begin(user.userId, "a@example.com"), "RECOVERY_RATE_LIMITED");
  });

  it("a mail provider that is down says so plainly, and logs why", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    w.email.fail = true;
    await rejects(service.begin(user.userId, "a@example.com"), "RECOVERY_BLOCKED");
    assert.ok(w.logs.some((l) => l.event === "recovery.email_send_failed"));
  });

  it("a code is single use", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    await service.begin(user.userId, "a@example.com");
    const code = w.email.codeFor("a@example.com");
    await service.confirm(user.userId, code);
    await rejects(service.confirm(user.userId, code), "RECOVERY_REJECTED");
  });
});

describe("recovery setup needs the email first", () => {
  it("the authenticator and the Recovery Code are refused until an email is verified", async () => {
    const { w } = world();
    const user = await w.createUser({ noEmail: true });
    await rejects(w.configuration.beginAuthenticator(user.userId), "RECOVERY_REJECTED");
    await rejects(
      w.configuration.prepare({ userId: user.userId, recoveryAddress: `0x${"ab".repeat(20)}` }),
      "RECOVERY_REJECTED",
    );
  });

  it("the page is told whether an email is registered", async () => {
    const { w, service } = world();
    const user = await w.createUser({ noEmail: true });
    assert.equal((await w.configuration.describe(user.userId)).emailRegistered, false);
    await service.begin(user.userId, "a@example.com");
    await service.confirm(user.userId, w.email.codeFor("a@example.com"));
    assert.equal((await w.configuration.describe(user.userId)).emailRegistered, true);
  });
});

describe("masking", () => {
  it("shows enough to recognise an address, not the address", () => {
    assert.equal(maskEmail("jane.doe@gmail.com"), "j***@gmail.com");
  });
});
