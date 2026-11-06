import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PERMIT2, createMoney, permissionScopeKey } from "@kaada/domain";
import type {
  Asset,
  FirmExecutionCandidate,
  FirmQuote,
  PaymentAuthorization,
  StandingConversionPolicy,
  UnsignedTransactions,
  Wallet,
} from "@kaada/domain";

import { buildExecutionPlan } from "../src/core/execution/plan-builder.js";
import { encodeApprove } from "../src/core/execution/steps.js";
import { defaultTokenPolicy } from "../src/core/execution/token-policy.js";

/*
 * A conversion between a person's OWN currencies pays its output back to the wallet it came from, so nothing can leave
 * through it. That lets its permission be installed once, pinned to ceilings, and reused for every later conversion of
 * the same pair. A SEND keeps its exact, short-lived permission. These tests pin both halves.
 */

const ROUTER = "0xe2023f3fa515cf070e07fd9d51c1d236e07843f4";
const CNGN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const WARS = "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d";
const WALLET = "0xcfe279412b525a872ce32c5660141cde4cd0240f";
const OTHER = "0x2222222222222222222222222222222222222222";
const SELL = "11111111-1111-4111-8111-111111111111";
const BUY = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-06T12:00:00Z");
const POLICY: StandingConversionPolicy = { wholeTokens: 1_000_000n, windowMs: 30 * 24 * 3600_000 };
const WINDOW_FAR = 60 * 24 * 3600_000;

const asset = (id: string, symbol: string, decimals: number, contractAddress: string) =>
  ({
    id,
    symbol,
    name: symbol,
    kind: "LOCAL_STABLECOIN",
    decimals,
    chainId: 42220,
    contractAddress,
    isActive: true,
  }) as Asset & { contractAddress: string };
const sell = asset(SELL, "cNGN", 6, CNGN);
const buy = asset(BUY, "wARS", 18, WARS);
const wallet = {
  id: "wallet-1",
  userId: "user-1",
  address: WALLET,
  chainId: 42220,
  status: "ACTIVE",
} as unknown as Wallet & { address: string };

function plan(options: {
  operation: "SEND" | "CONVERT";
  input: string;
  output: string;
  standing?: StandingConversionPolicy | undefined;
  permissions?: Parameters<typeof buildExecutionPlan>[0]["permissions"] | unknown[];
}) {
  const authorization = {
    id: "auth-1",
    userId: "user-1",
    walletId: "wallet-1",
    intentRevision: 1,
    routeId: "route-1",
    bounds: {
      mode: "EXACT_INPUT",
      authorizedInput: createMoney(options.input, SELL),
      minimumOutput: createMoney("1", BUY),
    },
  } as unknown as PaymentAuthorization;
  const candidate = {
    userId: "user-1",
    walletId: "wallet-1",
    chainId: 42220,
    intentRevision: 1,
    operation: options.operation,
    recipient: options.operation === "SEND" ? { address: OTHER } : {},
    input: createMoney(options.input, SELL),
    output: createMoney(options.output, BUY),
    route: { assetPath: [SELL, BUY], providers: ["uniswap"] },
    intentId: "intent-1",
    authorizationId: "auth-1",
    provider: "uniswap",
    providerQuoteId: "q-1",
    executionReference: "q-1",
    expiresAt: new Date("2026-11-06T12:03:00Z"),
    routeSteps: [],
  } as unknown as FirmExecutionCandidate;
  const quote: FirmQuote = {
    id: "q-1",
    provider: "uniswap",
    providerQuoteId: "q-1",
    chainId: 42220,
    input: createMoney(options.input, SELL),
    output: createMoney(options.output, BUY),
    expiresAt: new Date("2026-11-06T12:03:00Z"),
    spender: PERMIT2,
    taker: WALLET,
    executionReference: "q-1",
    indicative: false,
  };
  const transactions: UnsignedTransactions = {
    approval: {
      to: CNGN,
      data: encodeApprove(PERMIT2, BigInt(options.input)),
      value: "0",
      chainId: 42220,
    },
    swap: { to: ROUTER, data: `0x3593564c${"00".repeat(32)}`, value: "0", chainId: 42220 },
  };
  return buildExecutionPlan({
    candidate,
    quote,
    transactions,
    claimTokenStored: false,
    authorization,
    wallet,
    sellAsset: sell,
    buyAsset: buy,
    tokenPolicy: defaultTokenPolicy,
    currentAllowance: 0n,
    currentPermit2Allowance: {
      amount: 10n ** 12n,
      expiration: BigInt(Math.floor(NOW.getTime() / 1000)) + 3600n,
    },
    permit2Grant: { wholeTokens: 1_000_000n, durationSeconds: 30n * 24n * 3600n },
    ...(options.standing && { standingConversion: options.standing }),
    deployed: true,
    rootAvailable: true,
    infrastructure: { rpcConfigured: true, bundlerConfigured: true },
    permissions: (options.permissions ?? []) as Parameters<
      typeof buildExecutionPlan
    >[0]["permissions"],
    now: NOW,
  });
}

