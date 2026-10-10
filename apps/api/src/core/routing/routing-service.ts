import {
  aggregateFees,
  assertRouteUsable,
  createId,
  isKaadaError,
  validatePaymentRoute,
} from "@kaada/domain";
import type {
  Asset,
  AssetRegistry,
  Money,
  PaymentRoute,
  PlannedRoute,
  Quote,
  RoutePlanner,
  RoutingCandidateResolver,
  RoutingRequest,
} from "@kaada/domain";

import type { AgentLog, AgentRepositories } from "../agent/ports.js";
import { formatAmount } from "./format.js";
import { maxSpend, minReceive } from "../authorization/bounds.js";
import type { WalletFundingResolver } from "./funding-resolver.js";
import { noopLog } from "../agent/ports.js";
import type {
  AgentResponse,
  AuthorizationRequiredResponse,
  MoneyView,
  PaymentReadyResponse,
  QuoteResultResponse,
  RouteSummary,
} from "../responses/agent-response.js";

/**
 * What planning a RoutingRequest produced, before anything is written.
 * - PLANNED: a fresh best route (plus the candidate set it came from).
 * - REUSED:  a route already stored for this exact revision, with every quote still valid.
 * - FAILED:  nothing usable, with the response to give the user.
 */
export type RoutingOutcome =
  | { status: "PLANNED"; request: RoutingRequest; route: PlannedRoute; walletId?: string }
  | {
      status: "REUSED";
      request: RoutingRequest;
      route: PaymentRoute;
      quotes: Quote[];
      walletId?: string;
    }
  | { status: "FAILED"; request: RoutingRequest; response: AgentResponse };

export interface RoutingServiceDeps {
  candidates: RoutingCandidateResolver;
  planner: RoutePlanner;
  assets: AssetRegistry;
  /** Reads for route reuse; a transaction is not needed. */
  read: Pick<AgentRepositories, "routes" | "quotes">;
  /**
   * Balance-aware funding for PAYMENTS (set when a wallet provider is configured). When absent,
   * payments are routed without any wallet check, exactly as before wallets existed. QUOTEs never
   * use it.
   */
  funding?: WalletFundingResolver;
  /**
   * Payment authorization. When present, a priced PAYMENT for a user with a wallet is answered with
   * AUTHORIZATION_REQUIRED (a session reference, never a link) instead of PAYMENT_READY, and a replaced
   * route retires whatever was built on the old one.
   */
  authorization?: AuthorizationGate;
  now?: () => Date;
  log?: AgentLog;
}

export { formatAmount };

/** What routing needs from payment authorization, and nothing more. */
export interface AuthorizationGate {
  begin(
    repositories: AgentRepositories,
    input: {
      userId: string;
      walletId: string;
      intentId: string;
      intentRevision: number;
      routeId: string;
    },
  ): Promise<{ sessionId: string; expiresAt: Date }>;
  routeReplaced(
    repositories: AgentRepositories,
    intentId: string,
    keep: { revision: number; routeId: string },
  ): Promise<void>;
}

/** Whole seconds until `at`, never negative. Integer arithmetic only. */
function secondsUntil(at: Date, now: Date): number {
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return 0;
  const rounded = ms + 999;
  return (rounded - (rounded % 1000)) / 1000;
}

/**
 * Turns a RoutingRequest into a priced route and, separately, writes it. Application orchestration
 * only: asset discovery, route search, pricing, validation and ranking live in the domain
 * (RoutingCandidateResolver, RoutePlanner); the agent calls this after it has an unambiguous
 * request. Pricing happens in `plan` (no transaction); `commit` is the short write.
 *
 * Nothing here authorizes or executes a payment, and nothing assumes the user holds any asset.
 */
export class RoutingService {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: RoutingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async plan(request: RoutingRequest): Promise<RoutingOutcome> {
    const now = this.now();

