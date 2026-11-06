import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SecretValue,
  claimTokenContext,
  createFirmQuoteProviderRegistry,
  createMoney,
} from "@kaada/domain";
import type {
  FirmQuoteProvider,
  FirmQuoteRequest,
  PaymentAuthorization,
  Provider,
} from "@kaada/domain";

import { FirmQuoteService } from "../src/core/execution/firm-quote-service.js";
import type { ExecutionUnitOfWork } from "../src/core/execution/ports.js";
import { createFirmStores } from "./support/firm-memory.js";

/*
 * The seam this file guards: ROUTING chooses the provider, EXECUTION must honour that choice.
 *
 * Before the registry existed, the firm-quote path held a single provider and the quote was labelled
 * with a "textile" string literal. A route planned on another provider was therefore requested from
 * Textile, for a pair Textile has no corridor for, and the person was refused AFTER authorizing the
 * payment. These tests exist so that cannot come back.
 */

const CNGN = "11111111-1111-4111-8111-111111111111";
const WARS = "22222222-2222-4222-8222-222222222222";

const asset = (id: string, symbol: string, decimals: number, contractAddress: string) => ({
  id,
  symbol,
  name: symbol,
  kind: "LOCAL_STABLECOIN" as const,
  decimals,
  chainId: 42220,
  contractAddress,
  isActive: true,
});

const sellAsset = asset(CNGN, "cNGN", 6, "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f");
const buyAsset = asset(WARS, "wARS", 18, "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d");

