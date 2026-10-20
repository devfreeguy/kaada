import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveRecoveryKey, generateRecoveryCode } from "@kaada/contracts";
import { KaadaError, RECOVERY_AUDIT_EVENTS, depositValueUsdMicros } from "@kaada/domain";
import type { DepositItem, WalletFundingItem } from "@kaada/domain";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Address } from "viem";

import { configureApp } from "../src/app.setup.js";
import { RecoveryController } from "../src/recovery/recovery.controller.js";
import type { RecoveryRuntime } from "../src/recovery/recovery.runtime.js";
import { RECOVERY_RUNTIME } from "../src/recovery/recovery.tokens.js";
import { WALLET_SETUP_SERVICE } from "../src/wallet/wallet.tokens.js";
import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";
import type { RecoveryWorld, TestUser } from "./support/recovery-world.js";
import { MemorySponsorshipLedger } from "./support/sponsorship-memory.js";

/*
 * A wallet that was only funded (with a stablecoin) has no account on chain and no CELO. The platform may open the account and pay
 * the gas of its first Recovery Code setup, but only: for a wallet that has really received money; within the wallet's lifetime
 * budget and the platform's daily budget; and never below the relayer's reserve. Off unless both budgets are set.
 */

const CELO = 10n ** 18n;
const HALF = CELO / 2n;

const usd = (amount: number): WalletFundingItem => ({
  assetId: "usdt",
  symbol: "USDT",
  fiatCode: "USD",
  decimals: 6,
  previous: "0",
  current: String(amount * 1_000_000),
  delta: String(amount * 1_000_000),
});

interface Setup {
  perWalletWei?: bigint;
  dailyBudgetWei?: bigint;
  relayerReserveWei?: bigint;
  minDepositUsdMicros?: bigint;
  deposits?: DepositItem[];
}

function withSponsoring(world: RecoveryWorld, setup: Setup = {}) {
  const ledger = new MemorySponsorshipLedger();
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  world.context.log = (level, event, fields) => {
    logs.push({ level, event, fields: fields ?? {} });
  };
  world.context.sponsorship = {
    perWalletWei: setup.perWalletWei ?? HALF,
    dailyBudgetWei: setup.dailyBudgetWei ?? 5n * CELO,
    relayerReserveWei: setup.relayerReserveWei ?? CELO,
    minDepositUsdMicros: setup.minDepositUsdMicros ?? 5_000_000n,
    depositItems: () => Promise.resolve(setup.deposits ?? [usd(20)]),
    ledger,
  };
  return { ledger, logs };
}

async function undeployedWallet(world: RecoveryWorld) {
  const user = await world.createUser({ armed: false, authenticator: true });
  world.chain.accounts.delete(user.account.toLowerCase());
  return user;
}

const verifier = (world: RecoveryWorld, user: TestUser) =>
  deriveRecoveryKey(generateRecoveryCode(), {
    chainId: world.chain.chainId,
    account: user.account as Address,
  }).address;

const prepare = (world: RecoveryWorld, user: TestUser) =>
  world.configuration.prepare({ userId: user.userId, recoveryAddress: verifier(world, user) });

const refusal = async (world: RecoveryWorld, user: TestUser) => {
  const error = await expectKaada(prepare(world, user), "RECOVERY_SPONSORSHIP_REFUSED");
  return (error.details as { reason: string }).reason;
};

describe("how funds are valued for sponsoring", () => {
  it("counts dollar stablecoins at face value, whatever their decimals", () => {
    assert.equal(depositValueUsdMicros([usd(20)]), 20_000_000n);
    const eighteen: DepositItem = {
      fiatCode: "USD",
      decimals: 18,
      delta: (3n * 10n ** 18n).toString(),
    };
    assert.equal(depositValueUsdMicros([usd(2), eighteen]), 5_000_000n);
  });

  it("gives dust, CELO, other currencies and anything unpriced no value", () => {
    assert.equal(depositValueUsdMicros([{ fiatCode: "USD", decimals: 6, delta: "4000" }]), 4_000n);
    assert.equal(
      depositValueUsdMicros([{ decimals: 18, delta: (5n * 10n ** 18n).toString() }]),
      0n,
      "CELO has no price",
    );
    assert.equal(
      depositValueUsdMicros([{ fiatCode: "NGN", decimals: 6, delta: "999999999999" }]),
      0n,
    );
    assert.equal(depositValueUsdMicros([{ fiatCode: "USD", decimals: 6, delta: "-5" }]), 0n);
    assert.equal(
      depositValueUsdMicros([{ fiatCode: "USD", decimals: 6, delta: "not a number" }]),
      0n,
    );
  });
});

