import type { Asset, AssetRegistry, CountryDirectory } from "../assets/index.js";
import type { RoutingRequest } from "../intents/routing-request.js";
import { formatSmallestUnit } from "../money/index.js";
import type { CapabilityType, ProviderCapabilityRegistry } from "../providers/index.js";
import type { SettlementAssetResolver, SettlementResolution } from "../settlement/index.js";
import { CELO_CHAIN_ID } from "../settlement/index.js";
import type {
  CandidateAsset,
  CandidatePair,
  CandidateResult,
  CandidateSide,
  CandidateUnsupported,
  RoutingCandidateSet,
} from "./candidates.js";

export interface RoutingCandidateResolverDeps {
  assets: AssetRegistry;
  settlement: SettlementAssetResolver;
  capabilities: ProviderCapabilityRegistry;
  countries: CountryDirectory;
  chainId?: number;
  /**
   * Most provider steps a conversion may take: 1 (default) keeps only pairs a provider serves
   * directly; 2 also keeps pairs reachable through one intermediate asset (USDC -> USDT -> wBRL).
   */
  maxHops?: 1 | 2;
}

/**
 * Turns a RoutingRequest into the assets and providers a router may consider. Discovery only:
 * it selects no route, fetches no quote, and neither calculates a rate, fee or converted amount nor
 * assumes the user holds any asset. Deterministic; the database (via the registries) is the only
 * input.
 */
export interface RoutingCandidateResolver {
  resolve(request: RoutingRequest): Promise<CandidateResult>;
}

/** True while a candidate set still describes the intent: same intent, same revision. */
export function isCandidateSetCurrent(
  set: Pick<RoutingCandidateSet, "intentId" | "intentRevision">,
  intent: { id: string; revision: number },
): boolean {
  return set.intentId === intent.id && set.intentRevision === intent.revision;
}

const labelOf = (asset: Asset): string => asset.fiatCode ?? asset.symbol;

/** "500.00" -> "500", "20.50" -> "20.5": the number as a person would write it. */
function humanValue(amount: string, decimals: number): string {
  const exact = formatSmallestUnit(amount, decimals);
  return exact.includes(".") ? exact.replace(/\.?0+$/, "") : exact;
}

type SideOutcome =
  { ok: true; side: CandidateSide; assets: Asset[] } | { ok: false; failure: CandidateUnsupported };

