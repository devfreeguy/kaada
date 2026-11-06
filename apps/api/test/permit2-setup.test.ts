import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PERMIT2,
  PERMIT2_APPROVE_SELECTOR,
  PERMIT2_MAX_AMOUNT,
  PERMIT2_MAX_EXPIRATION,
  createMoney,
  encodePermit2Approve,
  isTrustedPermit2Spender,
  permit2AllowanceCovers,
  permit2GrantAmount,
  permissionScopeKey,
} from "@kaada/domain";
import type {
  Asset,
  FirmExecutionCandidate,
  FirmQuote,
  PaymentAuthorization,
  UnsignedTransactions,
  Wallet,
} from "@kaada/domain";

import { buildExecutionPlan } from "../src/core/execution/plan-builder.js";
import { ALLOWED_SELECTORS, encodeApprove } from "../src/core/execution/steps.js";
import { defaultTokenPolicy } from "../src/core/execution/token-policy.js";

/*
 * A Universal Router swap needs TWO allowances in series, and only one of them fits the payment path.
 *
 *   1. ERC-20  owner -> Permit2   approve(spender, amount)                    0x095ea7b3   allowed
 *   2. Permit2 owner -> router    approve(token, spender, amount, expiration)  0x87517c45   NOT allowed
 *
 * The second is a one-time grant per token, so it is signed by the wallet's ROOT alongside the account
 * deployment and the permission install, and the payment path's selector allowlist is left exactly as
 * it was. These tests pin that split, and pin that the ERC-20 allowance stays the bounded one.
 */

const ROUTER = "0xe2023f3fa515cf070e07fd9d51c1d236e07843f4";
const CNGN_TOKEN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const WARS_TOKEN = "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d";
const TEXTILE_SETTLEMENT = "0x1111111111111111111111111111111111111111";
const WALLET_ADDRESS = "0xcfe279412b525a872ce32c5660141cde4cd0240f";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SELL = "11111111-1111-4111-8111-111111111111";
const BUY = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-11-06T12:00:00Z");
const INPUT = "500000000";
const OUTPUT = "602000000000000000000";
const GRANT = { wholeTokens: 1_000_000n, durationSeconds: 30n * 24n * 3600n };
/** The raw amount that policy means for cNGN, which has 6 decimals. */
const GRANT_RAW_CNGN = GRANT.wholeTokens * 10n ** 6n;

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

const sellAsset = asset(SELL, "cNGN", 6, CNGN_TOKEN);
const buyAsset = asset(BUY, "wARS", 18, WARS_TOKEN);

const wallet = {
  id: "wallet-1",
  userId: "user-1",
  address: WALLET_ADDRESS,
  chainId: 42220,
  status: "ACTIVE",
} as unknown as Wallet & { address: string };

const authorization = {
  id: "auth-1",
  userId: "user-1",
  walletId: "wallet-1",
  intentRevision: 1,
  routeId: "route-1",
  bounds: {
    mode: "EXACT_INPUT",
    authorizedInput: createMoney(INPUT, SELL),
    minimumOutput: createMoney("500000000000000000000", BUY),
  },
} as unknown as PaymentAuthorization;

const candidate = {
  userId: "user-1",
  walletId: "wallet-1",
  chainId: 42220,
  intentRevision: 1,
  operation: "SEND",
  recipient: { address: RECIPIENT },
  input: createMoney(INPUT, SELL),
  output: createMoney(OUTPUT, BUY),
  route: { assetPath: [SELL, BUY], providers: ["uniswap"] },
  intentId: "intent-1",
  authorizationId: "auth-1",
  provider: "uniswap",
  providerQuoteId: "q-1",
  executionReference: "q-1",
  expiresAt: new Date("2026-11-06T12:30:00Z"),
  routeSteps: [],
} as unknown as FirmExecutionCandidate;

/** A quote whose spender is Permit2 is how a provider says it routes through the Universal Router. */
const quote = (spender: string, swapTo: string): FirmQuote => ({
  id: "q-1",
  provider: spender === PERMIT2 ? "uniswap" : "textile",
  providerQuoteId: "q-1",
  chainId: 42220,
  input: createMoney(INPUT, SELL),
  output: createMoney(OUTPUT, BUY),
  expiresAt: new Date("2026-11-06T12:30:00Z"),
  spender,
  taker: WALLET_ADDRESS,
  executionReference: "q-1",
  indicative: false,
  ...(spender === TEXTILE_SETTLEMENT && { reactor: swapTo }),
});

const transactions = (swapTo: string, spender: string): UnsignedTransactions => ({
  approval: {
    to: CNGN_TOKEN,
    data: encodeApprove(spender, BigInt(INPUT)),
    value: "0",
    chainId: 42220,
  },
  swap: { to: swapTo, data: `0x3593564c${"00".repeat(32)}`, value: "0", chainId: 42220 },
});

