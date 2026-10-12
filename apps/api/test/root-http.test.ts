import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { RootProof } from "@kaada/domain";

import { PinController } from "../src/authorization/pin.controller.js";
import { RootActionController } from "../src/execution/root-action.controller.js";
import { RootChangeController } from "../src/roots/root-change.controller.js";
import { parseRootProof } from "../src/roots/root-proof.schema.js";
import { WalletController } from "../src/wallet/wallet.controller.js";
import { CLAIM_TOKEN } from "./support/firm-world.js";
import { runWorld } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";
import { SoftDeviceKey } from "./support/soft-device-key.js";

const hex = (n: number) => "ab".repeat(n);
const deviceProof = {
  type: "DEVICE_KEY",
  keyId: `0x${hex(32)}`,
  r: hex(32),
  s: hex(32),
};
const passkeyProof = {
  type: "PASSKEY",
  assertion: {
    id: "abc",
    rawId: "abc",
    type: "public-key",
    response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
  },
};

describe("the proof on the wire", () => {
  it("accepts exactly the two shapes", () => {
    assert.deepEqual(parseRootProof(deviceProof), deviceProof);
    assert.equal(parseRootProof(passkeyProof)?.type, "PASSKEY");
    assert.deepEqual(
      parseRootProof({ ...deviceProof, challenge: `0x${hex(32)}` })?.type,
      "DEVICE_KEY",
    );
  });

  it("refuses anything else: a bare assertion, extra keys, bad hex, a missing part, an unknown type", () => {
    assert.equal(parseRootProof(passkeyProof.assertion), null, "the old bare-assertion form");
    assert.equal(parseRootProof({ ...deviceProof, extra: 1 }), null);
    assert.equal(parseRootProof({ ...deviceProof, r: "zz" }), null);
    assert.equal(parseRootProof({ ...deviceProof, r: hex(31) }), null);
    assert.equal(parseRootProof({ ...deviceProof, keyId: "0x12" }), null);
    assert.equal(parseRootProof({ ...deviceProof, s: undefined }), null);
    assert.equal(parseRootProof({ type: "WEBAUTHN", assertion: {} }), null);
    assert.equal(parseRootProof({ ...deviceProof, challenge: "12" }), null);
    assert.equal(parseRootProof(null), null);
    assert.equal(parseRootProof("proof"), null);
  });
});

describe("the PIN endpoint takes a proof, not an assertion", () => {
  function build() {
    const calls: { pin: string; proof: RootProof }[] = [];
    const controller = new PinController(
      { userForView: () => Promise.resolve("user-1") } as never,
      {} as never,
      {
        complete: (_user: string, input: { pin: string; proof: RootProof }) => {
          calls.push(input);
          return Promise.resolve("CREATED");
        },
      } as never,
    );
    return { controller, calls };
  }

  it("forwards a device proof with the six-digit PIN", async () => {
    const { controller, calls } = build();
    const result = await controller.setPin(
      { pin: "735142", proof: deviceProof },
      `Bearer ${"A".repeat(43)}`,
    );
    assert.deepEqual(result, { status: "CREATED" });
    assert.equal(calls[0]?.proof.type, "DEVICE_KEY");
  });

  it("refuses the old body shape and an unknown proof before the service sees it", async () => {
    const { controller, calls } = build();
    const auth = `Bearer ${"A".repeat(43)}`;
    await assert.rejects(
      controller.setPin({ pin: "735142", assertion: passkeyProof.assertion }, auth),
      BadRequestException,
    );
    await assert.rejects(
      controller.setPin({ pin: "735142", proof: { type: "X" } }, auth),
      BadRequestException,
    );
    await assert.rejects(controller.setPin({ proof: deviceProof }, auth), BadRequestException);
    assert.equal(calls.length, 0);
  });
});

