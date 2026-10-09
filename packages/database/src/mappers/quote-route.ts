import { createMoney } from "@kaada/domain";
import type { NewQuote, NewRoute, PaymentRoute, Quote, RouteStep } from "@kaada/domain";

import type {
  Prisma,
  Quote as QuoteRow,
  Route as RouteRow,
  RouteStep as RouteStepRow,
} from "../generated/prisma/client.js";
import { jsonInput, maybe, moneyFromColumns, readJsonObject } from "./support.js";

export function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    intentId: row.intentId,
    providerId: row.providerId,
    input: createMoney(row.inputAmount, row.inputAssetId),
    output: createMoney(row.outputAmount, row.outputAssetId),
    ...maybe("fee", moneyFromColumns(row.feeAmount, row.feeAssetId, `Quote ${row.id} fee`)),
    ...maybe("slippageBps", row.slippageBps),
    ...maybe("providerQuoteId", row.providerQuoteId),
    ...maybe("expiresAt", row.expiresAt),
    ...maybe("rawProviderData", readJsonObject(row.rawProviderData, "Quote.rawProviderData")),
    createdAt: row.createdAt,
  };
}

export function quoteCreateData(quote: NewQuote): Prisma.QuoteUncheckedCreateInput {
  return {
    id: quote.id,
    intentId: quote.intentId,
    providerId: quote.providerId,
    inputAssetId: quote.input.assetId,
    outputAssetId: quote.output.assetId,
    inputAmount: quote.input.amount,
    outputAmount: quote.output.amount,
    feeAmount: quote.fee?.amount ?? null,
    feeAssetId: quote.fee?.assetId ?? null,
    slippageBps: quote.slippageBps ?? null,
    providerQuoteId: quote.providerQuoteId ?? null,
    expiresAt: quote.expiresAt ?? null,
    ...maybe("rawProviderData", jsonInput(quote.rawProviderData, "Quote.rawProviderData")),
  };
}

export function toRouteStep(row: RouteStepRow): RouteStep {
  return {
    id: row.id,
    routeId: row.routeId,
    position: row.position,
    type: row.type,
    input: createMoney(row.inputAmount, row.inputAssetId),
    output: createMoney(row.outputAmount, row.outputAssetId),
    ...maybe("providerId", row.providerId),
    ...maybe("quoteId", row.quoteId),
    ...maybe("metadata", readJsonObject(row.metadata, "RouteStep.metadata")),
    createdAt: row.createdAt,
  };
}

export type RouteRowWithSteps = RouteRow & { steps: RouteStepRow[] };

export function toRoute(row: RouteRowWithSteps): PaymentRoute {
  return {
    id: row.id,
    intentId: row.intentId,
    status: row.status,
    input: createMoney(row.estimatedInput, row.inputAssetId),
    output: createMoney(row.estimatedOutput, row.outputAssetId),
    ...maybe(
      "totalFee",
      moneyFromColumns(row.totalFeeAmount, row.totalFeeAssetId, `Route ${row.id} fee`),
    ),
    ...maybe("expiresAt", row.expiresAt),
    steps: [...row.steps].sort((a, b) => a.position - b.position).map(toRouteStep),
    createdAt: row.createdAt,
  };
}

/** Route plus its steps as one nested write, so the route is stored atomically. */
export function routeCreateData(route: NewRoute): Prisma.RouteUncheckedCreateInput {
  return {
    id: route.id,
    intentId: route.intentId,
    status: route.status,
    inputAssetId: route.input.assetId,
    outputAssetId: route.output.assetId,
    estimatedInput: route.input.amount,
    estimatedOutput: route.output.amount,
    totalFeeAmount: route.totalFee?.amount ?? null,
    totalFeeAssetId: route.totalFee?.assetId ?? null,
    expiresAt: route.expiresAt ?? null,
    steps: {
      create: route.steps.map((step): Omit<Prisma.RouteStepUncheckedCreateInput, "routeId"> => ({
        id: step.id,
        position: step.position,
        type: step.type,
        providerId: step.providerId ?? null,
        inputAssetId: step.input.assetId,
        outputAssetId: step.output.assetId,
        inputAmount: step.input.amount,
        outputAmount: step.output.amount,
        quoteId: step.quoteId ?? null,
        ...maybe("metadata", jsonInput(step.metadata, "RouteStep.metadata")),
      })),
    },
  };
}