function plan(
  overrides: {
    spender?: string;
    swapTo?: string;
    currentPermit2Allowance?: { amount: bigint; expiration: bigint };
    /** true to build the plan with NO grant configured at all. */
    noGrant?: boolean;
    deployed?: boolean;
    permissions?: Parameters<typeof buildExecutionPlan>[0]["permissions"];
  } = {},
) {
  const spender = overrides.spender ?? PERMIT2;
  const swapTo = overrides.swapTo ?? ROUTER;
  return buildExecutionPlan({
    candidate,
    quote: quote(spender, swapTo),
    transactions: transactions(swapTo, spender),
    claimTokenStored: false,
    authorization,
    wallet,
    sellAsset,
    buyAsset,
    tokenPolicy: defaultTokenPolicy,
    currentAllowance: 0n,
    ...(overrides.currentPermit2Allowance && {
      currentPermit2Allowance: overrides.currentPermit2Allowance,
    }),
    ...(overrides.noGrant === true ? {} : { permit2Grant: GRANT }),
    deployed: overrides.deployed ?? true,
    rootAvailable: true,
    infrastructure: { rpcConfigured: true, bundlerConfigured: true },
    permissions: overrides.permissions ?? [],
    now: NOW,
  });
}

describe("encoding a Permit2 approval", () => {
  it("builds the four-argument approve, which is NOT the ERC-20 one", () => {
    const data = encodePermit2Approve({
      token: CNGN_TOKEN,
      spender: ROUTER,
      amount: 1_000n,
      expiration: 1_800_000_000n,
    });
    assert.equal(data.slice(0, 10), PERMIT2_APPROVE_SELECTOR);
    assert.notEqual(data.slice(0, 10), "0x095ea7b3", "a different call from an ERC-20 approve");
    // 4 words of arguments, in Permit2's order: token, spender, amount, expiration.
    assert.equal(data.length, 10 + 4 * 64);
    assert.equal(`0x${data.slice(34, 74)}`, CNGN_TOKEN);
    assert.equal(`0x${data.slice(98, 138)}`, ROUTER);
    assert.equal(BigInt(`0x${data.slice(138, 202)}`), 1_000n);
    assert.equal(BigInt(`0x${data.slice(202, 266)}`), 1_800_000_000n);
  });

  /*
   * uint160 and uint48 wrap silently on overflow, and a wrapped figure grants something other than what
   * was asked for — possibly a far larger allowance, or an expiry already in the past.
   */
  it("refuses an amount or expiry that would not fit its type", () => {
    const base = { token: CNGN_TOKEN, spender: ROUTER, amount: 1n, expiration: 1n };
    assert.doesNotThrow(() =>
      encodePermit2Approve({
        ...base,
        amount: PERMIT2_MAX_AMOUNT,
        expiration: PERMIT2_MAX_EXPIRATION,
      }),
    );
    assert.throws(
      () => encodePermit2Approve({ ...base, amount: PERMIT2_MAX_AMOUNT + 1n }),
      /uint160/,
    );
    assert.throws(
      () => encodePermit2Approve({ ...base, expiration: PERMIT2_MAX_EXPIRATION + 1n }),
      /uint48/,
    );
    assert.throws(() => encodePermit2Approve({ ...base, amount: -1n }), /uint160/);
    assert.throws(() => encodePermit2Approve({ ...base, token: "0xnope" }), /token address/);
    assert.throws(() => encodePermit2Approve({ ...base, spender: "0x12" }), /spender address/);
  });

  it("treats an expired allowance as no allowance, however large", () => {
    const big = { amount: 10n ** 30n, expiration: BigInt(Math.floor(NOW.getTime() / 1000)) - 1n };
    assert.equal(permit2AllowanceCovers(big, 1n, NOW), false, "expired means none");
    const live = { amount: 1_000n, expiration: BigInt(Math.floor(NOW.getTime() / 1000)) + 60n };
    assert.equal(permit2AllowanceCovers(live, 1_000n, NOW), true);
    assert.equal(permit2AllowanceCovers(live, 1_001n, NOW), false, "too small");
  });
});