    // Only a payment spends the user's funds, so only a payment needs a wallet. A quote is a price
    // question and works without one.
    const funding = request.purpose === "PAYMENT" ? this.deps.funding : undefined;
    let wallet: { id: string; address: string } | null = null;
    if (funding) {
      try {
        wallet = await funding.requireWallet(request.userId);
      } catch (error) {
        return this.fundingUnavailable(request, error);
      }
      if (wallet === null) {
        return { status: "FAILED", request, response: funding.setupRequired() };
      }
    }

    // Reuse only a stored route for THIS revision whose quotes are all still valid.
    const reused = await this.findReusable(request, now);
    if (reused) {
      if (funding && wallet !== null) {
        try {
          const slippageBps = reused.quotes.reduce(
            (sum, quote) => sum + (quote.slippageBps ?? 0),
            0,
          );
          const short = await funding.confirmStored(
            request,
            { input: reused.route.input, slippageBps },
            wallet.address,
          );
          if (short) return { status: "FAILED", request, response: short };
        } catch (error) {
          return this.fundingUnavailable(request, error);
        }
      }
      return { status: "REUSED", request, ...reused, ...(wallet && { walletId: wallet.id }) };
    }

    const discovery = await this.deps.candidates.resolve(request);
    if (discovery.status === "UNSUPPORTED") {
      return {
        status: "FAILED",
        request,
        response: { type: "ERROR", code: "ROUTING_UNSUPPORTED", text: discovery.text },
      };
    }

    // Balance-aware candidates: unaffordable funding assets are dropped BEFORE any provider is asked
    // for a price, and an explicit asset is never swapped for another.
    let candidates = discovery.set;
    let balances: ReadonlyMap<string, bigint> | undefined;
    if (funding && wallet !== null) {
      try {
        const filtered = await funding.filter(request, candidates, wallet.address);
        if (filtered.status === "REJECTED") {
          return { status: "FAILED", request, response: filtered.response };
        }
        if (filtered.status === "SETUP_REQUIRED") {
          return { status: "FAILED", request, response: funding.setupRequired() };
        }
        candidates = filtered.set;
        balances = filtered.balances;
      } catch (error) {
        return this.fundingUnavailable(request, error);
      }
    }

    const result = await this.deps.planner.plan(request, candidates);
    this.log("info", "routing.planned", {
      intentId: request.intentId,
      revision: request.intentRevision,
      status: result.status,
      failures: result.failures.length,
    });
    switch (result.status) {
      case "SUCCESS": {
        if (funding && balances) {
          // Priced routes arrive best first; take the best one the wallet can afford.
          const picked = await funding.pick(request, result.routes, balances);
          if (picked.status === "REJECTED") {
            return { status: "FAILED", request, response: picked.response };
          }
          return {
            status: "PLANNED",
            request,
            route: picked.route,
            ...(wallet && { walletId: wallet.id }),
          };
        }
        const [best] = result.routes;
        if (!best) return failed(request, "NO_ROUTE", "I couldn't find a route for that.");
        return { status: "PLANNED", request, route: best, ...(wallet && { walletId: wallet.id }) };
      }
      case "NO_ROUTE":
        return failed(request, "NO_ROUTE", "I couldn't find a route for that right now.");
      case "PROVIDER_UNAVAILABLE":
        return failed(
          request,
          "ROUTING_UNAVAILABLE",
          "I can't reach a pricing provider right now. Please try again in a moment.",
        );
      case "QUOTE_FAILED":
        return failed(
          request,
          "ROUTING_UNAVAILABLE",
          "I couldn't get a usable price right now. Please try again in a moment.",
        );
    }
  }

