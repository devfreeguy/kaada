import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMoney, isKaadaError } from "@kaada/domain";
import type { DelegatedPermission, WalletCredential } from "@kaada/domain";

import {
  firmWorld,
  quotedReply,
  SWAP_TARGET,
  USDT_ADDRESS,
  WBRL_ADDRESS,
} from "./support/firm-world.js";
import type { FirmWorld } from "./support/firm-world.js";
import { SENDER } from "./support/harness.js";
import { WALLET_ID } from "./support/payment-world.js";
import { EXACT_OUT, runWorld } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";
import { SoftDeviceKey } from "./support/soft-device-key.js";

/*
 * Root actions work the same for both root types: the server fixes the operation and its challenge, the wallet's root signs
 * exactly that (a passkey assertion or a device-key signature), and nothing else changes. These run the REAL RootActionService,
 * runner and adapters over in-memory stores and a scripted Kernel/bundler.
 */

const reject = (code: string) => (error: unknown) => isKaadaError(error, code as never);

const record = (w: RunWorld) => w.uow.read.executionPlans.findById(w.executionId);

async function pendingLink(w: RunWorld) {
  const session = await w.uow.read.rootActions.findPendingByExecution(w.executionId);
  assert.ok(session, "a root action is pending");
  const link = await w.rootActions.issueLink({ sessionId: session.id, userId: session.userId });
  return { session, token: link.token };
}

