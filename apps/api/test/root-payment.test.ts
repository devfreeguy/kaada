import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KaadaError } from "@kaada/domain";
import type { WalletCredential } from "@kaada/domain";

import { RootPaymentService } from "../src/core/execution/root-payment-service.js";
import { DeviceKeyRootAdapter, PasskeyRootAdapter } from "../src/core/roots/adapters.js";
import { RootAdapters, RootCredentialService } from "../src/core/roots/root-credentials.js";
import { CNGN_ADDRESS, PIN, RECIPIENT_ADDRESS, firmWorld } from "./support/firm-world.js";
import { attachRunner, verifier } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";
import { SoftDeviceKey } from "./support/soft-device-key.js";
import { SENDER } from "./support/harness.js";
import { WALLET_ID } from "./support/payment-world.js";

/*
 * A DIRECT payment confirmed with the wallet's own passkey: one prompt, no PIN, and nothing installed on chain for Kaada's server key.
 * Everything runs on the offline fakes: the fake kernel records exactly what would have been signed and sent.
 */

const NAIRA_300 = "300000000";
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const GOOD = { type: "PASSKEY" as const, assertion: { id: "credential-0", good: true } };
const BAD = { type: "PASSKEY" as const, assertion: { id: "credential-0", good: false } };

const deviceRow = (key: SoftDeviceKey): WalletCredential => ({
  id: "00000000-0000-4000-8000-0000000000d2",
  userId: SENDER,
  walletId: WALLET_ID,
  kind: "DEVICE_KEY",
  role: "PRIMARY",
  status: "ACTIVE",
  isRoot: true,
  validatorAddress: `0x${"d1".repeat(20)}`,
  validatorPurpose: 0,
  deploymentSalt: `0x${"00".repeat(32)}`,
  credentialRef: key.keyId,
  publicKeyX: key.publicKeyX,
  publicKeyY: key.publicKeyY,
  securityTier: "WEB_NON_EXTRACTABLE",
  createdAt: new Date(),
});

async function rootWorld(holds = 1000n, device?: SoftDeviceKey) {
  const base = await firmWorld({ directNaira: { holds }, openSession: true });
  if (device) {
    base.credentials.length = 0; // no passkey at all
    base.recordedRoot.value = deviceRow(device);
  }
  const w: RunWorld = await attachRunner(base);
  const now = () => base.now();
  const service = new RootPaymentService({
    payments: base.w.auth.payments,
    preparation: base.service,
    unitOfWork: base.uow,
    kernel: w.kernel,
    roots: new RootCredentialService({ repositories: base.uow.read, rpId: "kaada.test" }),
    adapters: new RootAdapters(
      new PasskeyRootAdapter({
        verifier,
        passkeys: base.uow.read.passkeys,
        rpId: "kaada.test",
        origin: "https://app.kaada.test",
        now,
      }),
      new DeviceKeyRootAdapter(),
    ),
    cipher: w.cipher,
    chain: { balances: base.chainState.balances },
    minNativeWei: 10n ** 15n,
    onChainId: 42220,
    now,
  });
  return { w, base, service, token: base.token };
}

const execution = (w: RunWorld, id: string) => w.uow.read.executionPlans.findById(id);