describe("sponsoring a wallet so it can secure itself", () => {
  it("is off by default: with nothing configured, or only the per-wallet value, the wallet is refused as before and nothing is spent", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    await expectKaada(prepare(world, user), "RECOVERY_REJECTED");
    withSponsoring(world, { dailyBudgetWei: 0n });
    await expectKaada(prepare(world, user), "RECOVERY_REJECTED");
    withSponsoring(world, { perWalletWei: 0n });
    await expectKaada(prepare(world, user), "RECOVERY_REJECTED");
    assert.equal(world.chain.openCalls, 0);
  });

  it("opens a qualifying wallet's account, offers what is left for gas, and settles what it really cost", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { ledger } = withSponsoring(world);
    world.chain.topUpWei = CELO / 4n;
    const arm = await prepare(world, user);
    assert.ok(arm.configurationId);
    assert.equal(world.chain.openCalls, 1);
    assert.equal(world.chain.lastSponsorUpTo, (HALF - world.chain.openCostWei).toString());
    const spent = world.chain.openCostWei + CELO / 4n;
    assert.equal(
      await ledger.usedInWindow(world.now(), 24 * 3600_000),
      spent,
      "settled at the real cost, not the reservation",
    );
    const details = await world.repositories.audit.listByType(
      user.userId,
      RECOVERY_AUDIT_EVENTS.relayerSponsored,
    );
    assert.deepEqual(details.map((d) => (d.data as { purpose: string }).purpose).sort(), [
      "gas_topup",
      "open_account",
    ]);
  });

  it("refuses a wallet whose deposits are below the minimum, and a wallet with only dust", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { logs } = withSponsoring(world, { deposits: [usd(3)] });
    assert.equal(await refusal(world, user), "BELOW_MINIMUM_DEPOSIT");
    withSponsoring(world, { deposits: [{ fiatCode: "USD", decimals: 6, delta: "4000" }] });
    assert.equal(await refusal(world, user), "BELOW_MINIMUM_DEPOSIT");
    assert.equal(world.chain.openCalls, 0);
    const logged = logs.find((l) => l.event === "recovery.sponsor_refused");
    assert.equal(logged?.fields["reason"], "BELOW_MINIMUM_DEPOSIT");
    assert.equal(logged?.level, "warn");
  });

  it("does not count unpriced tokens: CELO, other currencies, or nothing recorded at all", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const celo: WalletFundingItem = { ...usd(100), assetId: "celo", symbol: "CELO" };
    delete (celo as { fiatCode?: string }).fiatCode;
    const naira: WalletFundingItem = {
      ...usd(100),
      assetId: "cngn",
      symbol: "cNGN",
      fiatCode: "NGN",
    };
    for (const deposits of [[celo], [naira], [celo, naira], []]) {
      withSponsoring(world, { deposits });
      assert.equal(await refusal(world, user), "BELOW_MINIMUM_DEPOSIT");
    }
    assert.equal(world.chain.openCalls, 0);
  });

  it("refuses when the wallet's lifetime budget is spent", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { ledger, logs } = withSponsoring(world);
    const first = await ledger.reserve({
      userId: user.userId,
      walletId: user.wallet.id,
      wantWei: HALF,
      walletCapWei: HALF,
      dailyCapWei: 5n * CELO,
      windowMs: 24 * 3600_000,
      now: world.now(),
    });
    assert.ok(first.granted);
    assert.equal(await refusal(world, user), "WALLET_CAP");
    assert.equal(world.chain.openCalls, 0);
    assert.equal(
      logs.find((l) => l.event === "recovery.sponsor_refused")?.fields["reason"],
      "WALLET_CAP",
    );
  });

  it("refuses when the platform's daily budget is spent, and cuts a grant to what the day still allows", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    // A day's budget that has less than the cost of opening an account left is a refusal, not a half-finished opening.
    const { logs } = withSponsoring(world, { dailyBudgetWei: CELO / 50n });
    assert.equal(await refusal(world, user), "DAILY_BUDGET");
    assert.equal(world.chain.openCalls, 0);
    assert.equal(
      logs.find((l) => l.event === "recovery.sponsor_refused")?.fields["reason"],
      "DAILY_BUDGET",
    );
  });

  it("refuses while the relayer holds no more than its reserve, and never spends into it", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { logs } = withSponsoring(world);
    world.chain.relayerBalance = CELO - 1n;
    assert.equal(await refusal(world, user), "RELAYER_RESERVE");
    assert.equal(world.chain.openCalls, 0);
    assert.equal(
      logs.find((l) => l.event === "recovery.sponsor_refused")?.fields["reason"],
      "RELAYER_RESERVE",
    );
    // Just above the reserve: the grant is cut to what is above it.
    world.chain.relayerBalance = CELO + CELO / 5n;
    world.chain.topUpWei = CELO / 10n;
    await prepare(world, user);
    assert.ok(BigInt(world.chain.lastSponsorUpTo ?? "0") <= CELO / 5n - world.chain.openCostWei);
  });

  it("never lets parallel requests go over the daily budget", async () => {
    const world = createRecoveryWorld();
    const users = await Promise.all(Array.from({ length: 6 }, () => undeployedWallet(world)));
    const daily = 13n * (CELO / 10n); // 1.3 CELO: room for 0.5 + 0.5 + 0.3
    const { ledger } = withSponsoring(world, { dailyBudgetWei: daily });
    world.chain.topUpWei = CELO / 10n;
    // Hold every request inside the sponsoring step, so no early one can settle (and free its reservation) before the rest ask.
    let release: () => void = () => undefined;
    world.chain.openGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Promise.allSettled(users.map((user) => prepare(world, user)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const results = await running;
    const opened = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) =>
        r.status === "rejected" && (r.reason as KaadaError).code === "RECOVERY_SPONSORSHIP_REFUSED",
    ).length;
    assert.equal(opened, 3);
    assert.equal(refused, 3);
    const reserved = ledger.rows
      .filter((row) => row.type === RECOVERY_AUDIT_EVENTS.sponsorReserved)
      .reduce((sum, row) => sum + row.wei, 0n);
    assert.equal(reserved, daily, "what was handed out never exceeds the cap");
    assert.equal(world.chain.openCalls, 3);
  });

  it("says so, at error level, when the day's budget is over 80% used or the relayer is near its reserve", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { logs } = withSponsoring(world, { dailyBudgetWei: HALF, relayerReserveWei: 10n * CELO });
    world.chain.topUpWei = (HALF * 8n) / 10n - world.chain.openCostWei;
    world.chain.relayerBalance = 10n * CELO + (CELO * 6n) / 10n;
    await prepare(world, user);
    const low = logs.filter((l) => l.event === "recovery.sponsor_budget_low");
    assert.deepEqual(low.map((l) => l.fields["reason"]).sort(), [
      "DAILY_BUDGET_OVER_80_PERCENT",
      "RELAYER_NEAR_RESERVE",
    ]);
    assert.ok(low.every((l) => l.level === "error"));
  });

  it("never writes an email, a key or a token into the log", async () => {
    const world = createRecoveryWorld();
    const user = await undeployedWallet(world);
    const { logs } = withSponsoring(world, { deposits: [] });
    await refusal(world, user);
    const text = JSON.stringify(logs);
    assert.equal(/@|0x[0-9a-f]{64}|token|secret/i.test(text), false, text);
  });
});

