import type { Asset, AssetRegistry } from "../assets/index.js";
import { isKaadaError } from "../errors/index.js";
import type { RoutingRequest } from "../intents/routing-request.js";
import { createMoney, rescaleAmount } from "../money/index.js";
import type { Money } from "../money/index.js";
import type { CapabilityType, FxProvider, ProviderCapabilityRegistry } from "../providers/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { FxQuote, QuoteRequest } from "../quotes/index.js";
import { CELO_CHAIN_ID } from "../settlement/index.js";
import type { RoutingCandidateSet } from "./candidates.js";
import { aggregateFees } from "./planned-route.js";
import type { PlannedHop, PlannedRoute } from "./planned-route.js";
import { rankRoutes } from "./route-ranking.js";

/** Longest chain of provider steps a route may have. A bounded search, not a general pathfinder. */
export const MAX_ROUTE_HOPS = 2;

export type RoutePlanFailureKind = "PROVIDER_UNAVAILABLE" | "QUOTE_FAILED";

export interface RoutePlanFailure {
  kind: RoutePlanFailureKind;
  providerId: string;
  inputAssetId: string;
  outputAssetId: string;
  reason: string;
}

/**
 * - SUCCESS:              one or more valid routes, best first.
 * - NO_ROUTE:             no path exists (or none survived validation); `reason` says why.
 * - PROVIDER_UNAVAILABLE: every attempt failed because a provider could not be reached or is not wired.
 * - QUOTE_FAILED:         providers answered but no usable quote came back.
 */
export type RoutePlanResult =
  | { status: "SUCCESS"; routes: PlannedRoute[]; failures: RoutePlanFailure[] }
  | { status: "NO_ROUTE"; reason: string; failures: RoutePlanFailure[] }
  | { status: "PROVIDER_UNAVAILABLE"; failures: RoutePlanFailure[] }
  | { status: "QUOTE_FAILED"; failures: RoutePlanFailure[] };

/** Plans and prices routes for a request whose candidates were already discovered. */
export interface RoutePlanner {
  plan(request: RoutingRequest, candidates: RoutingCandidateSet): Promise<RoutePlanResult>;
}

/** Which price source serves a capability provider. Production wires real adapters; tests the mock. */
export interface FxProviderDirectory {
  get(capabilityProvider: string): FxProvider | undefined;
}

export function createFxProviderDirectory(
  bindings: readonly { capabilityProvider: string; provider: FxProvider }[],
): FxProviderDirectory {
  const byCapability = new Map(bindings.map((b) => [b.capabilityProvider, b.provider]));
  return { get: (capabilityProvider) => byCapability.get(capabilityProvider) };
}

export interface RoutePlannerDeps {
  assets: AssetRegistry;
  capabilities: ProviderCapabilityRegistry;
  fx: FxProviderDirectory;
  now: () => Date;
  chainId?: number;
}

interface HopSpec {
  from: string;
  to: string;
  capabilityProvider: string;
}

/** Why a priced quote is not acceptable for the request it answered, or undefined if it is. */
export function checkQuote(
  quote: FxQuote,
  request: QuoteRequest,
  now: Date,
  maxSlippageBps: number | undefined,
): string | undefined {
  if (
    quote.input.assetId !== request.inputAssetId ||
    quote.output.assetId !== request.outputAssetId
  ) {
    return "quote assets do not match the request";
  }
  if (request.mode === "EXACT_INPUT" && quote.input.amount !== request.amount.amount) {
    return "an exact-input quote must spend exactly the requested input";
  }
  if (request.mode === "EXACT_OUTPUT" && quote.output.amount !== request.amount.amount) {
    return "an exact-output quote must deliver exactly the requested output";
  }
  if (BigInt(quote.input.amount) === 0n || BigInt(quote.output.amount) === 0n) {
    return "quote has a zero amount";
  }
  if (quote.fee !== undefined && !/^(0|[1-9][0-9]*)$/.test(quote.fee.amount)) {
    return "quote fee is not a smallest-unit amount";
  }
  if (quote.expiresAt === undefined || quote.expiresAt.getTime() <= now.getTime()) {
    return "quote is expired or has no expiry";
  }
  if (maxSlippageBps !== undefined && (quote.slippageBps ?? 0) > maxSlippageBps) {
    return "quote slippage exceeds the limit";
  }
  return undefined;
}

