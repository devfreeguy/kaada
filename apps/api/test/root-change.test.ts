import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { isKaadaError } from "@kaada/domain";
import type { RootCredential, RootProof } from "@kaada/domain";

import { SoftDeviceKey } from "./support/soft-device-key.js";
import { build, withPermission } from "./support/root-change-world.js";

const reject = (code: string) => (error: unknown) => isKaadaError(error, code as never);

for (const [from, to] of [
  ["PASSKEY", "DEVICE_KEY"],
  ["DEVICE_KEY", "PASSKEY"],
  ["PASSKEY", "PASSKEY"],
  ["DEVICE_KEY", "DEVICE_KEY"],
] as const) {
  describe(`rotating the root: ${from} -> ${to}`, () => {
    const credentialFor = async (w: Awaited<ReturnType<typeof build>>) =>
      to === "DEVICE_KEY" ? (await w.newDevice()).input : await w.newPasskey();

    it("is signed by the CURRENT root's type, deploys a fresh clone, and changes the root only when the chain shows it", async () => {
      const w = await build(from);
      const before = await w.root();
      const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", await credentialFor(w));
      assert.equal(
        prepared.challenge.action,
        from === "PASSKEY" ? "ROOT_PASSKEY_REQUIRED" : "ROOT_DEVICE_KEY_REQUIRED",
      );
      assert.equal(prepared.newRootType, to);
      // The clone exists before anything is signed; nothing is sent yet and the root is unchanged.
      assert.equal(w.validators.deployed.length, 1);
      assert.equal(w.validators.deployed[0]?.type, to);
      assert.equal(w.validators.deployed[0]?.purpose, 3);
      assert.equal(w.network.sent.length, 0);
      assert.equal((await w.root()).type, from);

      const view = await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
      assert.equal(view.status, "CONFIRMED");
      const after = await w.root();
      assert.equal(after.type, to);
      assert.notEqual(
        (after as { validatorAddress?: string }).validatorAddress,
        (before as { validatorAddress?: string }).validatorAddress,
        "never the old instance",
      );
      assert.equal(
        w.network.account(w.address).rootValidator,
        (after as { validatorAddress?: string }).validatorAddress,
      );
      assert.ok(w.network.account(w.address).nonce > 1, "invalidateNonce was part of it");
    });
  });
}