describe("device-key enrolment endpoints", () => {
  const key = new SoftDeviceKey();
  const body = { publicKeyX: key.publicKeyX, publicKeyY: key.publicKeyY };
  const auth = `Bearer ${"A".repeat(43)}`;

  function build(enabled: boolean) {
    const seen: string[] = [];
    const setup = {
      deviceKeysEnabled: enabled,
      beginDeviceKeyRegistration: () => {
        seen.push("options");
        return Promise.resolve({ keyId: key.keyId, payload: "0x", challenge: `0x${hex(32)}` });
      },
      completeDeviceKeyRegistration: () => {
        seen.push("register");
        return Promise.resolve({ status: "COMPLETED", rootType: "DEVICE_KEY", wallet: null });
      },
    };
    return {
      controller: new WalletController(setup as never, null, {} as never, {} as never),
      seen,
    };
  }

  it("answers 'not enabled' when the deployment has no device-key infrastructure", async () => {
    const { controller, seen } = build(false);
    await assert.rejects(controller.deviceKeyOptions(body, auth), ServiceUnavailableException);
    await assert.rejects(
      controller.deviceKeyRegister(
        { ...body, challenge: `0x${hex(32)}`, r: hex(32), s: hex(32) },
        auth,
      ),
      ServiceUnavailableException,
    );
    assert.deepEqual(seen, []);
  });

  it("validates the body strictly and reports the root type", async () => {
    const { controller, seen } = build(true);
    await assert.rejects(
      controller.deviceKeyOptions({ ...body, keyId: `0x${hex(32)}` }, auth),
      BadRequestException,
    );
    await assert.rejects(
      controller.deviceKeyOptions({ publicKeyX: "12", publicKeyY: "34" }, auth),
      BadRequestException,
    );
    await assert.rejects(
      controller.deviceKeyRegister({ ...body, challenge: "x" }, auth),
      BadRequestException,
    );
    await controller.deviceKeyOptions(body, auth);
    const done = await controller.deviceKeyRegister(
      { ...body, challenge: `0x${hex(32)}`, r: hex(32), s: hex(32) },
      auth,
    );
    assert.equal(done.rootType, "DEVICE_KEY");
    assert.deepEqual(seen, ["options", "register"]);
  });

  it("needs the setup link token", async () => {
    const { controller } = build(true);
    await assert.rejects(controller.deviceKeyOptions(body, undefined), UnauthorizedException);
  });
});

describe("root change endpoints", () => {
  const auth = `Bearer ${"A".repeat(43)}`;
  const id = "00000000-0000-4000-8000-0000000000aa";

  function build() {
    const calls: unknown[] = [];
    const changes = {
      beginPasskey: () => Promise.resolve({ challenge: "c" }),
      beginDeviceKey: () => Promise.resolve({ challenge: "c" }),
      prepare: (_u: string, kind: string, credential: unknown) => {
        calls.push({ kind, credential });
        return Promise.resolve({ changeId: id, expiresAt: new Date(0) });
      },
      complete: (_u: string, _id: string, proof: RootProof) => {
        calls.push(proof);
        return Promise.resolve({ changeId: id, status: "CONFIRMED", expiresAt: new Date(0) });
      },
      status: () => Promise.resolve({ changeId: id, status: "PREPARED", expiresAt: new Date(0) }),
    };
    const setup = { userForView: () => Promise.resolve("user-1") };
    return { controller: new RootChangeController(setup as never, changes as never), calls };
  }

  it("is off without the service", async () => {
    const controller = new RootChangeController({} as never, null);
    await assert.rejects(controller.passkeyOptions(auth), ServiceUnavailableException);
  });

  it("prepares only the two fixed kinds, with a credential of either type", async () => {
    const { controller, calls } = build();
    const device = {
      type: "DEVICE_KEY",
      publicKeyX: hex(32),
      publicKeyY: hex(32),
      challenge: `0x${hex(32)}`,
      r: hex(32),
      s: hex(32),
    };
    await controller.prepare({ kind: "ROTATE_ROOT", credential: device }, auth);
    await controller.prepare({ kind: "ENROLL_BACKUP", credential: device }, auth);
    assert.equal(calls.length, 2);
    for (const bad of [
      { kind: "DELETE_WALLET", credential: device },
      { kind: "ROTATE_ROOT", credential: { ...device, validatorAddress: `0x${hex(20)}` } },
      { kind: "ROTATE_ROOT" },
      { kind: "ROTATE_ROOT", credential: { type: "PASSKEY", response: {} } },
    ]) {
      await assert.rejects(controller.prepare(bad, auth), BadRequestException);
    }
    assert.equal(calls.length, 2);
  });

  it("takes only a proof to complete, and only a UUID as the change id", async () => {
    const { controller, calls } = build();
    const done = await controller.complete(id, { proof: deviceProof }, auth);
    assert.equal(done.status, "CONFIRMED");
    await assert.rejects(
      controller.complete(id, { proof: deviceProof, calldata: "0x" }, auth),
      BadRequestException,
    );
    await assert.rejects(
      controller.complete("not-a-uuid", { proof: deviceProof }, auth),
      BadRequestException,
    );
    await assert.rejects(controller.status("../etc", auth), BadRequestException);
    assert.equal(calls.length, 1);
  });
});