export function createRoutePlanner(deps: RoutePlannerDeps): RoutePlanner {
  const chainId = deps.chainId ?? CELO_CHAIN_ID;

  return {
    async plan(request, candidates) {
      const failures: RoutePlanFailure[] = [];
      const now = deps.now();
      const mode: AmountMode = request.amountMode;
      const maxSlippage = request.constraints?.maxSlippageBps;

      if (
        candidates.intentId !== request.intentId ||
        candidates.intentRevision !== request.intentRevision
      ) {
        return { status: "NO_ROUTE", reason: "REVISION_MISMATCH", failures };
      }

      const assetMemo = new Map<string, Promise<Asset | null>>();
      const assetFor = (id: string) => {
        if (!assetMemo.has(id)) assetMemo.set(id, deps.assets.getById(id));
        return assetMemo.get(id) as Promise<Asset | null>;
      };
      const quoteMemo = new Map<
        string,
        Promise<FxQuote | { error: string; kind: RoutePlanFailureKind }>
      >();

      const required: CapabilityType[] = candidates.requiredCapabilities;

      /** Providers that can serve a directed step with every required capability. */
      async function stepProviders(from: string, to: string): Promise<string[]> {
        const supports = await deps.capabilities.getCapabilitiesForPair({
          chainId,
          inputAssetId: from,
          outputAssetId: to,
        });
        return supports
          .filter((s) => required.every((c) => s.capabilities.includes(c)))
          .map((s) => s.providerSlug);
      }

      /** Simple paths of 1..MAX_ROUTE_HOPS steps with every provider choice per step. */
      async function paths(from: string, to: string): Promise<HopSpec[][]> {
        const found: HopSpec[][] = [];
        for (const provider of await stepProviders(from, to)) {
          found.push([{ from, to, capabilityProvider: provider }]);
        }
        if (MAX_ROUTE_HOPS < 2) return found;
        const middles = new Set<string>();
        for (const edge of await deps.capabilities.getPairsFrom({ chainId, inputAssetId: from })) {
          middles.add(edge.outputAssetId);
        }
        for (const middle of [...middles].sort()) {
          if (middle === from || middle === to) continue; // no repeated asset, so no cycle
          const first = await stepProviders(from, middle);
          if (first.length === 0) continue;
          const second = await stepProviders(middle, to);
          for (const a of first) {
            for (const b of second) {
              found.push([
                { from, to: middle, capabilityProvider: a },
                { from: middle, to, capabilityProvider: b },
              ]);
            }
          }
        }
        return found;
      }

      async function quoteHop(
        spec: HopSpec,
        amount: Money,
      ): Promise<{ hop: PlannedHop } | { failure: RoutePlanFailure }> {
        const provider = deps.fx.get(spec.capabilityProvider);
        const failureBase = {
          providerId: provider?.id ?? spec.capabilityProvider,
          inputAssetId: spec.from,
          outputAssetId: spec.to,
        };
        if (!provider) {
          return {
            failure: {
              ...failureBase,
              kind: "PROVIDER_UNAVAILABLE",
              reason: "no price source is wired",
            },
          };
        }
        const quoteRequest: QuoteRequest = {
          userId: request.userId,
          inputAssetId: spec.from,
          outputAssetId: spec.to,
          amount,
          mode,
          ...(maxSlippage !== undefined && { constraints: { maxSlippageBps: maxSlippage } }),
        };
        const key = `${provider.id}|${spec.from}|${spec.to}|${mode}|${amount.amount}`;
        if (!quoteMemo.has(key)) {
          quoteMemo.set(
            key,
            (async () => {
              try {
                if (!(await provider.supports(quoteRequest))) {
                  return {
                    error: "provider does not support the pair",
                    kind: "QUOTE_FAILED" as const,
                  };
                }
                const quote = await provider.quote(quoteRequest);
                const problem = checkQuote(quote, quoteRequest, now, maxSlippage);
                return problem ? { error: problem, kind: "QUOTE_FAILED" as const } : quote;
              } catch (error) {
                return {
                  error: error instanceof Error ? error.message : "quote failed",
                  kind: isKaadaError(error, "PROVIDER_UNAVAILABLE")
                    ? ("PROVIDER_UNAVAILABLE" as const)
                    : ("QUOTE_FAILED" as const),
                };
              }
            })(),
          );
        }
        const outcome = await (quoteMemo.get(key) as Promise<
          FxQuote | { error: string; kind: RoutePlanFailureKind }
        >);
        if ("error" in outcome) {
          return { failure: { ...failureBase, kind: outcome.kind, reason: outcome.error } };
        }
        return {
          hop: {
            capabilityProvider: spec.capabilityProvider,
            providerId: provider.id,
            quote: outcome,
            input: outcome.input,
            output: outcome.output,
          },
        };
      }

      /** Prices a path against the fixed side: forward for EXACT_INPUT, backward for EXACT_OUTPUT. */
      async function price(path: HopSpec[], fixed: Money): Promise<PlannedRoute | undefined> {
        const hops: PlannedHop[] = new Array<PlannedHop>(path.length);
        let amount = fixed;
        const order =
          mode === "EXACT_INPUT" ? path.map((_, i) => i) : path.map((_, i) => path.length - 1 - i);
        for (const index of order) {
          const spec = path[index] as HopSpec;
          const priced = await quoteHop(spec, amount);
          if ("failure" in priced) {
            failures.push(priced.failure);
            return undefined;
          }
          hops[index] = priced.hop;
          amount = mode === "EXACT_INPUT" ? priced.hop.output : priced.hop.input;
        }
        const first = hops[0] as PlannedHop;
        const last = hops[hops.length - 1] as PlannedHop;
        const expiries = hops.map((h) => h.quote.expiresAt as Date);
        return {
          sourceAssetId: first.input.assetId,
          destinationAssetId: last.output.assetId,
          kind: "SWAP",
          hops,
          input: first.input,
          output: last.output,
          fees: aggregateFees(hops.map((h) => h.quote.fee)),
          slippageBps: hops.reduce((sum, h) => sum + (h.quote.slippageBps ?? 0), 0),
          expiresAt: new Date(Math.min(...expiries.map((d) => d.getTime()))),
          key: hops.map((h) => `${h.providerId}:${h.input.assetId}>${h.output.assetId}`).join("|"),
        };
      }

      const amountAsset = await assetFor(request.amount.assetId);
      if (!amountAsset) return { status: "NO_ROUTE", reason: "UNKNOWN_AMOUNT_ASSET", failures };

      const routes: PlannedRoute[] = [];
      for (const pair of candidates.pairs) {
        const fixedAssetId = mode === "EXACT_INPUT" ? pair.sourceAssetId : pair.destinationAssetId;
        const fixedAsset = await assetFor(fixedAssetId);
        if (!fixedAsset) continue;
        // The fixed side is expressed in the candidate token. A token represents its currency at par
        // (that is what its settlement metadata says), so the amount is only re-expressed at the
        // token's precision: exact when it gains decimals, rounded toward the user when it loses.
        let fixed: Money;
        if (fixedAsset.id === amountAsset.id) {
          fixed = request.amount;
        } else if (
          fixedAsset.fiatCode !== undefined &&
          fixedAsset.fiatCode === amountAsset.fiatCode
        ) {
          fixed = createMoney(
            rescaleAmount(
              BigInt(request.amount.amount),
              amountAsset.decimals,
              fixedAsset.decimals,
              mode === "EXACT_INPUT" ? "DOWN" : "UP",
            ).toString(),
            fixedAsset.id,
          );
        } else {
          continue;
        }

        if (pair.kind === "DIRECT") {
          routes.push({
            sourceAssetId: pair.sourceAssetId,
            destinationAssetId: pair.destinationAssetId,
            kind: "TRANSFER",
            hops: [],
            input: fixed,
            output: fixed,
            fees: [],
            slippageBps: 0,
            key: `transfer:${pair.sourceAssetId}`,
          });
          continue;
        }

        for (const path of await paths(pair.sourceAssetId, pair.destinationAssetId)) {
          const route = await price(path, fixed);
          if (route) routes.push(route);
        }
      }

      const assets = new Map<string, Asset>();
      for (const route of routes) {
        for (const id of [
          route.sourceAssetId,
          route.destinationAssetId,
          ...route.hops.flatMap((h) => [h.input.assetId, h.output.assetId]),
        ]) {
          const asset = await assetFor(id);
          if (asset) assets.set(id, asset);
        }
      }

      const valid = routes.filter(
        (route) =>
          validatePlannedRoute(route, { request, candidates, assets, now, maxSlippage, chainId })
            .length === 0,
      );
      if (valid.length > 0) {
        return { status: "SUCCESS", routes: rankRoutes(valid, { mode, assets }), failures };
      }
      if (routes.length > 0) return { status: "NO_ROUTE", reason: "VALIDATION", failures };
      if (failures.length > 0) {
        return failures.every((f) => f.kind === "PROVIDER_UNAVAILABLE")
          ? { status: "PROVIDER_UNAVAILABLE", failures }
          : { status: "QUOTE_FAILED", failures };
      }
      return { status: "NO_ROUTE", reason: "NO_PATH", failures };
    },
  };
}