  /** The wallet or the chain could not be read. Not a balance verdict, so nothing is claimed. */
  private fundingUnavailable(request: RoutingRequest, error: unknown): RoutingOutcome {
    this.log("error", "routing.funding_unavailable", {
      intentId: request.intentId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return failed(
      request,
      "ROUTING_UNAVAILABLE",
      "I couldn't check your wallet balance right now. Please try again in a moment.",
    );
  }

  /**
   * Writes the planned route (its quotes first, then the route and steps) in the caller's
   * transaction, bound to the intent revision, and retires older routes. If the intent has moved on
   * since planning, nothing is written and a stale error is returned.
   */
  async commit(repositories: AgentRepositories, outcome: RoutingOutcome): Promise<AgentResponse> {
    if (outcome.status === "FAILED") return outcome.response;
    const { request } = outcome;

    const intent = await repositories.intents.findById(request.intentId);
    if (!intent || intent.revision !== request.intentRevision || intent.status !== "RESOLVED") {
      return {
        type: "ERROR",
        code: "ROUTING_STALE",
        text: "That request changed while I was pricing it, so I discarded the prices. Please check the latest details.",
      };
    }

    let route: PaymentRoute;
    let quotes: Quote[];
    if (outcome.status === "REUSED") {
      ({ route, quotes } = outcome);
    } else {
      ({ route, quotes } = await this.persist(repositories, request, outcome.route));
    }
    return this.respond(request, route, quotes, {
      repositories,
      ...(outcome.walletId && { walletId: outcome.walletId }),
    });
  }

  private async persist(
    repositories: AgentRepositories,
    request: RoutingRequest,
    planned: PlannedRoute,
  ): Promise<{ route: PaymentRoute; quotes: Quote[] }> {
    const quotes: Quote[] = [];
    const providerIds = new Map<string, string>();
    for (const hop of planned.hops) {
      let providerId = providerIds.get(hop.providerId);
      if (!providerId) {
        const provider = await repositories.providers.findBySlug(hop.providerId);
        if (!provider) throw new Error(`pricing provider ${hop.providerId} has no Provider record`);
        providerId = provider.id;
        providerIds.set(hop.providerId, providerId);
      }
      quotes.push(
        await repositories.quotes.create({
          id: hop.quote.id,
          intentId: request.intentId,
          intentRevision: request.intentRevision,
          providerId,
          input: hop.quote.input,
          output: hop.quote.output,
          ...(hop.quote.fee && { fee: hop.quote.fee }),
          ...(hop.quote.slippageBps !== undefined && { slippageBps: hop.quote.slippageBps }),
          ...(hop.quote.providerQuoteId && { providerQuoteId: hop.quote.providerQuoteId }),
          ...(hop.quote.expiresAt && { expiresAt: hop.quote.expiresAt }),
          // Which adapter priced it travels with the quote, so a stored route can be explained later.
          rawProviderData: { ...hop.quote.metadata, adapter: hop.providerId },
        }),
      );
    }

    const routeId = createId();
    const fees = planned.fees;
    const created = await repositories.routes.createWithSteps({
      id: routeId,
      intentId: request.intentId,
      intentRevision: request.intentRevision,
      status: "VALID",
      input: planned.input,
      output: planned.output,
      // A single total only when every fee is in one asset; otherwise the per-quote fees stand alone.
      ...(fees.length === 1 && fees[0] && { totalFee: fees[0] }),
      ...(planned.expiresAt && { expiresAt: planned.expiresAt }),
      steps:
        planned.kind === "TRANSFER"
          ? [
              {
                id: createId(),
                routeId,
                position: 0,
                type: "TRANSFER",
                input: planned.input,
                output: planned.output,
              },
            ]
          : planned.hops.map((hop, position) => {
              const providerId = providerIds.get(hop.providerId);
              return {
                id: createId(),
                routeId,
                position,
                type: "SWAP" as const,
                input: hop.input,
                output: hop.output,
                ...(providerId && { providerId }),
                quoteId: hop.quote.id,
              };
            }),
    });
    validatePaymentRoute(created);

    // Anything older is superseded: other revisions by revision, same-revision leftovers by status.
    await repositories.routes.invalidateOlderThan(request.intentId, request.intentRevision);
    for (const other of await repositories.routes.listByIntent(request.intentId)) {
      if (other.id !== created.id && other.status === "VALID") {
        await repositories.routes.updateStatus(other.id, "INVALID");
      }
    }
    await this.deps.authorization?.routeReplaced(repositories, request.intentId, {
      revision: request.intentRevision,
      routeId: created.id,
    });
    return { route: created, quotes };
  }

  private async findReusable(
    request: RoutingRequest,
    now: Date,
  ): Promise<{ route: PaymentRoute; quotes: Quote[] } | undefined> {
    const routes = await this.deps.read.routes.listByIntent(request.intentId);
    for (const route of routes) {
      if (route.status !== "VALID") continue;
      try {
        assertRouteUsable(route, { intentRevision: request.intentRevision, now });
      } catch (error) {
        if (isKaadaError(error)) continue;
        throw error;
      }
      const quotes: Quote[] = [];
      for (const step of route.steps) {
        if (!step.quoteId) continue;
        const quote = await this.deps.read.quotes.findById(step.quoteId);
        quotes.push(...(quote ? [quote] : []));
      }
      const expected = route.steps.filter((step) => step.quoteId).length;
      const live = quotes.every(
        (quote) =>
          quote.intentRevision === request.intentRevision &&
          quote.expiresAt !== undefined &&
          quote.expiresAt.getTime() > now.getTime(),
      );
      if (quotes.length === expected && live) return { route, quotes };
    }
    return undefined;
  }

  private async view(money: Money, assets: Map<string, Asset>): Promise<MoneyView> {
    let asset = assets.get(money.assetId);
    if (!asset) {
      const found = await this.deps.assets.getById(money.assetId);
      if (!found) throw new Error(`unknown asset ${money.assetId}`);
      asset = found;
      assets.set(asset.id, asset);
    }
    return {
      amount: money.amount,
      assetId: money.assetId,
      symbol: asset.symbol,
      display: `${formatAmount(money.amount, asset.decimals)} ${asset.symbol}`,
    };
  }

  /** The user-facing answer for a stored route: PAYMENT_READY, or QUOTE_RESULT for a quote. */
  private async respond(
    request: RoutingRequest,
    route: PaymentRoute,
    quotes: Quote[],
    authorization: { repositories: AgentRepositories; walletId?: string },
  ): Promise<AgentResponse> {
    const assets = new Map<string, Asset>();
    const slippageBps = quotes.reduce((sum, quote) => sum + (quote.slippageBps ?? 0), 0);
    const fees = await Promise.all(
      aggregateFees(quotes.map((quote) => quote.fee)).map((fee) => this.view(fee, assets)),
    );
    const routeSummary: RouteSummary = {
      hops: await Promise.all(
        route.steps
          .filter((step) => step.type === "SWAP")
          .map(async (step) => ({
            provider: adapterOf(quotes.find((q) => q.id === step.quoteId)),
            from: (await this.view(step.input, assets)).symbol,
            to: (await this.view(step.output, assets)).symbol,
          })),
      ),
    };
    const mock = quotes.some((quote) => quote.rawProviderData?.["mock"] === true);
    const expiresAt = (route.expiresAt ?? this.now()).toISOString();
    const seconds = route.expiresAt ? secondsUntil(route.expiresAt, this.now()) : 0;
    const indicative = quotes.some((quote) => quote.rawProviderData?.["indicative"] === true);
    const fine = mock
      ? " (mock pricing, development only, not a real price)"
      : indicative
        ? " (indicative price, not a firm quote)"
        : "";
    const feeText = fees.length > 0 ? fees.map((fee) => fee.display).join(" + ") : "none";
    const expiry = `The prices expire in ${seconds} seconds.`;

    const input = await this.view(route.input, assets);
    const output = await this.view(route.output, assets);

    if (request.purpose === "QUOTE") {
      const response: QuoteResultResponse = {
        type: "QUOTE_RESULT",
        text:
          request.amountMode === "EXACT_INPUT"
            ? `${input.display} currently gives approximately ${output.display}${fine}. Fees: ${feeText}. ${expiry} Nothing was sent.`
            : `To get ${output.display} you would need approximately ${input.display}${fine}. Fees: ${feeText}. ${expiry} Nothing was sent.`,
        intentId: request.intentId,
        revision: request.intentRevision,
        routeId: route.id,
        source: input,
        destination: output,
        fees,
        slippageBps,
        expiresAt,
        route: routeSummary,
        ...(mock && { mock }),
        ...(indicative && { indicative }),
      };
      return response;
    }

    // The same limits an authorization will bind (bounds.ts), so what is shown is what is approved.
    const exactInput = request.amountMode === "EXACT_INPUT";
    const max = maxSpend(route, slippageBps, request.amountMode);
    const min = minReceive(route, slippageBps, request.amountMode);
    const recipient = request.recipient?.displayName;
    const who = recipient ?? "The recipient";
    const gate = this.deps.authorization;
    if (gate && authorization.walletId) {
      const session = await gate.begin(authorization.repositories, {
        userId: request.userId,
        walletId: authorization.walletId,
        intentId: request.intentId,
        intentRevision: request.intentRevision,
        routeId: route.id,
      });
      const maximum = await this.view(max, assets);
      const minimum = await this.view(min, assets);
      const required: AuthorizationRequiredResponse = {
        type: "AUTHORIZATION_REQUIRED",
        text: exactInput
          ? `You spend exactly ${input.display}; ${who} receives about ${output.display} (at least ${minimum.display})${fine}. Fees: ${feeText}. Confirm with your PIN to authorize this payment. The final price is confirmed just before it is sent.`
          : `${who} receives exactly ${output.display}; you spend about ${input.display} (at most ${maximum.display})${fine}. Fees: ${feeText}. Confirm with your PIN to authorize this payment. The final price is confirmed just before it is sent.`,
        intentId: request.intentId,
        revision: request.intentRevision,
        routeId: route.id,
        authorizationSessionId: session.sessionId,
        expiresAt: session.expiresAt.toISOString(),
        summary: {
          amountMode: request.amountMode,
          ...(recipient && { recipient }),
          senderSpends: input,
          maximumSpend: maximum,
          recipientReceives: output,
          minimumReceive: minimum,
        },
        fees,
        slippageBps,
        ...(mock && { mock }),
        ...(indicative && { indicative }),
      };
      return required;
    }

    const response: PaymentReadyResponse = {
      type: "PAYMENT_READY",
      text: exactInput
        ? `You spend exactly ${input.display}; ${who} receives about ${output.display}${fine}. Fees: ${feeText}. ${expiry}`
        : `${who} receives exactly ${output.display}; estimated spend ${input.display}${fine}. Fees: ${feeText}. ${expiry}`,
      intentId: request.intentId,
      revision: request.intentRevision,
      routeId: route.id,
      senderSpends: { expected: input, max: await this.view(max, assets) },
      recipientReceives: { expected: output, min: await this.view(min, assets) },
      fees,
      slippageBps,
      expiresAt,
      route: routeSummary,
      ...(recipient && { recipient }),
      ...(mock && { mock }),
      ...(indicative && { indicative }),
    };
    return response;
  }
}

/** Which adapter priced a stored quote (recorded with it), or "" if unknown. */
function adapterOf(quote: Quote | undefined): string {
  const adapter = quote?.rawProviderData?.["adapter"];
  return typeof adapter === "string" ? adapter : "";
}

function failed(
  request: RoutingRequest,
  code: "NO_ROUTE" | "ROUTING_UNAVAILABLE",
  text: string,
): RoutingOutcome {
  return { status: "FAILED", request, response: { type: "ERROR", code, text } };
}
