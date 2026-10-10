import { bpsOf, createMoney, expressFixedAmount } from "@kaada/domain";
import type {
  AssetRegistry,
  Money,
  PlannedRoute,
  RoutingCandidateSet,
  RoutingRequest,
} from "@kaada/domain";

import type { AgentResponse } from "../responses/agent-response.js";
import { formatAmount } from "./format.js";

/**
 * What routing needs from the wallet, and nothing more. Implemented over WalletService and the
 * balance reader; routing never sees a wallet record, a provider or a signer.
 */
export interface WalletFundingPort {
  /** The address of the user's ACTIVE wallet, or null when they have none (not set up yet). */
  activeAddress(userId: string): Promise<string | null>;
  /** Fresh on-chain balances, smallest units, by asset id. Throws when the chain cannot be read. */
  balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>>;
}

/**
 * Where a funding candidate stands.
 * - NO_BALANCE:               the wallet holds none of it.
 * - POTENTIALLY_FUNDED:       it holds some, but the amount needed is not known until a quote exists
 *                             (EXACT_OUTPUT). No claim of sufficiency is made.
 * - FUNDED:                   it holds at least the exact amount that will be spent (EXACT_INPUT).
 * - INSUFFICIENT:             EXACT_INPUT, and it holds less than the amount.
 * - INSUFFICIENT_AFTER_QUOTE: priced, and the most that could be spent exceeds the balance.
 */
export type FundingStatus =
  "NO_BALANCE" | "POTENTIALLY_FUNDED" | "FUNDED" | "INSUFFICIENT" | "INSUFFICIENT_AFTER_QUOTE";

export type FundingFilter =
  | { status: "SETUP_REQUIRED" }
  | { status: "OK"; set: RoutingCandidateSet; address: string; balances: Map<string, bigint> }
  | { status: "REJECTED"; response: AgentResponse };

export type FundingPick =
  { status: "OK"; route: PlannedRoute } | { status: "REJECTED"; response: AgentResponse };

const SETUP_TEXT = "You need to set up your Kaada wallet first.";

/** The most a priced route can take from the wallet: slippage only ever raises what is spent. */
export function maxSpend(
  route: { input: Money; slippageBps: number },
  mode: RoutingRequest["amountMode"],
): Money {
  if (mode === "EXACT_INPUT") return route.input;
  const spend = BigInt(route.input.amount);
  return createMoney(
    (spend + bpsOf(spend, BigInt(route.slippageBps), "UP")).toString(),
    route.input.assetId,
  );
}

/**
 * Decides which funding assets a payment can still use, from what the wallet actually holds. It
 * sits between candidate discovery and route planning, so the planner never sees a wallet and
 * unaffordable candidates are never priced (no wasted provider calls).
 *
 * Rules, all deterministic:
 *  - An explicit source ("use USDT") is never swapped for another asset.
 *  - Without one, every funded candidate stays; pricing, not balance size, picks among them.
 *  - EXACT_INPUT is affordable only when the balance covers the exact input.
 *  - EXACT_OUTPUT is checked again after pricing, against the most that could be spent.
 *  - "No liquidity" is a routing failure and never reaches this class.
 *
 * Nothing here signs, authorizes or requests a firm quote. Balances are read fresh each time and
 * are never stored.
 */
export class WalletFundingResolver {
  constructor(
    private readonly deps: {
      wallet: WalletFundingPort;
      assets: Pick<AssetRegistry, "getById">;
    },
  ) {}

  /** Wallet-required check for a payment, before anything else is done. */
  async requireWallet(userId: string): Promise<string | null> {
    return this.deps.wallet.activeAddress(userId);
  }

  setupRequired(): AgentResponse {
    return { type: "ERROR", code: "WALLET_SETUP_REQUIRED", text: SETUP_TEXT };
  }