// ───────────────── the same payment, both roots, through the real HTTP edge ─────────────────

describe("the payment UX is the same for both roots", () => {
  async function edges(w: RunWorld) {
    const { ExecutionController } = await import("../src/execution/execution.controller.js");
    const { RunTracker } = await import("../src/core/execution/run-tracker.js");
    const runs = new RunTracker();
    return {
      runs,
      payments: new ExecutionController(
        w.w.auth.sessions,
        w.service,
        w.tracker,
        w.uow.read as never,
        w.runner,
        w.rootActions,
        runs,
      ),
      rootPage: new RootActionController(w.rootActions),
    };
  }

  for (const [label, key, action] of [
    ["PASSKEY", undefined, "ROOT_PASSKEY_REQUIRED"],
    ["DEVICE_KEY", new SoftDeviceKey(), "ROOT_DEVICE_KEY_REQUIRED"],
  ] as const) {
    it(`${label}: PIN -> run -> structured root action -> sign -> run -> payment sent`, async () => {
      const w = await runWorld(key ? { deviceRoot: key } : {});
      const { payments, rootPage, runs } = await edges(w);
      const auth = `Bearer ${w.token}`;

      await payments.run(auth);
      await runs.idle();
      const waiting = await payments.status(auth);
      assert.equal(waiting.state, "ROOT_ACTION_REQUIRED");
      assert.equal(waiting.action, action, "the server says which signer to show");

      const link = await payments.rootActionLink(auth);
      const token = link.url.split("/").at(-1) ?? "";
      const page = `Bearer ${token}`;
      const view = (await rootPage.view(page)) as { action: string; rootType: string };
      assert.equal(view.action, action);
      const challenge = (await rootPage.options(page)) as {
        action: string;
        type: string;
        payload?: string;
      };
      assert.equal(challenge.action, action);
      const proof: RootProof = key
        ? key.proof(challenge.payload ?? "")
        : {
            type: "PASSKEY",
            assertion: {
              ...passkeyProof.assertion,
              id: "credential-0",
              rawId: "credential-0",
              good: true,
            },
          };

      // The old body shape (a bare assertion) is refused by the edge; only a proof gets through.
      await assert.rejects(
        rootPage.complete(page, { assertion: { id: "credential-0", good: true } } as never),
        BadRequestException,
      );
      assert.deepEqual(await rootPage.complete(page, { proof }), { state: "PROCESSING_PAYMENT" });

      await payments.run(auth);
      await runs.idle();
      const done = await payments.status(auth);
      assert.equal(done.state, "PAYMENT_SENT");
      assert.equal("action" in done, false, "nothing more is asked of the person");
      const text = JSON.stringify([waiting, done]);
      for (const needle of [CLAIM_TOKEN, "0x", "userOp", "calldata", "privateKey"]) {
        assert.equal(text.includes(needle), false, needle);
      }
    });
  }

  it("a stale or foreign link is a generic 401 whatever the root", async () => {
    const w = await runWorld({ deviceRoot: new SoftDeviceKey() });
    const { rootPage } = await edges(w);
    await assert.rejects(rootPage.view(`Bearer ${"A".repeat(43)}`), UnauthorizedException);
    await assert.rejects(rootPage.options(undefined), UnauthorizedException);
  });
});