describe("the plan separates the two allowances", () => {
  it("asks the ROOT for the Permit2 grant and the SESSION KEY for the bounded ERC-20 one", () => {
    const built = plan();

    assert.equal(built.setupRequirements.length, 1);
    const setup = built.setupRequirements[0];
    assert.ok(setup);
    assert.equal(setup.purpose, "PERMIT2_ROUTER_ALLOWANCE");
    assert.equal(setup.signer, "ROOT", "never the restricted session key");
    assert.equal(setup.to, PERMIT2);
    assert.equal(setup.value, "0");
    assert.equal(setup.data.slice(0, 10), PERMIT2_APPROVE_SELECTOR);
    // Granted to the router that will actually pull the funds, for the token being sold.
    assert.equal(`0x${setup.data.slice(34, 74)}`, CNGN_TOKEN);
    assert.equal(`0x${setup.data.slice(98, 138)}`, ROUTER);
    assert.equal(BigInt(`0x${setup.data.slice(138, 202)}`), GRANT_RAW_CNGN);

    // The payment's own approval is unchanged: bounded, to Permit2, by the delegated signer.
    const approval = built.approvalRequirements[0];
    assert.ok(approval);
    assert.equal(approval.signer, "DELEGATED_SIGNER");
    assert.equal(approval.spender, PERMIT2);
    assert.equal(approval.requiredAllowance, INPUT, "exactly this swap's input, never the grant");
  });

  /*
   * This is the whole safety argument, as an assertion. The generous figure is the Permit2 one; the
   * ERC-20 one is bounded per payment, and Permit2 cannot move more than the ERC-20 allowance lets it.
   * Verified on chain: with 1,000 cNGN granted via Permit2 and 10 cNGN approved on the token, a 100
   * cNGN swap reverts with TRANSFER_FROM_FAILED.
   */
  it("keeps the bounded allowance bounded even though the grant is generous", () => {
    const built = plan();
    const approval = built.approvalRequirements[0];
    assert.ok(approval);
    assert.ok(GRANT_RAW_CNGN > BigInt(INPUT) * 1_000n, "the grant is deliberately generous");
    assert.equal(BigInt(approval.requiredAllowance), BigInt(INPUT), "the ERC-20 gate is not");
    assert.equal(built.blockers.includes("APPROVAL_UNLIMITED"), false);
  });

  it("does not widen the payment path's selector allowlist", () => {
    const built = plan();
    const setup = built.setupRequirements[0];
    assert.ok(setup);
    const selector = setup.data.slice(0, 10);
    assert.equal(
      (ALLOWED_SELECTORS as readonly string[]).includes(selector),
      false,
      "the Permit2 selector is NOT payable by a session key, and must stay that way",
    );
    assert.deepEqual([...ALLOWED_SELECTORS], ["0x095ea7b3", "0xa9059cbb"]);
  });

  /*
   * Without this the payment would reach the signer with no grant behind it, send the swap, and revert
   * on chain for want of a signature nobody had asked for.
   */
  it("needs the root even when the account exists and its permission is installed", () => {
    const built = plan({ deployed: true, permissions: coveringPermission() });
    assert.equal(built.permissionRequirement.state, "SATISFIED", "nothing to install");
    assert.equal(built.accountRequirements.deploymentRequired, false, "nothing to deploy");
    assert.equal(
      built.accountRequirements.rootSignatureRequired,
      true,
      "and still the root is needed, for the grant",
    );
  });

  function coveringPermission(): Parameters<typeof buildExecutionPlan>[0]["permissions"] {
    // The key a real installation records: the one of the scope this very payment needs.
    const scopeKey = permissionScopeKey(plan({ deployed: true }).permissionRequirement.scope);
    return [
      {
        id: "perm-1",
        scopeKey,
        walletId: "wallet-1",
        chainId: 42220,
        status: "ACTIVE",
        installedAt: NOW,
        providerPermissionId: "p-1",
        allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
        allowedContracts: [CNGN_TOKEN, ROUTER, WARS_TOKEN],
        allowedAssetIds: [SELL, BUY],
        perTransactionLimit: createMoney(INPUT, SELL),
        validFrom: NOW,
        expiresAt: new Date("2026-11-07T00:00:00Z"),
      },
    ] as unknown as Parameters<typeof buildExecutionPlan>[0]["permissions"];
  }

  it("asks for nothing once a live grant already covers the swap", () => {
    const built = plan({
      deployed: true,
      permissions: coveringPermission(),
      currentPermit2Allowance: {
        amount: GRANT_RAW_CNGN,
        expiration: BigInt(Math.floor(NOW.getTime() / 1000)) + 3600n,
      },
    });
    assert.deepEqual(
      built.setupRequirements,
      [],
      "the root is asked once per token, not per payment",
    );
    // Nothing to deploy, nothing to install, nothing to grant: so nothing for the root to sign either.
    assert.equal(built.accountRequirements.rootSignatureRequired, false);
  });

  it("does not reuse a permission pinned to a different scope, or one recorded without a key", () => {
    const grant = {
      amount: GRANT_RAW_CNGN,
      expiration: BigInt(Math.floor(NOW.getTime() / 1000)) + 3600n,
    };
    for (const scopeKey of ["a-different-recipient-or-amount", undefined]) {
      const permissions = coveringPermission().map((p) => ({ ...p, scopeKey })) as ReturnType<
        typeof coveringPermission
      >;
      const built = plan({ deployed: true, permissions, currentPermit2Allowance: grant });
      assert.equal(built.permissionRequirement.state, "INSTALLATION_REQUIRED");
      assert.equal(built.accountRequirements.rootSignatureRequired, true);
    }
  });

  it("asks again when the existing grant has expired", () => {
    const built = plan({
      currentPermit2Allowance: {
        amount: GRANT_RAW_CNGN,
        expiration: BigInt(Math.floor(NOW.getTime() / 1000)) - 1n,
      },
    });
    assert.equal(built.setupRequirements.length, 1, "an expired grant is no grant");
  });

  it("blocks rather than inventing a grant size it was not given", () => {
    const built = plan({ noGrant: true });
    assert.deepEqual(built.setupRequirements, []);
    assert.ok(built.blockers.includes("PERMIT2_GRANT_UNAVAILABLE"));
    assert.equal(built.status, "BLOCKED", "refused, never sent without the grant it needs");
  });

  it("adds nothing for a provider that does not route through Permit2", () => {
    // A Textile-shaped quote: the spender is the settlement contract, not Permit2.
    const built = plan({ spender: TEXTILE_SETTLEMENT, swapTo: TEXTILE_SETTLEMENT });
    assert.deepEqual(
      built.setupRequirements,
      [],
      "no grant, because there is no Permit2 in the path",
    );
    assert.equal(built.blockers.includes("PERMIT2_GRANT_UNAVAILABLE"), false);
    assert.equal(built.approvalRequirements[0]?.spender, TEXTILE_SETTLEMENT);
  });
});