  /** Keeps only the candidate pairs whose funding asset the wallet can plausibly pay with. */
  async filter(
    request: RoutingRequest,
    set: RoutingCandidateSet,
    address: string,
  ): Promise<FundingFilter> {
    const sourceIds = [...new Set(set.pairs.map((pair) => pair.sourceAssetId))];
    const balances = await this.deps.wallet.balancesOf(address, sourceIds);
    const amountAsset = await this.deps.assets.getById(request.amount.assetId);

    const status = new Map<string, FundingStatus>();
    const needed = new Map<string, Money>();
    for (const id of sourceIds) {
      const balance = balances.get(id) ?? 0n;
      if (balance === 0n) {
        status.set(id, "NO_BALANCE");
        continue;
      }
      if (request.amountMode === "EXACT_OUTPUT") {
        status.set(id, "POTENTIALLY_FUNDED");
        continue;
      }
      const asset = await this.deps.assets.getById(id);
      const fixed =
        asset && amountAsset ? expressFixedAmount(request, amountAsset, asset) : undefined;
      if (!fixed) {
        // The planner could not express the amount in this token either; it cannot be used.
        status.set(id, "INSUFFICIENT");
        continue;
      }
      needed.set(id, fixed);
      status.set(id, balance >= BigInt(fixed.amount) ? "FUNDED" : "INSUFFICIENT");
    }

    const usable = new Set(
      sourceIds.filter(
        (id) => status.get(id) === "FUNDED" || status.get(id) === "POTENTIALLY_FUNDED",
      ),
    );
    if (usable.size > 0) {
      return {
        status: "OK",
        address,
        balances,
        set: {
          ...set,
          pairs: set.pairs.filter((pair) => usable.has(pair.sourceAssetId)),
          source: {
            ...set.source,
            candidates: set.source.candidates.filter((candidate) => usable.has(candidate.assetId)),
          },
        },
      };
    }

    return {
      status: "REJECTED",
      response: await this.rejection(set, sourceIds, status, balances, needed),
    };
  }

  /**
   * After pricing: the best-ranked route the wallet can actually afford. Routes arrive ranked, so
   * the first affordable one is the best affordable one; a funded alternative is used when the best
   * route's asset falls short. If none is affordable the failure is a balance failure, because
   * prices existed.
   */
  async pick(
    request: RoutingRequest,
    routes: readonly PlannedRoute[],
    balances: ReadonlyMap<string, bigint>,
  ): Promise<FundingPick> {
    for (const route of routes) {
      const spend = BigInt(maxSpend(route, request.amountMode).amount);
      if ((balances.get(route.sourceAssetId) ?? 0n) >= spend) return { status: "OK", route };
    }
    const [best] = routes;
    if (!best) {
      return {
        status: "REJECTED",
        response: {
          type: "ERROR",
          code: "NO_ROUTE",
          text: "I couldn't find a route for that.",
        },
      };
    }
    const asset = await this.deps.assets.getById(best.sourceAssetId);
    const symbol = asset?.symbol ?? "that asset";
    const spend = maxSpend(best, request.amountMode);
    const have = balances.get(best.sourceAssetId) ?? 0n;
    const decimals = asset?.decimals ?? 0;
    return {
      status: "REJECTED",
      response: {
        type: "ERROR",
        code: "INSUFFICIENT_BALANCE",
        text: `This would take up to ${formatAmount(spend.amount, decimals)} ${symbol}, but your wallet has ${formatAmount(have.toString(), decimals)} ${symbol}.`,
      },
    };
  }

  /**
   * A route stored earlier for this exact revision is reused while its prices live, but the wallet
   * may have changed since: it must still cover the most that route can take.
   */
  async confirmStored(
    request: RoutingRequest,
    route: { input: Money; slippageBps: number },
    address: string,
  ): Promise<AgentResponse | undefined> {
    const balances = await this.deps.wallet.balancesOf(address, [route.input.assetId]);
    const spend = BigInt(maxSpend(route, request.amountMode).amount);
    if ((balances.get(route.input.assetId) ?? 0n) >= spend) return undefined;
    const asset = await this.deps.assets.getById(route.input.assetId);
    return {
      type: "ERROR",
      code: "INSUFFICIENT_BALANCE",
      text: `You don't currently have enough ${asset?.symbol ?? "funds"} for this payment.`,
    };
  }

  private async rejection(
    set: RoutingCandidateSet,
    sourceIds: string[],
    status: ReadonlyMap<string, FundingStatus>,
    balances: ReadonlyMap<string, bigint>,
    needed: ReadonlyMap<string, Money>,
  ): Promise<AgentResponse> {
    const explicit = set.explicitSourceAssetId;
    const allEmpty = sourceIds.every((id) => status.get(id) === "NO_BALANCE");

    if (explicit !== null) {
      const asset = await this.deps.assets.getById(explicit);
      const symbol = asset?.symbol ?? "that asset";
      const required = needed.get(explicit);
      const detail =
        required && asset
          ? ` You need ${formatAmount(required.amount, asset.decimals)} ${symbol} and have ${formatAmount((balances.get(explicit) ?? 0n).toString(), asset.decimals)}.`
          : "";
      return {
        type: "ERROR",
        code: "INSUFFICIENT_BALANCE",
        text: `You don't currently have enough ${symbol} for this payment.${detail}`,
      };
    }
    if (allEmpty) {
      return {
        type: "ERROR",
        code: "WALLET_NEEDS_FUNDING",
        text: "Your Kaada wallet doesn't have a supported asset to fund this payment yet.",
      };
    }
    return {
      type: "ERROR",
      code: "INSUFFICIENT_BALANCE",
      text: "You don't currently have enough in your wallet for this payment.",
    };
  }
}