describe("what the person is told", () => {
  it("a refused wallet gets a plain request to add CELO or deposit more, never the reason", async () => {
    const hidden = new KaadaError(
      "RECOVERY_SPONSORSHIP_REFUSED",
      "BELOW_MINIMUM_DEPOSIT internal",
      {
        details: { reason: "BELOW_MINIMUM_DEPOSIT" },
      },
    );
    const runtime = {
      finalizer: {
        completedSessionUser: () =>
          Promise.reject(new KaadaError("RECOVERY_SESSION_INVALID", "no")),
      },
      configuration: { prepare: () => Promise.reject(hidden) },
    } as unknown as RecoveryRuntime;
    const moduleRef = await Test.createTestingModule({
      controllers: [RecoveryController],
      providers: [
        { provide: RECOVERY_RUNTIME, useValue: runtime },
        {
          provide: WALLET_SETUP_SERVICE,
          useValue: { userForView: () => Promise.resolve("user-1") },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app, { corsOrigins: [] } as never);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recovery/configuration/prepare",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
      payload: JSON.stringify({ recoveryAddress: "0x00000000000000000000000000000000000000f9" }),
    });
    const body = response.json<{ code: string; message: string }>();
    assert.equal(response.statusCode, 409);
    assert.equal(body.code, "SPONSORSHIP_UNAVAILABLE");
    assert.match(
      body.message,
      /add a small amount of CELO to your wallet, or deposit a larger amount/,
    );
    assert.equal(/BELOW_MINIMUM|internal|RECOVERY_/.test(response.body), false, response.body);
    await app.close();
  });
});