describe("a conversion between a person's own currencies", () => {
  it("is pinned to ceilings, so two different amounts need the SAME permission", () => {
    const small = plan({
      operation: "CONVERT",
      input: "500000000",
      output: "602000000000000000000",
      standing: POLICY,
    });
    const large = plan({
      operation: "CONVERT",
      input: "900000000",
      output: "1100000000000000000000",
      standing: POLICY,
    });
    assert.equal(small.status, "READY");
    assert.equal(
      permissionScopeKey(small.permissionRequirement.scope),
      permissionScopeKey(large.permissionRequirement.scope),
      "an identical scope is what lets the second conversion reuse the first one's permission",
    );
  });

  it("pins the approval to Permit2 and the payout to the wallet itself, with whole-token ceilings", () => {
    const { scope } = plan({
      operation: "CONVERT",
      input: "500000000",
      output: "602000000000000000000",
      standing: POLICY,
    }).permissionRequirement;
    assert.equal(scope.approval?.spender, PERMIT2);
    assert.equal(scope.approval?.limit.amount, (1_000_000n * 10n ** 6n).toString());
    assert.equal(scope.payout?.recipient, WALLET, "nothing can be paid to anyone else");
    assert.equal(scope.payout?.limit.amount, (1_000_000n * 10n ** 18n).toString());
    assert.equal(scope.perTransactionLimit.amount, (1_000_000n * 10n ** 6n).toString());
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), POLICY.windowMs);
  });

  it("keeps the exact, short-lived scope when no standing policy is configured", () => {
    const { scope } = plan({
      operation: "CONVERT",
      input: "500000000",
      output: "602000000000000000000",
    }).permissionRequirement;
    assert.equal(scope.approval?.limit.amount, "500000000");
    assert.equal(scope.payout?.limit.amount, "602000000000000000000");
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), 15 * 60 * 1000);
  });

  it("falls back to the exact scope for a payment larger than the ceiling", () => {
    const { scope } = plan({
      operation: "CONVERT",
      input: (2_000_000n * 10n ** 6n).toString(),
      output: "602000000000000000000",
      standing: POLICY,
    }).permissionRequirement;
    assert.equal(scope.approval?.limit.amount, (2_000_000n * 10n ** 6n).toString());
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), 15 * 60 * 1000);
  });
});

describe("the second conversion of the same pair", () => {
  it("is covered by the first one's permission and asks for nothing, whatever its amount", () => {
    const first = plan({
      operation: "CONVERT",
      input: "500000000",
      output: "602000000000000000000",
      standing: POLICY,
    }).permissionRequirement.scope;
    const installed = {
      id: "perm-1",
      walletId: "wallet-1",
      chainId: 42220,
      status: "ACTIVE",
      installedAt: NOW,
      providerPermissionId: "p-1",
      scopeKey: permissionScopeKey(first),
      allowedOperations: first.allowedOperations,
      allowedContracts: first.allowedContracts,
      allowedAssetIds: first.allowedAssetIds,
      perTransactionLimit: first.perTransactionLimit,
      validFrom: first.validFrom,
      expiresAt: first.expiresAt,
    };
    const second = plan({
      operation: "CONVERT",
      input: "123456789",
      output: "150000000000000000000",
      standing: POLICY,
      permissions: [installed],
    });
    assert.equal(second.permissionRequirement.state, "SATISFIED");
    assert.equal(second.accountRequirements.rootSignatureRequired, false, "no passkey, no tap");
  });

  it("is NOT covered by an exact permission left over from a payment to someone else", () => {
    const exact = plan({
      operation: "SEND",
      input: "500000000",
      output: "602000000000000000000",
    }).permissionRequirement.scope;
    const second = plan({
      operation: "CONVERT",
      input: "500000000",
      output: "602000000000000000000",
      standing: POLICY,
      permissions: [
        {
          id: "perm-2",
          walletId: "wallet-1",
          chainId: 42220,
          status: "ACTIVE",
          installedAt: NOW,
          providerPermissionId: "p-2",
          scopeKey: permissionScopeKey(exact),
          allowedOperations: exact.allowedOperations,
          allowedContracts: exact.allowedContracts,
          allowedAssetIds: exact.allowedAssetIds,
          perTransactionLimit: exact.perTransactionLimit,
          validFrom: exact.validFrom,
          expiresAt: new Date(NOW.getTime() + WINDOW_FAR),
        },
      ],
    });
    assert.equal(second.permissionRequirement.state, "INSTALLATION_REQUIRED");
  });
});

describe("a SEND to someone else", () => {
  it("never gets the standing permission, even when the policy is configured", () => {
    const { scope } = plan({
      operation: "SEND",
      input: "500000000",
      output: "602000000000000000000",
      standing: POLICY,
    }).permissionRequirement;
    assert.equal(scope.approval?.limit.amount, "500000000", "exact input");
    assert.equal(scope.payout?.limit.amount, "602000000000000000000", "exact output");
    assert.equal(scope.payout?.recipient, OTHER);
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), 15 * 60 * 1000);
  });
});