/*
 * The grant is signed by the ROOT, a passkey tap the person cannot inspect, and it is made to an address that arrives in
 * the provider's API response. Reproduced on 2026-11-06 before this check existed: a response naming an attacker's address
 * as the swap target produced a READY plan whose root-signed grant gave that address a year-long allowance.
 */
describe("the root is never asked to grant a Permit2 allowance to an address Kaada has not trusted", () => {
  const ATTACKER = "0x000000000000000000000000000000000000dead";

  it("blocks the plan and asks the root for nothing", () => {
    const built = plan({ swapTo: ATTACKER });
    assert.ok(built.blockers.includes("PERMIT2_SPENDER_NOT_TRUSTED"));
    assert.equal(built.status, "BLOCKED");
    assert.deepEqual(
      built.setupRequirements,
      [],
      "no grant is ever composed for an untrusted address",
    );
  });

  it("blocks even when a live grant already exists, because the address also becomes the swap target", () => {
    const built = plan({
      swapTo: ATTACKER,
      currentPermit2Allowance: {
        amount: GRANT_RAW_CNGN,
        expiration: BigInt(Math.floor(NOW.getTime() / 1000)) + 3600n,
      },
    });
    assert.ok(built.blockers.includes("PERMIT2_SPENDER_NOT_TRUSTED"));
  });

  it("trusts the real Universal Router, in either letter case", () => {
    assert.equal(isTrustedPermit2Spender(42220, ROUTER), true);
    assert.equal(isTrustedPermit2Spender(42220, ROUTER.toUpperCase().replace("0X", "0x")), true);
    assert.equal(plan().blockers.includes("PERMIT2_SPENDER_NOT_TRUSTED"), false);
  });

  it("trusts nothing on a chain it has no router for", () => {
    assert.equal(isTrustedPermit2Spender(1, ROUTER), false);
    assert.equal(isTrustedPermit2Spender(42220, ATTACKER), false);
    assert.equal(
      isTrustedPermit2Spender(42220, "0x643770e279d5d0733f21d6dc03a8efbabf3255b4"),
      false,
      "an older router is not trusted by default",
    );
  });
});

describe("the grant is sized in whole tokens, whatever the token's decimals", () => {
  it("scales by decimals instead of using one raw number for every token", () => {
    assert.equal(permit2GrantAmount(GRANT, 6), 1_000_000n * 10n ** 6n);
    assert.equal(permit2GrantAmount(GRANT, 18), 1_000_000n * 10n ** 18n);
    assert.equal(
      permit2GrantAmount(GRANT, 18) / permit2GrantAmount(GRANT, 6),
      10n ** 12n,
      "the same whole-token size, not the same raw number",
    );
  });

  it("never exceeds what Permit2's uint160 can hold", () => {
    assert.equal(
      permit2GrantAmount({ wholeTokens: 10n ** 40n, durationSeconds: 1n }, 18),
      PERMIT2_MAX_AMOUNT,
    );
  });

  it("lasts weeks, not a year", () => {
    assert.ok(GRANT.durationSeconds <= 90n * 24n * 3600n);
  });
});