const providerRow = (slug: string): Provider => ({
  id: `row-${slug}`,
  slug,
  name: slug,
  type: "FX",
  isActive: true,
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const authorization = {
  id: "auth-1",
  userId: "user-1",
  walletId: "wallet-1",
  bounds: {
    mode: "EXACT_INPUT" as const,
    authorizedInput: createMoney("500000000", CNGN),
    minimumOutput: createMoney("500000000000000000000", WARS),
  },
} as unknown as PaymentAuthorization;

/** A firm provider that records what it was asked, so "who was called" is observable. */
class RecordingProvider implements FirmQuoteProvider {
  readonly requests: FirmQuoteRequest[] = [];
  constructor(
    readonly id: string,
    readonly issuesClaimToken: boolean,
    private readonly behaviour: "quote" | "quote-without-token" = "quote",
    /** null = no slots to hold, which is what an AMM declares. */
    readonly maxOutstanding: number | null = issuesClaimToken ? 4 : null,
  ) {}

  requestFirm(request: FirmQuoteRequest) {
    this.requests.push(request);
    const tx = { to: "0xrouter", data: "0xdeadbeef", value: "0", chainId: 42220 };
    return Promise.resolve({
      status: "QUOTED" as const,
      quote: {
        provider: this.id,
        providerQuoteId: `${this.id}-quote-1`,
        chainId: 42220,
        input: createMoney("500000000", CNGN),
        output: createMoney("600000000000000000000", WARS),
        expiresAt: new Date("2026-11-06T01:00:00Z"),
        spender: "0xspender",
        taker: "0xwallet",
        executionReference: `${this.id}-quote-1`,
        indicative: false as const,
      },
      transactions: { approval: tx, swap: tx },
      ...(this.behaviour === "quote" && this.issuesClaimToken
        ? { claimToken: new SecretValue("claim-secret-value") }
        : {}),
    });
  }
}

function world(providers: readonly FirmQuoteProvider[], rows: readonly Provider[]) {
  const stores = createFirmStores([authorization], []);
  const audit: { type: string }[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const repositories = {
    ...stores.repositories,
    providers: {
      findBySlug: (slug: string) => Promise.resolve(rows.find((r) => r.slug === slug) ?? null),
      findById: (id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
      listActive: () => Promise.resolve([...rows]),
      listCapabilities: () => Promise.resolve([]),
    },
    audit: {
      append: (entry: { type: string }) => {
        audit.push(entry);
        return Promise.resolve();
      },
    },
  };
  const uow = {
    read: repositories,
    transaction: (work: (tx: typeof repositories) => Promise<unknown>) => work(repositories),
  } as unknown as ExecutionUnitOfWork;

  const service = new FirmQuoteService({
    unitOfWork: uow,
    providers: createFirmQuoteProviderRegistry(providers),
    // A cipher stand-in: the point here is WHETHER a secret is stored, not how it is sealed.
    cipher: {
      encrypt: (plaintext: string) => ({ ciphertext: `sealed:${plaintext}`, keyVersion: 1 }),
      decrypt: (ciphertext: string) => ciphertext.replace(/^sealed:/, ""),
    },
    chain: {
      balances: {
        balancesOf: () => Promise.resolve(new Map([[CNGN, 10_000_000_000n]])),
      },
    },
    requestTimeoutMs: 75_000,
    now: () => new Date("2026-11-06T00:00:00Z"),
    log: (_level: string, event: string, fields?: Record<string, unknown>) =>
      void logs.push({ event, fields: fields ?? {} }),
  });

  const obtain = (providerSlug: string) =>
    service.obtain({
      authorization,
      providerSlug,
      takerAddress: "0xwallet",
      sellAsset,
      buyAsset,
    });

  return { obtain, stores, audit, logs };
}

describe("the firm-quote provider registry", () => {
  it("refuses two providers under the same slug", () => {
    const a = new RecordingProvider("uniswap", false);
    const b = new RecordingProvider("uniswap", false);
    assert.throws(() => createFirmQuoteProviderRegistry([a, b]), /same slug/);
  });

  it("resolves by slug and reports what is wired", () => {
    const registry = createFirmQuoteProviderRegistry([
      new RecordingProvider("uniswap", false),
      new RecordingProvider("textile", true),
    ]);
    assert.equal(registry.get("uniswap")?.id, "uniswap");
    assert.equal(registry.get("textile")?.id, "textile");
    assert.equal(registry.get("nobody"), undefined);
    assert.deepEqual(registry.slugs(), ["textile", "uniswap"]);
  });

  /*
   * The AAD is derived from the slug rather than written as a literal. For "textile" it must stay
   * byte-identical to the string that was hardcoded before, or every already-stored Textile claim
   * token stops decrypting. This is deliberately not a rename.
   */
  it("keeps Textile's encryption context byte-identical, so stored tokens still decrypt", () => {
    assert.equal(claimTokenContext("textile", "abc"), "textile-claim-token:abc");
    assert.equal(claimTokenContext("uniswap", "abc"), "uniswap-claim-token:abc");
  });
});

describe("the route's provider decides who is asked for a firm quote", () => {
  it("asks the provider the route was planned on, not whichever is wired first", async () => {
    const textile = new RecordingProvider("textile", true);
    const uniswap = new RecordingProvider("uniswap", false);
    const w = world([textile, uniswap], [providerRow("textile"), providerRow("uniswap")]);

    const outcome = await w.obtain("uniswap");
    assert.equal(outcome.status, "QUOTED");
    assert.equal(uniswap.requests.length, 1, "the planned provider was asked");
    assert.equal(textile.requests.length, 0, "the other provider was never called");
    if (outcome.status !== "QUOTED") return;
    assert.equal(outcome.attempt.providerQuoteId, "uniswap-quote-1");
    assert.equal(
      outcome.attempt.providerId,
      "row-uniswap",
      "the attempt records whose quote it is",
    );
  });

  it("refuses when the planned provider has no firm adapter, and calls nobody", async () => {
    const textile = new RecordingProvider("textile", true);
    const w = world([textile], [providerRow("textile"), providerRow("uniswap")]);

    const outcome = await w.obtain("uniswap");
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "PROVIDER_NOT_WIRED" });
    assert.equal(textile.requests.length, 0, "an unwired provider is never substituted");
    assert.equal(w.stores.attempts.length, 0, "no provider slot is spent on a refusal");
    assert.ok(
      w.logs.some((l) => l.event === "execution.firm_provider_not_wired"),
      "the gap is logged so it is diagnosable",
    );
  });
});

describe("a claim token is a provider trait, not a requirement of firm quoting", () => {
  it("stores one for a provider that issues one", async () => {
    const textile = new RecordingProvider("textile", true);
    const w = world([textile], [providerRow("textile")]);

    const outcome = await w.obtain("textile");
    assert.equal(outcome.status, "QUOTED");
    if (outcome.status !== "QUOTED") return;
    assert.ok(outcome.attempt.claimSecretId, "the attempt points at the stored secret");
    assert.equal(w.stores.secrets.length, 1);
    assert.equal(w.stores.secrets[0]?.purpose, "TEXTILE_CLAIM_TOKEN");
    // Sealed, never the token itself.
    assert.equal(w.stores.secrets[0]?.ciphertext, "sealed:claim-secret-value");
  });

  /*
   * An AMM reserves nothing: the price is a reading of a pool, the protection is the slippage bound and
   * deadline inside the swap calldata, and there is no order to claim. Requiring a token here used to
   * mean the runner threw while settling, AFTER the swap had already confirmed on chain.
   */
  it("stores none for a provider that issues none, and records no secret id", async () => {
    const uniswap = new RecordingProvider("uniswap", false);
    const w = world([uniswap], [providerRow("uniswap")]);

    const outcome = await w.obtain("uniswap");
    assert.equal(outcome.status, "QUOTED");
    if (outcome.status !== "QUOTED") return;
    assert.equal(outcome.attempt.claimSecretId, undefined);
    assert.deepEqual(w.stores.secrets, [], "nothing is sealed when there is nothing to seal");
    assert.ok(outcome.attempt.providerQuoteId, "the quote itself is still recorded");
  });

  it("treats a declared-but-missing token as a fault, before anything is stored", async () => {
    // Declares that it issues one, then does not: a provider defect, caught here rather than later.
    const broken = new RecordingProvider("textile", true, "quote-without-token");
    const w = world([broken], [providerRow("textile")]);

    await assert.rejects(w.obtain("textile"), /declares a claim token but returned none/);
    assert.deepEqual(w.stores.secrets, []);
  });
});

/*
 * The outstanding-quote cap belongs to the provider, not to a deployment setting.
 *
 * Textile reserves funds against one of four slots per key and answers 429 past that, so counting
 * locally avoids an avoidable rejection. Uniswap reserves nothing: there is no slot and no cap. Applying
 * Textile's figure to it would refuse a fifth quote inside the deadline window with
 * PROVIDER_CAPACITY_REACHED, naming a capacity limit the provider does not have.
 */
describe("the outstanding-quote cap is a provider trait", () => {
  /** Other people's live quotes at this provider, each holding one slot. */
  const hold = (w: ReturnType<typeof world>, providerRowId: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      w.stores.attempts.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        paymentAuthorizationId: `someone-else-${i}`,
        userId: `someone-else-${i}`,
        walletId: "wallet-x",
        providerId: providerRowId,
        status: "REQUESTING",
        idempotencyKey: `held-${i}`,
        amountMode: "EXACT_INPUT",
        exactAmount: createMoney("1", CNGN),
        takerAddress: "0xother",
        createdAt: new Date("2026-11-06T00:00:00Z"),
        updatedAt: new Date("2026-11-06T00:00:00Z"),
      });
    }
  };

  it("refuses at the provider's own cap, and never calls the provider", async () => {
    const textile = new RecordingProvider("textile", true, "quote", 2);
    const w = world([textile], [providerRow("textile")]);
    hold(w, "row-textile", 2);

    const outcome = await w.obtain("textile");
    assert.deepEqual(outcome, { status: "PROVIDER_CAPACITY_REACHED" });
    assert.equal(textile.requests.length, 0, "no request was spent on a refusal");
  });

  it("still quotes one slot below the cap", async () => {
    const textile = new RecordingProvider("textile", true, "quote", 2);
    const w = world([textile], [providerRow("textile")]);
    hold(w, "row-textile", 1);

    assert.equal((await w.obtain("textile")).status, "QUOTED");
    assert.equal(textile.requests.length, 1);
  });

  it("counts a provider's slots on their own, not another provider's", async () => {
    const textile = new RecordingProvider("textile", true, "quote", 1);
    const w = world([textile], [providerRow("textile"), providerRow("uniswap")]);
    hold(w, "row-uniswap", 5);

    assert.equal(
      (await w.obtain("textile")).status,
      "QUOTED",
      "five held quotes at ANOTHER provider are not Textile's problem",
    );
  });

  it("never refuses for capacity when the provider holds no slots, however many rows exist", async () => {
    const uniswap = new RecordingProvider("uniswap", false);
    assert.equal(uniswap.maxOutstanding, null, "an AMM declares no cap");
    const w = world([uniswap], [providerRow("uniswap")]);
    hold(w, "row-uniswap", 25);

    const outcome = await w.obtain("uniswap");
    assert.equal(outcome.status, "QUOTED");
    assert.equal(uniswap.requests.length, 1);
  });

  it("gives the two providers different caps, which is the whole point", () => {
    assert.equal(new RecordingProvider("textile", true).maxOutstanding, 4);
    assert.equal(new RecordingProvider("uniswap", false).maxOutstanding, null);
  });
});