describe("installing a permission with a DEVICE-KEY root", () => {
  async function deviceWorld() {
    const key = new SoftDeviceKey();
    const w = await runWorld({ deviceRoot: key });
    return { key, w };
  }

  it("asks for the device key, not a passkey, and sends nothing until it signs", async () => {
    const { w } = await deviceWorld();
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "ROOT_ACTION_REQUIRED");
    assert.equal((await record(w))?.status, "REQUIRES_USER_ACTION");
    assert.equal(w.kernel.rootSends, 0);
    const { token, session } = await pendingLink(w);
    const view = await w.rootActions.view(token);
    assert.equal(view.action, "ROOT_DEVICE_KEY_REQUIRED");
    assert.equal(view.rootType, "DEVICE_KEY");
    assert.equal(await w.rootActions.requiredAction(session.walletId), "ROOT_DEVICE_KEY_REQUIRED");
    assert.match(view.message, /with this device/);
  });

  it("fixes the payload on the server: the documented KaadaDeviceKey/v1 bytes over THIS operation's hash", async () => {
    const { key, w } = await deviceWorld();
    await w.runner.run(w.executionId);
    const { token, session } = await pendingLink(w);
    const challenge = await w.rootActions.options(token);
    assert.equal(challenge.type, "DEVICE_KEY");
    if (challenge.type !== "DEVICE_KEY") return;
    assert.equal(challenge.action, "ROOT_DEVICE_KEY_REQUIRED");
    assert.equal(challenge.keyId, key.keyId);
    assert.equal(challenge.algorithm, "ECDSA_P256_SHA256");
    assert.equal((challenge.payload.length - 2) / 2, 153);
    assert.equal(
      Buffer.from(challenge.payload.slice(2, 36), "hex").toString(),
      "KaadaDeviceKey/v1",
    );
    // The last 32 bytes ARE the operation hash the server prepared: the browser signs no calldata of its own.
    assert.equal(`0x${challenge.payload.slice(-64)}`, session.challenge.toLowerCase());
    assert.equal(w.rootActions.complete.length, 2, "the completion takes a token and a proof only");
  });

  it("installs the permission when the device key signs, then the payment completes", async () => {
    const { w } = await deviceWorld();
    assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
    await w.confirmRootAction();
    assert.equal(w.kernel.rootSends, 1);
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_SENT");
    assert.equal((await record(w))?.status, "COMPLETED");
    assert.equal(w.kernel.delegated.length, 2, "approval, then swap + payout");
  });

  it("a wrong signature, another key, a high-s signature or a passkey proof changes nothing", async () => {
    const { key, w } = await deviceWorld();
    await w.runner.run(w.executionId);
    const { token } = await pendingLink(w);
    const challenge = await w.rootActions.options(token);
    if (challenge.type !== "DEVICE_KEY") throw new Error("expected a device challenge");

    const stranger = new SoftDeviceKey();
    await assert.rejects(
      w.rootActions.complete(token, stranger.proof(challenge.payload)),
      reject("CREDENTIAL_REJECTED"),
    );
    await assert.rejects(
      w.rootActions.complete(token, key.proof(challenge.payload, { highS: true })),
      reject("CREDENTIAL_REJECTED"),
    );
    await assert.rejects(
      w.rootActions.complete(token, key.proof(`${challenge.payload}00`)),
      reject("CREDENTIAL_REJECTED"),
      "a signature over other bytes",
    );
    await assert.rejects(
      w.rootActions.complete(token, {
        type: "PASSKEY",
        assertion: { id: "credential-0", good: true },
      }),
      reject("CREDENTIAL_REJECTED"),
      "the wrong ROOT TYPE for this wallet",
    );
    assert.equal(w.kernel.rootSends, 0, "nothing was sent");
    const still = await w.uow.read.rootActions.findPendingByExecution(w.executionId);
    assert.ok(still, "the session is still pending: a bad proof does not burn it");
    // The right proof still works afterwards.
    await w.rootActions.complete(token, key.proof(challenge.payload));
    assert.equal(w.kernel.rootSends, 1);
  });

  it("a link works once: a replay of a good proof is refused and nothing is sent twice", async () => {
    const { key, w } = await deviceWorld();
    await w.runner.run(w.executionId);
    const { token } = await pendingLink(w);
    const challenge = await w.rootActions.options(token);
    if (challenge.type !== "DEVICE_KEY") throw new Error("expected a device challenge");
    const proof = key.proof(challenge.payload);
    await w.rootActions.complete(token, proof);
    await assert.rejects(
      w.rootActions.complete(token, proof),
      reject("AUTHORIZATION_SESSION_INVALID"),
    );
    assert.equal(w.kernel.rootSends, 1);
  });

  it("a revoked or replaced root cannot sign: the wallet has no root until one is recorded", async () => {
    const { key, w } = await deviceWorld();
    await w.runner.run(w.executionId);
    const { token } = await pendingLink(w);
    const challenge = await w.rootActions.options(token);
    if (challenge.type !== "DEVICE_KEY") throw new Error("expected a device challenge");
    // Another root becomes the wallet's root: the old key's signature no longer verifies for the link.
    const replacement = new SoftDeviceKey();
    const rootAdapters = (
      w.rootActions as unknown as {
        deps: { roots: { activeRoot(wallet: unknown): Promise<unknown> } };
      }
    ).deps;
    const original = rootAdapters.roots.activeRoot.bind(rootAdapters.roots);
    rootAdapters.roots.activeRoot = async (wallet) => {
      const root = (await original(wallet)) as Record<string, unknown>;
      return {
        ...root,
        keyId: replacement.keyId,
        publicKeyX: replacement.publicKeyX,
        publicKeyY: replacement.publicKeyY,
      };
    };
    await assert.rejects(
      w.rootActions.complete(token, key.proof(challenge.payload)),
      reject("CREDENTIAL_REJECTED"),
    );
    assert.equal(w.kernel.rootSends, 0);
  });
});

describe("the same flow with a PASSKEY root (unchanged)", () => {
  it("asks for the passkey, installs on a valid assertion and rejects a device proof", async () => {
    const w = await runWorld();
    await w.runner.run(w.executionId);
    const { token, session } = await pendingLink(w);
    const view = await w.rootActions.view(token);
    assert.equal(view.action, "ROOT_PASSKEY_REQUIRED");
    assert.equal(await w.rootActions.requiredAction(session.walletId), "ROOT_PASSKEY_REQUIRED");
    await assert.rejects(
      w.rootActions.complete(token, new SoftDeviceKey().proof(`0x${"11".repeat(153)}`)),
      reject("CREDENTIAL_REJECTED"),
      "a device proof for a passkey wallet",
    );
    await w.confirmRootAction();
    assert.equal(w.kernel.rootSends, 1);
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
  });
});

// ─────────────────────── the repeat payment asks for the PIN only ───────────────────────

