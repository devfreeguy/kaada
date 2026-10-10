import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import type { Repositories } from "@kaada/database";
import { CELO_CHAIN_ID, createMoney, isKaadaError } from "@kaada/domain";
import type { Asset, WalletBalanceReader } from "@kaada/domain";

import { WalletBalanceService } from "../src/core/wallets/balance-service.js";
import { PasskeyService } from "../src/core/wallets/passkey-service.js";
import { WalletSetupService, hashSetupToken } from "../src/core/wallets/setup-service.js";
import { SimpleWebAuthnVerifier } from "../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletController } from "../src/wallet/wallet.controller.js";
import { createSoftwareAuthenticator } from "./support/software-authenticator.js";
import { createWalletService, createWalletWorld } from "./support/wallet-memory.js";
import type { WalletWorld } from "./support/wallet-memory.js";

const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";

interface Setup {
  world: WalletWorld;
  clock: { now: Date };
  users: Set<string>;
  setup: WalletSetupService;
  passkeys: PasskeyService;
  adapter: ReturnType<typeof createWalletService>["adapter"];
  wallets: ReturnType<typeof createWalletService>["service"];
  newUser(): string;
}

function build(overrides: { rpId?: string; origin?: string } = {}): Setup {
  const world = createWalletWorld();
  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const now = () => clock.now;
  const { service: wallets, adapter } = createWalletService(world, { now });
  const passkeys = new PasskeyService({
    unitOfWork: world.unitOfWork,
    verifier: new SimpleWebAuthnVerifier(),
    rpId: overrides.rpId ?? RP_ID,
    origin: overrides.origin ?? ORIGIN,
    now,
  });
  const users = new Set<string>();
  const setup = new WalletSetupService({
    unitOfWork: world.unitOfWork,
    users: {
      findById: (id) =>
        Promise.resolve(
          users.has(id)
            ? { id, createdAt: clock.now, updatedAt: clock.now, status: "ACTIVE" as const }
            : null,
        ),
    },
    passkeys,
    wallets,
    origin: ORIGIN,
    rpId: RP_ID,
    rpName: "Kaada",
    now,
  });
  return {
    world,
    clock,
    users,
    setup,
    passkeys,
    adapter,
    wallets,
    newUser() {
      const id = randomUUID();
      users.add(id);
      return id;
    },
  };
}

/** Runs the whole happy path for a fresh user and returns what a test may want to inspect. */
async function register(s: Setup, userId = s.newUser()) {
  const session = await s.setup.createSession(userId);
  const options = await s.setup.beginRegistration(session.token);
  const authenticator = createSoftwareAuthenticator();
  const response = authenticator.register({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  return { userId, session, options, authenticator, response };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => isKaadaError(error, code as never));
}

describe("setup sessions", () => {
  it("creates a session for a user: opaque token, short expiry, link on the configured origin", async () => {
    const s = build();
    const userId = s.newUser();
    const session = await s.setup.createSession(userId);

    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.url, `${ORIGIN}/setup/${session.token}`);
    assert.equal(session.expiresAt.getTime() - s.clock.now.getTime(), 15 * 60 * 1000);
    assert.equal(
      s.world.audit.some((e) => e.type === "wallet.setup_session_created" && e.userId === userId),
      true,
    );
  });

  it("stores only a hash of the token, never the token", async () => {
    const s = build();
    const session = await s.setup.createSession(s.newUser());
    const [stored] = s.world.setupSessions;
    assert.ok(stored);
    assert.equal(stored.tokenHash, createHash("sha256").update(session.token).digest("hex"));
    assert.equal(stored.tokenHash, hashSetupToken(session.token));
    assert.equal(JSON.stringify(s.world.setupSessions).includes(session.token), false);
    assert.equal(JSON.stringify(s.world.audit).includes(session.token), false);
  });

  it("accepts a valid session and shows the pending state", async () => {
    const s = build();
    const session = await s.setup.createSession(s.newUser());
    const view = await s.setup.view(session.token);
    assert.equal(view.status, "PENDING");
    assert.equal(view.passkeyRegistered, false);
    assert.equal(view.wallet, null);
  });

  it("rejects an expired session", async () => {
    const s = build();
    const session = await s.setup.createSession(s.newUser());
    s.clock.now = new Date(s.clock.now.getTime() + 15 * 60 * 1000 + 1);
    await rejectsWith(s.setup.view(session.token), "SETUP_SESSION_INVALID");
    await rejectsWith(s.setup.beginRegistration(session.token), "SETUP_SESSION_INVALID");
  });

  it("rejects a wrong, malformed or empty token with the same generic error", async () => {
    const s = build();
    await s.setup.createSession(s.newUser());
    for (const token of [
      randomBytes(32).toString("base64url"), // well formed, unknown
      "short",
      "",
      "!".repeat(43),
      `${"a".repeat(42)}%`,
    ]) {
      await assert.rejects(s.setup.view(token), (error) => {
        assert.ok(isKaadaError(error, "SETUP_SESSION_INVALID"));
        assert.equal(error.message, "this setup link is not valid");
        return true;
      });
    }
  });

  it("a newer link retires the older one", async () => {
    const s = build();
    const userId = s.newUser();
    const first = await s.setup.createSession(userId);
    const second = await s.setup.createSession(userId);
    await rejectsWith(s.setup.beginRegistration(first.token), "SETUP_SESSION_INVALID");
    await s.setup.beginRegistration(second.token);
  });

  it("refuses a user that does not exist", async () => {
    const s = build();
    await rejectsWith(s.setup.createSession(randomUUID()), "SETUP_SESSION_INVALID");
  });

  it("a used session cannot register again, but can still be viewed until it expires", async () => {
    const s = build();
    const r = await register(s);
    await s.setup.completeRegistration(r.session.token, r.response);

    await rejectsWith(s.setup.beginRegistration(r.session.token), "SETUP_SESSION_INVALID");
    await rejectsWith(
      s.setup.completeRegistration(r.session.token, r.response),
      "SETUP_SESSION_INVALID",
    );
    await rejectsWith(s.setup.finalize(r.session.token), "SETUP_SESSION_INVALID");
    const view = await s.setup.view(r.session.token);
    assert.equal(view.status, "COMPLETED");
    assert.equal(view.wallet?.status, "ACTIVE");

    s.clock.now = new Date(s.clock.now.getTime() + 16 * 60 * 1000);
    await rejectsWith(s.setup.view(r.session.token), "SETUP_SESSION_INVALID");
  });
});