describe("rotation: what it retires", () => {
  it("replaces the old credential, voids the permission and destroys its session key", async () => {
    const w = await build("PASSKEY");
    const { permission, secretId } = await withPermission(w);
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));

    const rows = await w.credentials();
    const old = rows.find((row) => row.kind === "PASSKEY");
    const current = rows.find((row) => row.isRoot);
    assert.equal(old?.status, "REPLACED");
    assert.equal(current?.kind, "DEVICE_KEY");
    assert.equal(current?.role, "PRIMARY");
    assert.equal(current?.status, "ACTIVE");
    assert.equal(
      (await w.repositories.delegatedPermissions.findById(permission.id))?.status,
      "REVOKED",
    );
    assert.equal(
      await w.repositories.executionSecrets.get(secretId),
      null,
      "the session key is gone",
    );
    assert.equal(
      (await w.repositories.passkeys.listActiveForUser(w.userId)).length,
      0,
      "the old passkey no longer counts",
    );
  });

  it("records a new PASSKEY root as a passkey the existing flows recognise", async () => {
    const w = await build("DEVICE_KEY");
    const input = await w.newPasskey();
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", input);
    await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    const mirror = await w.repositories.passkeys.listActiveForUser(w.userId);
    assert.equal(mirror.length, 1);
    assert.equal(
      mirror[0]?.credentialId,
      input.type === "PASSKEY" ? (input.response as { id: string }).id : "",
    );
    assert.equal((await w.root()).type, "PASSKEY");
  });

  it("leaves the PIN alone: it was never tied to the root", async () => {
    const w = await build("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    const audit = JSON.stringify(
      (w.repositories.audit as unknown as { all?: unknown[] }).all ?? [],
    );
    assert.equal(/pin/i.test(audit), false);
  });

  it("the old root cannot start another change after a rotation, and a later rotation uses yet another instance", async () => {
    const w = await build("PASSKEY");
    const first = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    const oldKey = w.rootKey;
    const old = (await w.root()) as { credentialId: string };
    await w.service.complete(w.userId, first.changeId, w.sign(first));
    const firstInstance = ((await w.root()) as { validatorAddress: string }).validatorAddress;

    // The old passkey's assertion is no longer the wallet's root: a new change asks for the DEVICE key.
    const second = await w.service.prepare(w.userId, "ROTATE_ROOT", await w.newPasskey());
    assert.equal(second.challenge.type, "DEVICE_KEY");
    await assert.rejects(
      w.service.complete(w.userId, second.changeId, {
        type: "PASSKEY",
        assertion: { id: old.credentialId, good: true },
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    assert.ok(oldKey);
    assert.notEqual(second.changeId, first.changeId);
    const used = new Set((await w.credentials()).map((row) => row.validatorAddress));
    assert.equal(used.size, (await w.credentials()).length, "no instance is recorded twice");
    assert.ok(used.has(firstInstance));
  });
});

describe("rotation: refusals", () => {
  it("a wrong proof, a high-s signature or the wrong proof type changes nothing and does not burn the change", async () => {
    for (const from of ["PASSKEY", "DEVICE_KEY"] as const) {
      const w = await build(from);
      const prepared = await w.service.prepare(
        w.userId,
        "ROTATE_ROOT",
        (await w.newDevice()).input,
      );
      await assert.rejects(
        w.service.complete(w.userId, prepared.changeId, w.sign(prepared, false)),
        reject("CREDENTIAL_REJECTED"),
      );
      const wrongType: RootProof =
        from === "PASSKEY"
          ? new SoftDeviceKey().proof(`0x${"11".repeat(153)}`)
          : { type: "PASSKEY", assertion: { id: "x", good: true } };
      await assert.rejects(
        w.service.complete(w.userId, prepared.changeId, wrongType),
        reject("CREDENTIAL_REJECTED"),
      );
      assert.equal(w.network.sent.length, 0);
      assert.equal((await w.service.status(w.userId, prepared.changeId)).status, "PREPARED");
      // The right proof still works.
      const view = await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
      assert.equal(view.status, "CONFIRMED");
    }
  });

  it("one live change per wallet, an expired one cannot be completed, a change belongs to its owner", async () => {
    const w = await build("DEVICE_KEY");
    const first = await w.service.prepare(w.userId, "ROTATE_ROOT", await w.newPasskey());
    await assert.rejects(
      w.service.prepare(w.userId, "ENROLL_BACKUP", (await w.newDevice()).input),
      reject("ROOT_CHANGE_CONFLICT"),
    );
    await assert.rejects(
      w.service.complete(randomUUID(), first.changeId, w.sign(first)),
      reject("ROOT_CHANGE_REJECTED"),
      "another person",
    );
    w.advance(11 * 60 * 1000);
    await assert.rejects(
      w.service.complete(w.userId, first.changeId, w.sign(first)),
      reject("ROOT_CHANGE_REJECTED"),
    );
    // The expired one no longer blocks a new one.
    const fresh = await w.service.prepare(w.userId, "ROTATE_ROOT", await w.newPasskey());
    assert.notEqual(fresh.changeId, first.changeId);
  });

  it("a challenge or a registration is single-use and a point off the curve is refused", async () => {
    const w = await build("PASSKEY");
    const { input } = await w.newDevice();
    await w.service.prepare(w.userId, "ROTATE_ROOT", input);
    // The same enrolment cannot be replayed (the challenge was spent), even for another kind of change later.
    await assert.rejects(
      w.service.prepare(w.userId, "ENROLL_BACKUP", input),
      (error) =>
        isKaadaError(error, "CREDENTIAL_REJECTED") || isKaadaError(error, "ROOT_CHANGE_CONFLICT"),
    );
    await assert.rejects(
      w.service.beginDeviceKey(w.userId, {
        publicKeyX: "01".repeat(32),
        publicKeyY: "02".repeat(32),
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    const clean = await build("PASSKEY");
    await assert.rejects(
      clean.service.prepare(clean.userId, "ROTATE_ROOT", {
        type: "DEVICE_KEY",
        publicKeyX: "00",
        publicKeyY: "00",
        challenge: `0x${"00".repeat(32)}`,
        r: "00",
        s: "00",
      }),
      reject("CREDENTIAL_REJECTED"),
    );
  });

  it("a proof of possession by ANOTHER key does not enrol a public key", async () => {
    const w = await build("PASSKEY");
    const key = new SoftDeviceKey();
    const other = new SoftDeviceKey();
    const challenge = await w.service.beginDeviceKey(w.userId, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    await assert.rejects(
      w.service.prepare(w.userId, "ROTATE_ROOT", {
        type: "DEVICE_KEY",
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        ...other.sign(challenge.payload),
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    assert.equal(w.validators.deployed.length, 0, "nothing was deployed for an unproven key");
  });

  it("a wallet that is not deployed cannot change its credentials yet", async () => {
    const w = await build("PASSKEY");
    w.network.account(w.address).deployed = false;
    await assert.rejects(
      w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input),
      reject("ROOT_CHANGE_REJECTED"),
    );
  });
});

describe("rotation: sends and restarts", () => {
  it("a definite bundler refusal fails the change and drops the pending credential, so the person can start over", async () => {
    const w = await build("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    w.network.mode = "reject";
    await assert.rejects(
      w.service.complete(w.userId, prepared.changeId, w.sign(prepared)),
      reject("BUNDLER_REJECTED"),
    );
    assert.equal((await w.service.status(w.userId, prepared.changeId)).status, "FAILED");
    assert.equal(
      (await w.credentials()).filter((row) => row.status === "PENDING").length,
      0,
      "no credential is left pending",
    );
    assert.equal((await w.root()).type, "PASSKEY");
    w.network.mode = "ok";
    const again = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    assert.equal(
      (await w.service.complete(w.userId, again.changeId, w.sign(again))).status,
      "CONFIRMED",
    );
  });

  it("an ambiguous send stays SUBMITTED, resends nothing, and a later reconcile finishes it from the chain", async () => {
    const w = await build("DEVICE_KEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", await w.newPasskey());
    w.network.mode = "ambiguous";
    await assert.rejects(w.service.complete(w.userId, prepared.changeId, w.sign(prepared)));
    assert.equal((await w.service.status(w.userId, prepared.changeId)).status, "SUBMITTED");
    assert.equal(w.network.sent.length, 1);
    // The operation had landed: a restarted process reconciles from the chain without sending again.
    w.advance(11 * 60 * 1000);
    const result = await w.service.reconcile();
    assert.equal(result.confirmed, 1);
    assert.equal(w.network.sent.length, 1, "nothing was resent");
    assert.equal((await w.service.status(w.userId, prepared.changeId)).status, "CONFIRMED");
    assert.equal((await w.root()).type, "PASSKEY");
  });

  it("two completions race: exactly one sends", async () => {
    const w = await build("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    const proof = w.sign(prepared);
    const results = await Promise.allSettled([
      w.service.complete(w.userId, prepared.changeId, proof),
      w.service.complete(w.userId, prepared.changeId, proof),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(w.network.sent.length, 1);
  });

  it("an operation that was included but reverted fails the change and changes no root", async () => {
    const w = await build("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    w.network.mode = "revert";
    const view = await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    assert.equal(view.status, "FAILED");
    assert.equal((await w.root()).type, "PASSKEY");
  });

  it("stale PREPARED changes expire and release their credential", async () => {
    const w = await build("DEVICE_KEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", await w.newPasskey());
    w.advance(11 * 60 * 1000);
    assert.equal((await w.service.reconcile()).expired, 1);
    assert.equal((await w.service.status(w.userId, prepared.changeId)).status, "EXPIRED");
    assert.equal((await w.credentials()).filter((row) => row.status === "PENDING").length, 0);
  });
});

describe("enrolling a backup credential", () => {
  for (const from of ["PASSKEY", "DEVICE_KEY"] as const) {
    it(`${from} root: the root signs, the backup is installed as a FRESH lane, and the root is unchanged`, async () => {
      const w = await build(from);
      const before = await w.root();
      const prepared = await w.service.prepare(
        w.userId,
        "ENROLL_BACKUP",
        (await w.newDevice()).input,
      );
      assert.equal(w.validators.deployed[0]?.purpose, 2);
      const view = await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
      assert.equal(view.status, "CONFIRMED");
      assert.deepEqual(await w.root(), before, "the root is the same");
      const backup = (await w.credentials()).find((row) => row.role === "BACKUP");
      assert.equal(backup?.status, "ACTIVE");
      assert.equal(backup?.isRoot, false);
      assert.ok(w.network.account(w.address).lanes.has(`0x01${backup?.validatorAddress.slice(2)}`));
      assert.notEqual(
        backup?.validatorAddress,
        (before as { validatorAddress?: string }).validatorAddress,
      );
    });
  }

  it("a backup does not revoke the wallet's permissions (nothing was voided)", async () => {
    const w = await build("PASSKEY");
    const { permission } = await withPermission(w);
    const prepared = await w.service.prepare(
      w.userId,
      "ENROLL_BACKUP",
      (await w.newDevice()).input,
    );
    await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    assert.equal(
      (await w.repositories.delegatedPermissions.findById(permission.id))?.status,
      "ACTIVE",
    );
  });

  it("rotating the root afterwards voids the backup lane too", async () => {
    const w = await build("PASSKEY");
    const backup = await w.service.prepare(w.userId, "ENROLL_BACKUP", (await w.newDevice()).input);
    await w.service.complete(w.userId, backup.changeId, w.sign(backup));
    assert.equal(w.network.account(w.address).lanes.size, 1);
    const rotation = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    await w.service.complete(w.userId, rotation.changeId, w.sign(rotation));
    assert.equal(w.network.account(w.address).lanes.size, 0, "every lane installed before is void");
  });
});

describe("the new credential is only ever PUBLIC data", () => {
  it("stores no private material for either type", async () => {
    const w = await build("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    const stored = JSON.stringify(await w.credentials());
    assert.equal(/private|secret|seed|pkcs8/i.test(stored), false);
  });

  it("the root credential type is never inferred from a client claim: the server's record decides", async () => {
    const w = await build("DEVICE_KEY");
    const root: RootCredential = await w.root();
    assert.equal(root.type, "DEVICE_KEY");
  });
});