describe("a repeat payment needs no root signature", () => {
  const MAX_IN = 92_306_281n;

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

  const permission = (f: FirmWorld): DelegatedPermission => ({
    id: "00000000-0000-4000-8000-0000000000e1",
    userId: SENDER,
    walletId: WALLET_ID,
    provider: "zerodev-kernel-v3.3",
    providerPermissionId: "perm-1",
    chainId: 42220,
    status: "ACTIVE",
    allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
    allowedContracts: [USDT_ADDRESS, SWAP_TARGET, WBRL_ADDRESS],
    allowedAssetIds: [f.w.r.h.assets.USDT.id, f.w.r.tokens.wBRL.id],
    perTransactionLimit: createMoney(String(MAX_IN), f.w.r.h.assets.USDT.id),
    enforcement: {
      contracts: "ONCHAIN",
      operations: "ONCHAIN",
      assets: "ONCHAIN",
      perTransactionLimit: "ONCHAIN",
      cumulativeLimit: "KAADA_POLICY",
      validity: "ONCHAIN",
    },
    validFrom: new Date(f.now().getTime() - 60_000),
    expiresAt: new Date(f.now().getTime() + 3_600_000),
    createdAt: f.now(),
  });

  async function prepared(deviceRoot: SoftDeviceKey | undefined) {
    const f = await firmWorld();
    f.transport.enqueue(
      quotedReply({
        now: f.now(),
        sellAmount: "92200000",
        takerPays: "92200000",
        buyAmount: EXACT_OUT,
      }),
    );
    if (deviceRoot) {
      f.credentials.length = 0; // no passkey at all
      f.recordedRoot.value = deviceRow(deviceRoot);
    }
    return f;
  }

  const planOf = (f: FirmWorld) =>
    f.firm.plans.at(-1)?.plan as unknown as {
      status: string;
      accountRequirements: {
        deploymentRequired: boolean;
        rootSignatureRequired: boolean;
        rootAvailable: boolean;
      };
      permissionRequirement: { state: string; installSigner: string };
    };

  for (const [label, key] of [
    ["PASSKEY", undefined],
    ["DEVICE_KEY", new SoftDeviceKey()],
  ] as const) {
    it(`${label}: the FIRST payment needs the root (deploy + install), described the same way`, async () => {
      const f = await prepared(key);
      const outcome = await f.service.prepare(f.authorization.id);
      assert.equal(outcome.status, "EXECUTION_READY");
      const plan = planOf(f);
      assert.equal(plan.accountRequirements.rootAvailable, true);
      assert.equal(plan.accountRequirements.deploymentRequired, true);
      assert.equal(plan.accountRequirements.rootSignatureRequired, true);
      assert.equal(plan.permissionRequirement.state, "INSTALLATION_REQUIRED");
      assert.equal(plan.permissionRequirement.installSigner, "ROOT");
    });

    it(`${label}: a REPEAT payment, with the account deployed and a covering permission installed, asks the root for nothing`, async () => {
      const f = await prepared(key);
      f.chain.deployed = true;
      f.permissions.push(permission(f));
      const outcome = await f.service.prepare(f.authorization.id);
      assert.equal(outcome.status, "EXECUTION_READY");
      const plan = planOf(f);
      assert.equal(plan.permissionRequirement.state, "SATISFIED");
      assert.equal(
        plan.accountRequirements.rootSignatureRequired,
        false,
        "PIN-only: no root prompt",
      );
    });
  }

  it("a wallet with neither a passkey nor a recorded root is blocked, not silently paid", async () => {
    const f = await prepared(undefined);
    f.credentials.length = 0;
    const outcome = await f.service.prepare(f.authorization.id);
    assert.ok(outcome.status === "EXECUTION_BLOCKED" && outcome.blockers.includes("NO_ROOT"));
  });

  it("the authorized ceiling is the same whatever the root", async () => {
    const [passkey, device] = await Promise.all([
      prepared(undefined),
      prepared(new SoftDeviceKey()),
    ]);
    const a = passkey.authorization.bounds;
    const b = device.authorization.bounds;
    assert.ok(a.mode === "EXACT_OUTPUT" && b.mode === "EXACT_OUTPUT");
    assert.equal(a.exactOutput.amount, b.exactOutput.amount);
    assert.equal(a.maximumInput.amount, b.maximumInput.amount);
  });
});