describe("confirming a direct payment with the passkey", () => {
  it("is offered for a passkey wallet, with no PIN", async () => {
    const { service, token } = await rootWorld();
    assert.deepEqual(await service.method(token), {
      method: "ROOT",
      rootType: "PASSKEY",
      pinRequired: false,
    });
  });

  it("signs ONE operation that is exactly transfer(recipient, amount), and records nothing for a permission", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    assert.equal(begun.status, "READY");
    assert.equal(w.kernel.rootCalls.length, 1);
    const [calls] = w.kernel.rootCalls;
    assert.equal(calls?.length, 1);
    assert.equal(calls?.[0]?.to.toLowerCase(), CNGN_ADDRESS);
    assert.equal(calls?.[0]?.value, "0");
    assert.equal(
      calls?.[0]?.data.toLowerCase(),
      `0xa9059cbb${word(RECIPIENT_ADDRESS)}${word(BigInt(NAIRA_300).toString(16))}`,
    );
    assert.equal(w.kernel.prepared.length, 0, "no permission was prepared");
    assert.equal(w.kernel.sessionKeys.length, 1, "the fake always makes a key; none is kept");
  });

  it("one passkey answer sends the payment: authorized, consumed, sent, and followed to completion", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    assert.equal(begun.status, "READY");
    if (begun.status !== "READY") return;

    const done = await service.confirm(token, { operation: begun.operation, proof: GOOD });
    assert.equal(done.status, "SENT");
    if (done.status !== "SENT") return;

    assert.equal(w.kernel.rootSends, 1, "exactly one operation was sent");
    assert.equal(w.kernel.delegated.length, 0, "the server key signed nothing");
    const stored = await execution(w, done.executionId);
    assert.equal(stored?.status, "SUBMITTED");
    assert.ok(stored?.authorizationConsumedAt, "the approval was consumed when it was sent");
    const approval = await w.uow.read.paymentAuthorizations.findById(
      stored?.paymentAuthorizationId ?? "",
    );
    assert.equal(approval?.status, "CONSUMED");

    const finished = await w.runner.run(done.executionId);
    assert.equal(finished.status, "PAYMENT_SENT");
    const final = await execution(w, done.executionId);
    assert.equal(final?.status, "COMPLETED");
    assert.equal(final?.settledOutputAmount, NAIRA_300);
    const transfers = w.run.transactions.filter((t) => t.type === "TRANSFER");
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]?.status, "CONFIRMED");
    assert.equal(w.kernel.delegated.length, 0, "following it never involved the server key");
  });

  it("a wrong passkey answer sends nothing and approves nothing", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    assert.equal(begun.status, "READY");
    if (begun.status !== "READY") return;
    await assert.rejects(
      service.confirm(token, { operation: begun.operation, proof: BAD }),
      (error: unknown) => error instanceof KaadaError,
    );
    assert.equal(w.kernel.rootSends, 0);
    const again = await service.begin(token);
    assert.equal(again.status, "READY", "the link is still usable: it was never consumed");
  });

  it("the same answer cannot be used twice", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    if (begun.status !== "READY") throw new Error("not ready");
    assert.equal(
      (await service.confirm(token, { operation: begun.operation, proof: GOOD })).status,
      "SENT",
    );
    await assert.rejects(service.confirm(token, { operation: begun.operation, proof: GOOD }));
    assert.equal(w.kernel.rootSends, 1, "still exactly one send");
  });

  it("an operation sealed for another link is refused", async () => {
    const one = await rootWorld();
    const two = await rootWorld();
    const begun = await one.service.begin(one.token);
    if (begun.status !== "READY") throw new Error("not ready");
    await assert.rejects(
      two.service.confirm(two.token, { operation: begun.operation, proof: GOOD }),
      (error: unknown) => error instanceof KaadaError,
    );
    assert.equal(two.w.kernel.rootSends, 0);
  });

  it("a tampered operation is refused", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    if (begun.status !== "READY") throw new Error("not ready");
    const tampered = `${begun.operation.slice(0, -4)}AAAA`;
    await assert.rejects(service.confirm(token, { operation: tampered, proof: GOOD }));
    assert.equal(w.kernel.rootSends, 0);
  });

  it("if the payee's address changes after the prompt, what was signed is refused", async () => {
    const { w, base, service, token } = await rootWorld();
    const begun = await service.begin(token);
    if (begun.status !== "READY") throw new Error("not ready");
    for (const recipient of base.w.r.world.recipients.values()) {
      recipient.walletAddress = `0x${"99".repeat(20)}`;
    }
    await assert.rejects(
      service.confirm(token, { operation: begun.operation, proof: GOOD }),
      (error: unknown) => error instanceof KaadaError,
    );
    assert.equal(w.kernel.rootSends, 0);
  });

  it("without enough of the token it says so before anything is signed", async () => {
    const { w, base, service, token } = await rootWorld();
    base.w.port.held.set(base.w.r.tokens.cNGN.id, 100n * 10n ** 6n);
    assert.deepEqual(await service.begin(token), { status: "INSUFFICIENT_BALANCE" });
    assert.equal(w.kernel.rootCalls.length, 0);
  });

  it("without CELO for the network fee it says so before anything is signed", async () => {
    const { w, service, token } = await rootWorld();
    w.kernel.native = 0n;
    assert.deepEqual(await service.begin(token), { status: "GAS_FUNDING_REQUIRED" });
    assert.equal(w.kernel.rootCalls.length, 0);
  });

  it("a send the bundler refuses leaves nothing sent and the payment failed", async () => {
    const { w, service, token } = await rootWorld();
    const begun = await service.begin(token);
    if (begun.status !== "READY") throw new Error("not ready");
    w.kernel.sendMode = "reject";
    const result = await service.confirm(token, { operation: begun.operation, proof: GOOD });
    assert.deepEqual(result, { status: "NOT_SENT", code: "BUNDLER_REJECTED" });
    assert.equal(w.kernel.rootSends, 0);
    const [failed] = await w.uow.read.executionPlans.listByStatus(["FAILED"], 5);
    assert.equal(failed?.failureCode, "BUNDLER_REJECTED");
  });

  it("the PIN is never needed, and a PIN sent anyway is ignored", async () => {
    const { service, token } = await rootWorld();
    const begun = await service.begin(token);
    if (begun.status !== "READY") throw new Error("not ready");
    const done = await service.confirm(token, {
      operation: begun.operation,
      proof: GOOD,
      pin: "000000",
    });
    assert.equal(done.status, "SENT");
    void PIN;
  });
});