export interface RouteValidationContext {
  request: RoutingRequest;
  candidates: RoutingCandidateSet;
  assets: ReadonlyMap<string, Asset>;
  now: Date;
  maxSlippage: number | undefined;
  chainId: number;
}

/**
 * Deterministic checks on a priced route. Returns every violation (empty means valid):
 * chain, active assets, contiguity, no repeated asset, at most MAX_ROUTE_HOPS steps, quotes
 * unexpired, source preference and destination respected, the fixed side exact, revision bound.
 */
export function validatePlannedRoute(
  route: PlannedRoute,
  context: RouteValidationContext,
): string[] {
  const problems: string[] = [];
  const { request, candidates, assets, now } = context;

  if (context.chainId !== CELO_CHAIN_ID || candidates.chainId !== CELO_CHAIN_ID) {
    problems.push("not on Celo");
  }
  if (candidates.intentRevision !== request.intentRevision) problems.push("revision mismatch");
  if (route.hops.length > MAX_ROUTE_HOPS) problems.push("too many hops");

  const path =
    route.kind === "TRANSFER"
      ? [route.sourceAssetId]
      : [route.sourceAssetId, ...route.hops.map((h) => h.output.assetId)];
  if (new Set(path).size !== path.length) problems.push("route revisits an asset");

  for (const id of new Set(path)) {
    const asset = assets.get(id);
    if (!asset || !asset.isActive) problems.push("an asset is inactive or unknown");
    else if (asset.kind !== "FIAT" && asset.chainId !== context.chainId)
      problems.push("an asset is not on Celo");
  }

  let previous = route.sourceAssetId;
  for (const hop of route.hops) {
    if (hop.input.assetId !== previous) problems.push("steps are not contiguous");
    previous = hop.output.assetId;
    if (hop.quote.expiresAt === undefined || hop.quote.expiresAt.getTime() <= now.getTime()) {
      problems.push("a quote is expired");
    }
  }
  if (previous !== route.destinationAssetId) problems.push("route does not reach the destination");

  const preferred = request.preferredSourceAssetId;
  if (preferred !== undefined && route.sourceAssetId !== preferred) {
    problems.push("source preference not respected");
  }
  if (!candidates.source.candidates.some((c) => c.assetId === route.sourceAssetId)) {
    problems.push("source is not a candidate");
  }
  if (!candidates.destination.candidates.some((c) => c.assetId === route.destinationAssetId)) {
    problems.push("destination is not a candidate");
  }
  if (context.maxSlippage !== undefined && route.slippageBps > context.maxSlippage) {
    problems.push("slippage exceeds the limit");
  }

  const fixed = request.amountMode === "EXACT_INPUT" ? route.input : route.output;
  const fixedAsset = assets.get(fixed.assetId);
  const amountAsset = assets.get(request.amount.assetId);
  if (fixedAsset && amountAsset) {
    const expected =
      fixedAsset.id === amountAsset.id
        ? BigInt(request.amount.amount)
        : rescaleAmount(
            BigInt(request.amount.amount),
            amountAsset.decimals,
            fixedAsset.decimals,
            request.amountMode === "EXACT_INPUT" ? "DOWN" : "UP",
          );
    if (BigInt(fixed.amount) !== expected) problems.push("the fixed side is not exact");
  }
  return problems;
}