describe("passkey registration through a setup session", () => {
  it("returns browser-ready options: ES256 only, discoverable, user verification required", async () => {
    const s = build();
    const { options, userId } = await register(s);
    assert.deepEqual(options.rp, { name: "Kaada", id: RP_ID });
    assert.deepEqual(options.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
    assert.equal(options.authenticatorSelection.userVerification, "required");
    assert.equal(options.authenticatorSelection.residentKey, "required");
    assert.equal(options.attestation, "none");
    assert.match(options.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(options.excludeCredentials, []);
    // The user handle is opaque: not the Kaada id, not a name.
    assert.equal(options.user.id.includes(userId), false);
    assert.equal(options.user.displayName, "Kaada wallet");
    assert.equal(
      s.world.audit.some((e) => e.type === "wallet.passkey_registration_started"),
      true,
    );
  });

  it("registers a valid passkey, activates the counterfactual wallet and consumes the session", async () => {
    const s = build();
    const r = await register(s);
    const done = await s.setup.completeRegistration(r.session.token, r.response);

    assert.equal(done.status, "COMPLETED");
    assert.equal(done.wallet?.status, "ACTIVE");
    assert.equal(done.wallet?.deployment, "COUNTERFACTUAL");
    assert.match(done.wallet?.address ?? "", /^0x[0-9a-f]{40}$/);
    assert.equal(done.wallet?.chainId, CELO_CHAIN_ID);
    assert.equal(done.wallet?.userId, r.userId);

    assert.equal(s.world.credentials.length, 1);
    assert.equal(s.world.credentials[0]?.credentialId, r.authenticator.credentialId);
    assert.equal(s.world.setupSessions[0]?.status, "COMPLETED");
    const types = s.world.audit.map((e) => e.type);
    for (const type of [
      "wallet.setup_session_created",
      "wallet.passkey_registration_started",
      "wallet.credential_registered",
      "wallet.provisioned",
      "wallet.setup_session_consumed",
    ]) {
      assert.ok(types.includes(type), type);
    }
  });

  it("stores the public key only: no private key, secret or raw response anywhere", async () => {
    const s = build();
    const r = await register(s);
    await s.setup.completeRegistration(r.session.token, r.response);

    const [credential] = s.world.credentials;
    assert.ok(credential);
    assert.deepEqual(Object.keys(credential).sort(), [
      "createdAt",
      "credentialId",
      "id",
      "publicKeyX",
      "publicKeyY",
      "rpId",
      "signCount",
      "userId",
    ]);
    assert.equal(credential.publicKeyX, r.authenticator.x);
    const everything = JSON.stringify([s.world.credentials, s.world.audit, s.world.setupSessions]);
    assert.equal(everything.includes("clientDataJSON"), false);
    assert.equal(everything.includes("attestationObject"), false);
    assert.equal(
      everything.includes(r.options.challenge),
      false,
      "no challenge in the audit trail",
    );
    assert.equal(/privateKey|secret|mnemonic|seed/i.test(everything), false);
  });

  it("rejects a response signed for a different challenge", async () => {
    const s = build();
    const r = await register(s);
    const wrong = r.authenticator.register({
      challenge: randomBytes(32).toString("base64url"),
      origin: ORIGIN,
      rpId: RP_ID,
    });
    await rejectsWith(s.setup.completeRegistration(r.session.token, wrong), "CREDENTIAL_REJECTED");
    assert.equal(s.world.credentials.length, 0);
    assert.equal(s.world.wallets.size, 0);
    assert.equal(
      s.world.setupSessions[0]?.status,
      "PENDING",
      "a failed attempt does not burn the link",
    );
    assert.equal(
      s.world.audit.some((e) => e.type === "wallet.setup_failed"),
      true,
    );
  });

  it("rejects a response from the wrong origin", async () => {
    const s = build();
    const r = await register(s);
    const wrong = r.authenticator.register({
      challenge: r.options.challenge,
      origin: "https://evil.example",
      rpId: RP_ID,
    });
    await rejectsWith(s.setup.completeRegistration(r.session.token, wrong), "CREDENTIAL_REJECTED");
    assert.equal(s.world.credentials.length, 0);
  });

  it("rejects a response for the wrong relying party id", async () => {
    const s = build();
    const r = await register(s);
    const wrong = r.authenticator.register({
      challenge: r.options.challenge,
      origin: ORIGIN,
      rpId: "evil.example",
    });
    await rejectsWith(s.setup.completeRegistration(r.session.token, wrong), "CREDENTIAL_REJECTED");
    assert.equal(s.world.credentials.length, 0);
  });

  it("rejects an unsupported algorithm (only ES256 / P-256 is accepted)", async () => {
    const s = build();
    const r = await register(s);
    for (const algorithm of [-257, -8, -35]) {
      const session = await s.setup.createSession(r.userId);
      const options = await s.setup.beginRegistration(session.token);
      const response = createSoftwareAuthenticator().register({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        algorithm,
      });
      await rejectsWith(
        s.setup.completeRegistration(session.token, response),
        "CREDENTIAL_REJECTED",
      );
    }
    assert.equal(s.world.credentials.length, 0);
  });

  it("rejects a response where the user was not verified", async () => {
    const s = build();
    const r = await register(s);
    const wrong = r.authenticator.register({
      challenge: r.options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      userVerified: false,
    });
    await rejectsWith(s.setup.completeRegistration(r.session.token, wrong), "CREDENTIAL_REJECTED");
  });

  it("rejects a replay of a valid registration", async () => {
    const s = build();
    const r = await register(s);
    await s.setup.completeRegistration(r.session.token, r.response);
    // The link is spent and the challenge is used: neither path accepts it again.
    await rejectsWith(
      s.setup.completeRegistration(r.session.token, r.response),
      "SETUP_SESSION_INVALID",
    );
    await rejectsWith(s.passkeys.completeRegistration(r.userId, r.response), "CREDENTIAL_REJECTED");
    assert.equal(s.world.credentials.length, 1);
    assert.equal(s.world.wallets.size, 1);
  });

  it("an expired challenge is rejected", async () => {
    const s = build();
    const r = await register(s);
    s.clock.now = new Date(s.clock.now.getTime() + 6 * 60 * 1000); // past the 5 minute challenge
    await rejectsWith(
      s.setup.completeRegistration(r.session.token, r.response),
      "CREDENTIAL_REJECTED",
    );
  });

  it("two simultaneous submissions of one registration create one credential and one wallet", async () => {
    const s = build();
    const r = await register(s);
    const results = await Promise.allSettled([
      s.setup.completeRegistration(r.session.token, r.response),
      s.setup.completeRegistration(r.session.token, r.response),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(s.world.credentials.length, 1);
    assert.equal(s.world.wallets.size, 1);
  });

  it("never creates a second wallet: a finished user gets no new link and no second passkey", async () => {
    const s = build();
    const r = await register(s);
    await s.setup.completeRegistration(r.session.token, r.response);

    await rejectsWith(s.setup.createSession(r.userId), "WALLET_ALREADY_SETUP");
    assert.equal(s.world.wallets.size, 1);
    assert.equal(s.world.credentials.length, 1);
  });

  it("resumes after a provisioning failure without registering a second passkey", async () => {
    const s = build();
    const r = await register(s);
    s.adapter.failNext = 1;
    await rejectsWith(
      s.setup.completeRegistration(r.session.token, r.response),
      "WALLET_PROVISIONING_FAILED",
    );

    assert.equal(s.world.credentials.length, 1, "the passkey was kept");
    assert.equal(
      s.world.setupSessions[0]?.status,
      "PENDING",
      "the link survives a provider failure",
    );
    const view = await s.setup.view(r.session.token);
    assert.equal(view.passkeyRegistered, true);
    assert.equal(view.wallet?.status, "PROVISIONING");

    // Registering again is refused (one passkey is enough); finishing is the path.
    await rejectsWith(s.setup.beginRegistration(r.session.token), "WALLET_ALREADY_SETUP");
    const done = await s.setup.finalize(r.session.token);
    assert.equal(done.wallet?.status, "ACTIVE");
    assert.equal(s.world.wallets.size, 1);
    assert.equal(s.world.setupSessions[0]?.status, "COMPLETED");
  });

  it("finalize without a passkey is refused", async () => {
    const s = build();
    const session = await s.setup.createSession(s.newUser());
    await rejectsWith(s.setup.finalize(session.token), "ROOT_CREDENTIAL_REQUIRED");
  });
});

describe("wallet HTTP edge", () => {
  function controller(s: Setup, nodeEnv: AppConfig["nodeEnv"] = "development", balances = null) {
    const created: { id: string }[] = [];
    const repositories = {
      users: {
        create: (user: { id: string }) => {
          s.users.add(user.id);
          created.push(user);
          return Promise.resolve(user);
        },
      },
    } as unknown as Repositories;
    return {
      created,
      controller: new WalletController(s.setup, balances, { nodeEnv } as AppConfig, repositories),
    };
  }

  it("needs a bearer setup token on every endpoint", async () => {
    const { controller: c } = controller(build());
    await assert.rejects(c.details(undefined), UnauthorizedException);
    await assert.rejects(c.details("Basic abc"), UnauthorizedException);
    await assert.rejects(c.registrationOptions(undefined), UnauthorizedException);
    await assert.rejects(c.finalize(undefined), UnauthorizedException);
    await assert.rejects(c.registrationVerify({}, undefined), UnauthorizedException);
  });

  it("an unknown token is a generic 401", async () => {
    const { controller: c } = controller(build());
    await assert.rejects(
      c.details(`Bearer ${randomBytes(32).toString("base64url")}`),
      (error) => error instanceof UnauthorizedException,
    );
  });

  it("takes the user only from the token: no endpoint has a user parameter and a body userId is ignored", async () => {
    // Function.length is the number of declared parameters: the token header (and the body).
    assert.equal(WalletController.prototype.details.length, 1);
    assert.equal(WalletController.prototype.walletBalances.length, 1);
    assert.equal(WalletController.prototype.registrationOptions.length, 1);
    assert.equal(WalletController.prototype.finalize.length, 1);
    assert.equal(WalletController.prototype.registrationVerify.length, 2);

    const s = build();
    const victim = s.newUser();
    const attacker = s.newUser();
    await s.setup.createSession(victim);
    const attackerSession = await s.setup.createSession(attacker);
    const { controller: c } = controller(s);
    const authenticator = createSoftwareAuthenticator();
    const options = await c.registrationOptions(`Bearer ${attackerSession.token}`);
    const response = {
      ...(authenticator.register({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }) as object),
      userId: victim,
    };
    await c.registrationVerify(response, `Bearer ${attackerSession.token}`);
    assert.equal(
      s.world.credentials.every((x) => x.userId === attacker),
      true,
    );
    assert.equal(
      [...s.world.wallets.values()].some((w) => w.userId === victim),
      false,
    );
  });

  it("rejects a malformed registration body", async () => {
    const s = build();
    const session = await s.setup.createSession(s.newUser());
    const { controller: c } = controller(s);
    await assert.rejects(
      c.registrationVerify({ id: "x" }, `Bearer ${session.token}`),
      BadRequestException,
    );
  });

  it("the full flow over the controller returns a wallet view with no internals or secrets", async () => {
    const s = build();
    const { controller: c } = controller(s);
    const dev = await c.devSetupSession({});
    const token = dev.url.split("/setup/")[1] ?? "";
    const bearerToken = `Bearer ${token}`;

    const options = await c.registrationOptions(bearerToken);
    const authenticator = createSoftwareAuthenticator();
    const verified = await c.registrationVerify(
      authenticator.register({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
      bearerToken,
    );
    assert.equal(verified.status, "COMPLETED");
    assert.equal(verified.wallet?.status, "ACTIVE");
    assert.equal(verified.wallet?.deploymentStatus, "COUNTERFACTUAL");

    const details = await c.details(bearerToken);
    assert.equal(details.passkeyRegistered, true);
    assert.equal(details.wallet?.address, verified.wallet?.address);

    const text = JSON.stringify([dev, options, verified, details]);
    assert.equal(text.includes("providerAccountId"), false);
    assert.equal(text.includes("tokenHash"), false);
    assert.equal(text.includes("publicKey"), false);
    assert.equal(
      /privateKey|mnemonic|seed|secret/i.test(JSON.stringify([verified, details])),
      false,
    );
  });

  it("the development session endpoint does not exist in production", async () => {
    const { controller: c } = controller(build(), "production");
    await assert.rejects(c.devSetupSession({}), NotFoundException);
  });
});

describe("wallet balances", () => {
  const asset = (
    symbol: string,
    decimals: number,
    kind: Asset["kind"] = "USD_STABLECOIN",
  ): Asset => ({
    id: randomUUID(),
    symbol,
    name: symbol,
    kind,
    decimals,
    chainId: CELO_CHAIN_ID,
    contractAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
    isActive: true,
  });

  function balancesWorld(held: Record<string, string>) {
    const s = build();
    const tokens = [
      asset("USDT", 6),
      asset("USDC", 6),
      asset("wBRL", 18, "LOCAL_STABLECOIN"),
      asset("cNGN", 6, "LOCAL_STABLECOIN"),
    ];
    s.world.assets.push(
      ...tokens,
      // Never listed: fiat, inactive, another chain.
      {
        ...asset("BRL", 2, "FIAT"),
        chainId: undefined as never,
        contractAddress: undefined as never,
      },
      { ...asset("OLD", 6), isActive: false },
      { ...asset("ETHUSD", 6), chainId: 1 },
    );
    const asked: string[][] = [];
    const reader: WalletBalanceReader = {
      readBalances: ({ assetIds, address, chainId }) => {
        asked.push(assetIds);
        return Promise.resolve({
          chainId,
          address,
          tokens: assetIds.map((id) => {
            const symbol = tokens.find((t) => t.id === id)?.symbol ?? "";
            return createMoney(held[symbol] ?? "0", id);
          }),
        });
      },
    };
    const service = new WalletBalanceService({
      assets: s.world.repositories.assets,
      reader,
      wallets: s.wallets,
    });
    return { s, service, tokens, asked };
  }

  async function funded(held: Record<string, string>) {
    const w = balancesWorld(held);
    const r = await register(w.s);
    await w.s.setup.completeRegistration(r.session.token, r.response);
    return { ...w, userId: r.userId };
  }

  it("reads a USDT balance as canonical Money with a presentation string", async () => {
    const { service, userId, tokens } = await funded({ USDT: "2000000" });
    const view = await service.forUser(userId);
    const usdt = view.balances.find((b) => b.symbol === "USDT");
    assert.deepEqual(usdt?.money, { amount: "2000000", assetId: tokens[0]?.id });
    assert.equal(usdt?.formatted, "2");
    assert.equal(view.wallet.deployment, "COUNTERFACTUAL");
  });

  it("returns zero balances for an empty wallet", async () => {
    const { service, userId } = await funded({});
    const view = await service.forUser(userId);
    assert.equal(view.balances.length, 4);
    assert.equal(
      view.balances.every((b) => b.money.amount === "0" && b.formatted === "0"),
      true,
    );
  });

  it("reads several supported assets in one batch, exactly, with no floats", async () => {
    const { service, userId, asked } = await funded({
      USDT: "1500000",
      USDC: "123456",
      wBRL: "1234500000000000000000",
      cNGN: "1",
    });
    const view = await service.forUser(userId);
    assert.deepEqual(Object.fromEntries(view.balances.map((b) => [b.symbol, b.formatted])), {
      USDC: "0.123456",
      USDT: "1.5",
      cNGN: "0.000001",
      wBRL: "1234.5",
    });
    assert.equal(asked.length, 1, "one batched read");
    assert.equal(asked[0]?.length, 4);
  });

  it("lists only supported active Celo tokens, never discovered assets", async () => {
    const { service } = balancesWorld({});
    const symbols = (await service.supportedTokens()).map((t) => t.symbol);
    assert.deepEqual(symbols, ["USDC", "USDT", "cNGN", "wBRL"]);
  });

  it("needs an active wallet", async () => {
    const { service, s } = balancesWorld({});
    await rejectsWith(service.forUser(s.newUser()), "WALLET_NOT_ACTIVE");
  });
});