export function createRoutingCandidateResolver(
  deps: RoutingCandidateResolverDeps,
): RoutingCandidateResolver {
  const chainId = deps.chainId ?? CELO_CHAIN_ID;
  const maxHops = deps.maxHops ?? 1;

  const fail = (
    code: CandidateUnsupported["code"],
    text: string,
    extra: Partial<Omit<CandidateUnsupported, "status" | "code" | "text">> = {},
  ): { ok: false; failure: CandidateUnsupported } => ({
    ok: false,
    failure: { status: "UNSUPPORTED", code, text, details: {}, ...extra },
  });

  /** Why an asset could not be used on a side, in the right error code and wording. */
  function unsupportedAsset(
    side: "SOURCE" | "DESTINATION",
    resolution: Extract<SettlementResolution, { status: "UNSUPPORTED" }>,
  ) {
    const details = { denomination: resolution.denomination, reason: resolution.reason };
    if (resolution.reason === "NO_SETTLEMENT_ASSET") {
      return fail(
        "NO_SETTLEMENT_ASSET",
        `I currently don't have a supported settlement route for ${resolution.denomination}.`,
        { side, details },
      );
    }
    return side === "SOURCE"
      ? fail("SOURCE_ASSET_UNSUPPORTED", `I can't pay with ${resolution.denomination} right now.`, {
          side,
          details,
        })
      : fail(
          "DESTINATION_ASSET_UNSUPPORTED",
          `I can't deliver ${resolution.denomination} right now.`,
          { side, details },
        );
  }

  function describeSide(
    denomination: string,
    origin: CandidateSide["origin"],
    assets: Asset[],
  ): SideOutcome {
    return {
      ok: true,
      assets,
      side: {
        denomination,
        origin,
        candidates: assets.map((asset): CandidateAsset => ({
          assetId: asset.id,
          symbol: asset.symbol,
          kind: asset.kind,
          providers: [],
        })),
      },
    };
  }

  async function sourceSide(request: RoutingRequest): Promise<SideOutcome> {
    const reference =
      request.sourceAssetId ??
      (request.amountMode === "EXACT_INPUT" ? request.amount.assetId : undefined);
    const preferenceId = request.preferredSourceAssetId;
    const preference = preferenceId ? await deps.assets.getById(preferenceId) : null;

    // A preference must be a usable token on the chain; a fiat currency cannot be spent.
    let preferred: Asset | undefined;
    if (preferenceId) {
      const resolved = await deps.settlement.resolveAsset({ chainId, assetId: preferenceId });
      if (resolved.status === "UNSUPPORTED" || preference?.kind === "FIAT") {
        const denomination = resolved.denomination;
        return fail(
          "SOURCE_ASSET_UNSUPPORTED",
          `I can't pay with ${preference ? labelOf(preference) : denomination} right now.`,
          {
            side: "SOURCE",
            details: {
              denomination,
              reason: resolved.status === "UNSUPPORTED" ? resolved.reason : "NOT_A_TOKEN",
            },
          },
        );
      }
      preferred = resolved.assets[0];
    }

    if (reference) {
      const resolution = await deps.settlement.resolveAsset({ chainId, assetId: reference });
      if (resolution.status === "UNSUPPORTED") return unsupportedAsset("SOURCE", resolution);
      const referenceAsset = await deps.assets.getById(reference);
      const isToken = referenceAsset?.kind !== "FIAT";

      if (preferred) {
        // "$20 using USDT": the preference must be one of the tokens that represent the amount's
        // currency. A named token amount cannot be paid with a different token.
        const allowed = resolution.assets.some((asset) => asset.id === preferred.id);
        if (!allowed) {
          return fail(
            "SOURCE_ASSET_UNSUPPORTED",
            `I can't pay ${resolution.denomination} using ${preferred.symbol}.`,
            {
              side: "SOURCE",
              details: {
                denomination: resolution.denomination,
                reason: isToken
                  ? "PREFERENCE_CONFLICTS_WITH_AMOUNT_ASSET"
                  : "PREFERENCE_NOT_A_SETTLEMENT_ASSET_OF_AMOUNT",
                assetIds: [preferred.id],
              },
            },
          );
        }
        return describeSide(resolution.denomination, "EXPLICIT_PREFERENCE", [preferred]);
      }
      return describeSide(
        resolution.denomination,
        isToken ? "EXPLICIT_ASSET" : "SETTLEMENT",
        resolution.assets,
      );
    }

    if (preferred) return describeSide(labelOf(preferred), "EXPLICIT_PREFERENCE", [preferred]);

    // Nothing named: the supported USD settlement assets. Whether the user holds them is for the
    // wallet layer to filter later.
    const funding = await deps.settlement.resolveCurrency({ chainId, fiatCode: "USD" });
    if (funding.status === "UNSUPPORTED") return unsupportedAsset("SOURCE", funding);
    return describeSide(funding.denomination, "DEFAULT_FUNDING", funding.assets);
  }

  async function destinationSide(request: RoutingRequest): Promise<SideOutcome> {
    const reference =
      request.destinationAssetId ??
      (request.amountMode === "EXACT_OUTPUT" ? request.amount.assetId : undefined);

    let resolution: SettlementResolution;
    let origin: CandidateSide["origin"] = "SETTLEMENT";
    if (reference) {
      resolution = await deps.settlement.resolveAsset({ chainId, assetId: reference });
      const asset = await deps.assets.getById(reference);
      if (asset && asset.kind !== "FIAT") origin = "EXPLICIT_ASSET";
    } else {
      if (request.destinationCountry) {
        // A country fixes the currency the recipient gets; one we cannot map is unsupported, not
        // silently treated as "same as the amount".
        const currency = deps.countries.currencyOf(request.destinationCountry);
        resolution = currency
          ? await deps.settlement.resolveCurrency({ chainId, fiatCode: currency })
          : {
              status: "UNSUPPORTED",
              denomination: request.destinationCountry,
              reason: "NO_SETTLEMENT_ASSET",
            };
      } else {
        // Nothing says where it goes: the recipient gets what the amount is denominated in.
        resolution = await deps.settlement.resolveAsset({
          chainId,
          assetId: request.amount.assetId,
        });
      }
    }
    if (resolution.status === "UNSUPPORTED") return unsupportedAsset("DESTINATION", resolution);
    return describeSide(resolution.denomination, origin, resolution.assets);
  }

  return {
    async resolve(request) {
      const amountAsset = await deps.assets.getById(request.amount.assetId);
      if (!amountAsset) {
        const side = request.amountMode === "EXACT_INPUT" ? "SOURCE" : "DESTINATION";
        return unsupportedAsset(side, {
          status: "UNSUPPORTED",
          denomination: request.amount.assetId,
          reason: "UNKNOWN_ASSET",
        }).failure;
      }

      const source = await sourceSide(request);
      if (!source.ok) return source.failure;
      const destination = await destinationSide(request);
      if (!destination.ok) return destination.failure;

      const required: CapabilityType[] =
        request.purpose === "QUOTE"
          ? ["QUOTE", request.amountMode]
          : ["QUOTE", "SWAP", request.amountMode];

      const pairs: CandidatePair[] = [];
      let partial: { missing: CapabilityType[] } | undefined;
      for (const from of source.assets) {
        for (const to of destination.assets) {
          if (from.id === to.id) {
            pairs.push({
              sourceAssetId: from.id,
              destinationAssetId: to.id,
              kind: "DIRECT",
              hops: 0,
              providers: [],
            });
            continue;
          }
          const supports = await deps.capabilities.getCapabilitiesForPair({
            chainId,
            inputAssetId: from.id,
            outputAssetId: to.id,
          });
          const qualifying = supports.filter((support) =>
            required.every((capability) => support.capabilities.includes(capability)),
          );
          if (qualifying.length > 0) {
            pairs.push({
              sourceAssetId: from.id,
              destinationAssetId: to.id,
              kind: "CONVERSION",
              hops: 1,
              providers: qualifying.map((support) => ({
                slug: support.providerSlug,
                capabilities: support.capabilities,
              })),
            });
          } else if (maxHops >= 2) {
            // Through one intermediate asset: from -> via is a qualifying step, and via -> to too.
            const via: string[] = [];
            const providers = new Map<string, CandidatePair["providers"][number]>();
            for (const edge of await deps.capabilities.getPairsFrom({
              chainId,
              inputAssetId: from.id,
            })) {
              if (edge.outputAssetId === to.id || edge.outputAssetId === from.id) continue;
              if (!required.every((capability) => edge.capabilities.includes(capability))) continue;
              const onward = (
                await deps.capabilities.getCapabilitiesForPair({
                  chainId,
                  inputAssetId: edge.outputAssetId,
                  outputAssetId: to.id,
                })
              ).filter((support) =>
                required.every((capability) => support.capabilities.includes(capability)),
              );
              if (onward.length === 0) continue;
              if (!via.includes(edge.outputAssetId)) via.push(edge.outputAssetId);
              for (const support of [edge, ...onward]) {
                providers.set(support.providerSlug, {
                  slug: support.providerSlug,
                  capabilities: support.capabilities,
                });
              }
            }
            if (via.length > 0) {
              pairs.push({
                sourceAssetId: from.id,
                destinationAssetId: to.id,
                kind: "CONVERSION",
                hops: 2,
                via: via.sort(),
                providers: [...providers.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
              });
            }
          }
          for (const support of supports) {
            const missing = required.filter(
              (capability) => !support.capabilities.includes(capability),
            );
            if (missing.length > 0 && (!partial || missing.length < partial.missing.length)) {
              partial = { missing };
            }
          }
        }
      }

      const sourceLabel = source.side.denomination;
      const destinationLabel = destination.side.denomination;
      if (pairs.length === 0) {
        return partial
          ? {
              status: "UNSUPPORTED",
              code: "PROVIDER_CAPABILITY_UNAVAILABLE",
              text: `I can't do that kind of conversion from ${sourceLabel} to ${destinationLabel} yet.`,
              details: { missingCapabilities: partial.missing },
            }
          : {
              status: "UNSUPPORTED",
              code: "NO_PROVIDER_FOR_PAIR",
              text: `I don't have a supported way to convert ${sourceLabel} to ${destinationLabel} yet.`,
              details: {},
            };
      }

      // Keep only candidates that take part in a retained pair, and say who serves them.
      const keep = (side: CandidateSide, key: "sourceAssetId" | "destinationAssetId") => ({
        ...side,
        candidates: side.candidates
          .filter((candidate) => pairs.some((pair) => pair[key] === candidate.assetId))
          .map((candidate) => ({
            ...candidate,
            providers: [
              ...new Set(
                pairs
                  .filter((pair) => pair[key] === candidate.assetId)
                  .flatMap((pair) => pair.providers.map((provider) => provider.slug)),
              ),
            ].sort(),
          })),
      });
      const sourceKept = keep(source.side, "sourceAssetId");
      const destinationKept = keep(destination.side, "destinationAssetId");

      // Several equivalent USD stablecoins are fine to hand on; several tokens for any other
      // currency would be a real choice nobody has made.
      for (const [side, kept, label] of [
        ["SOURCE", sourceKept, sourceLabel],
        ["DESTINATION", destinationKept, destinationLabel],
      ] as const) {
        const ambiguous =
          kept.origin === "SETTLEMENT" &&
          kept.candidates.length > 1 &&
          kept.candidates.some((candidate) => candidate.kind !== "USD_STABLECOIN");
        if (ambiguous) {
          return {
            status: "UNSUPPORTED",
            code: "AMBIGUOUS_SETTLEMENT_ASSET",
            side,
            text: `${label} can be settled in more than one asset (${kept.candidates
              .map((candidate) => candidate.symbol)
              .join(", ")}). Which one would you like?`,
            details: {
              denomination: label,
              assetIds: kept.candidates.map((candidate) => candidate.assetId),
            },
          };
        }
      }

      const set: RoutingCandidateSet = {
        intentId: request.intentId,
        intentRevision: request.intentRevision,
        userId: request.userId,
        chainId,
        operation: request.operation,
        purpose: request.purpose,
        amount: {
          denomination: labelOf(amountAsset),
          assetId: amountAsset.id,
          mode: request.amountMode,
          humanValue: humanValue(request.amount.amount, amountAsset.decimals),
          money: request.amount,
        },
        requiredCapabilities: required,
        source: sourceKept,
        destination: destinationKept,
        pairs,
        explicitSourceAssetId: request.preferredSourceAssetId ?? null,
        ...(request.recipient && { recipient: request.recipient }),
        ...(request.destinationCountry && { destinationCountry: request.destinationCountry }),
      };
      return { status: "READY", set };
    },
  };
}