describe("a wallet whose root is a device key (no passkey)", () => {
  const key = new SoftDeviceKey();

  async function begin(service: RootPaymentService, token: string) {
    const begun = await service.begin(token);
    if (begun.status !== "READY" || begun.challenge.type !== "DEVICE_KEY") {
      throw new Error("expected a device-key prompt");
    }
    return { operation: begun.operation, payload: begun.challenge.payload };
  }

  it("is told to enter the PIN first, because a device key cannot tell a person from a device", async () => {
    const { service, token } = await rootWorld(1000n, key);
    assert.deepEqual(await service.method(token), {
      method: "ROOT",
      rootType: "DEVICE_KEY",
      pinRequired: true,
    });
  });

  it("without the PIN nothing is sent", async () => {
    const { w, service, token } = await rootWorld(1000n, key);
    const { operation, payload } = await begin(service, token);
    const result = await service.confirm(token, { operation, proof: key.proof(payload) });
    assert.deepEqual(result, { status: "PIN_REQUIRED" });
    assert.equal(w.kernel.rootSends, 0);
  });

  it("a wrong PIN sends nothing, even with a good device signature", async () => {
    const { w, service, token } = await rootWorld(1000n, key);
    const { operation, payload } = await begin(service, token);
    const result = await service.confirm(token, {
      operation,
      proof: key.proof(payload),
      pin: "000000",
    });
    assert.equal(result.status, "INVALID_PIN");
    assert.equal(w.kernel.rootSends, 0);
  });

  it("the right PIN and the device's signature send the payment, in one step for the person", async () => {
    const { w, service, token } = await rootWorld(1000n, key);
    const { operation, payload } = await begin(service, token);
    const result = await service.confirm(token, {
      operation,
      proof: key.proof(payload),
      pin: PIN,
    });
    assert.equal(result.status, "SENT");
    assert.equal(w.kernel.rootSends, 1);
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("the right PIN with a bad signature sends nothing", async () => {
    const { w, service, token } = await rootWorld(1000n, key);
    const { operation, payload } = await begin(service, token);
    await assert.rejects(
      service.confirm(token, {
        operation,
        proof: key.proof(payload, { highS: true }),
        pin: PIN,
      }),
    );
    assert.equal(w.kernel.rootSends, 0);
  });
});
