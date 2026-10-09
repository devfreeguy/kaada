import { KaadaError } from "../errors/index.js";
import type { AmountMode } from "./amount-mode.js";
import type { JsonObject } from "../json.js";
import { isZeroMoney } from "../money/index.js";
import type { Money } from "../money/index.js";
import type { RoutePreference } from "../routing/index.js";

/** Limits a quote must respect. Optional fields accept explicit undefined for Zod compatibility. */
export interface QuoteConstraints {
  maxSlippageBps?: number | undefined;
  routePreference?: RoutePreference | undefined;
}

/**
 * Asks "what would this trade cost?" for resolved assets and a canonical amount.
 *
 * `amount` is the fixed side, selected by `mode`:
 * - EXACT_INPUT:  amount is in inputAssetId  ("I spend exactly this"); the output is quoted.
 * - EXACT_OUTPUT: amount is in outputAssetId ("they receive exactly this"); the input is quoted.
 */
export interface QuoteRequest {
  userId: string;
  inputAssetId: string;
  outputAssetId: string;
  amount: Money;
  mode: AmountMode;
  constraints?: QuoteConstraints | undefined;
}

/** The asset that `amount` must be denominated in for this request. */
export function fixedSideAssetId(
  request: Pick<QuoteRequest, "mode" | "inputAssetId" | "outputAssetId">,
): string {
  return request.mode === "EXACT_INPUT" ? request.inputAssetId : request.outputAssetId;
}

/** Rejects requests whose amount is in the wrong asset for the mode, or is zero. */
export function validateQuoteRequest(request: QuoteRequest): void {
  if (request.amount.assetId !== fixedSideAssetId(request)) {
    throw new KaadaError(
      "ASSET_MISMATCH",
      "amount asset does not match the fixed side of the quote",
      {
        details: { mode: request.mode },
      },
    );
  }
  if (isZeroMoney(request.amount)) {
    throw new KaadaError("INVALID_AMOUNT", "quote amount must be greater than zero");
  }
}

/**
 * A provider price normalised into Kaada terms. Adapters build this from provider DTOs; the DTOs
 * themselves never leave the adapter.
 */
export interface FxQuote {
  id: string;
  /** The provider id, matching FxProvider.id and Provider.slug (e.g. "textile"). */
  provider: string;
  input: Money;
  output: Money;
  fee?: Money;
  slippageBps?: number;
  expiresAt?: Date;
  providerQuoteId?: string;
  /** Provider-specific data worth keeping for audit; plain JSON. */
  metadata?: JsonObject;
}

/** A stored, immutable FxQuote snapshot attached to an intent. A new price is a new Quote. */
export interface Quote {
  id: string;
  intentId: string;
  /** The intent revision this price was asked for. A quote is stale once the intent moves on. */
  intentRevision: number;
  providerId: string;
  input: Money;
  output: Money;
  fee?: Money;
  slippageBps?: number;
  providerQuoteId?: string;
  expiresAt?: Date;
  rawProviderData?: JsonObject;
  createdAt: Date;
}
