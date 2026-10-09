import { findMissingFields, formatSmallestUnit, isKaadaError, moneyFromHuman } from "@kaada/domain";
import type {
  Asset,
  ConvertIntent,
  CountryDirectory,
  Destination,
  IntentAmountResolved,
  MissingField,
  QuoteIntent,
  ResolvedRecipient,
  SendIntent,
} from "@kaada/domain";

import { describeAsset } from "../assets/asset-resolver.js";
import type { AssetResolver } from "../assets/asset-resolver.js";
import type { RecipientResolver } from "../recipients/recipient-resolver.js";
import type { Clarification } from "../responses/clarifications.js";

export type TransactionalIntent = SendIntent | ConvertIntent | QuoteIntent;

/** Everything the application could establish from an intent. Nothing here is guessed. */
export interface ResolvedFacts {
  /** Canonical amount, present once its currency resolved and the value fits that currency. */
  amount?: IntentAmountResolved;
  sourceAssetId?: string;
  destinationAssetId?: string;
  destinationCountry?: string;
  recipient?: ResolvedRecipient;
  /** Ready-to-show pieces for building messages. */
  display: { amount?: string; recipient?: string };
}

export type Assessment =
  | { status: "READY"; facts: ResolvedFacts }
  | { status: "NEEDS_INFO"; facts: ResolvedFacts; clarifications: Clarification[] };

export interface AssessmentDeps {
  userId: string;
  assets: AssetResolver;
  recipients: RecipientResolver;
  countries: CountryDirectory;
}

const FIELD_PRIORITY: readonly MissingField[] = [
  "AMOUNT",
  "CURRENCY",
  "RECIPIENT",
  "SOURCE_ASSET",
  "DESTINATION_ASSET",
  "DESTINATION",
  "WALLET",
];

function destinationOf(intent: TransactionalIntent): Destination | undefined {
  return intent.type === "CONVERT" ? undefined : intent.destination;
}

function sourceLabelOf(intent: TransactionalIntent): string | undefined {
  return intent.type === "SEND" ? intent.sourceAsset : intent.fromAsset;
}

function destinationLabelOf(intent: TransactionalIntent): string | undefined {
  const destination = destinationOf(intent);
  const declared = destination?.currency ?? destination?.asset;
  if (intent.type === "SEND") return declared;
  return intent.toAsset ?? declared;
}

/**
 * Which side the amount fixes. The speaker's explicit mode always wins. Otherwise: if the amount is
 * in the currency the other party receives, the receiving side is fixed (EXACT_OUTPUT); anything
 * else, including no destination information at all, means the sender spends exactly that amount.
 */
function deriveAmountMode(amountLabel: string, destinationCurrency: string | undefined) {
  const same = destinationCurrency?.trim().toUpperCase() === amountLabel.trim().toUpperCase();
  return same ? "EXACT_OUTPUT" : "EXACT_INPUT";
}

/**
 * Works out what an extracted intent means and what is still needed before routing can start.
 *
 * Human currency versus token: the amount's own label (e.g. "USD") fixes the asset the canonical
 * amount is denominated in. A different asset named for the other side ("pay from USDT") is only
 * validated and left in the parsed intent as a preference for routing; it never overrides the
 * amount's currency, and fiat is never silently turned into a stablecoin.
 */
export async function assessIntent(
  intent: TransactionalIntent,
  deps: AssessmentDeps,
): Promise<Assessment> {
  const operation = intent.type;
  const facts: ResolvedFacts = { display: {} };
  const issues: Clarification[] = [];

  const raise = (issue: Omit<Clarification, "operation">): void => {
    const duplicate = issues.some(
      (existing) =>
        existing.field === issue.field &&
        existing.reason === issue.reason &&
        existing.subject === issue.subject,
    );
    if (!duplicate) issues.push({ operation, ...issue });
  };

  for (const field of findMissingFields(intent)) {
    // A number without a currency is asked about by its value: "What currency is the 20 in?"
    raise({
      field,
      reason: "MISSING",
      ...(field === "CURRENCY" && intent.amount && { subject: intent.amount.value }),
    });
  }

  // Recipient
  if (intent.type === "SEND" && intent.recipient) {
    const resolution = await deps.recipients.resolve(deps.userId, intent.recipient);
    if (resolution.status === "RESOLVED") {
      facts.recipient = resolution.recipient;
      facts.display.recipient = resolution.recipient.displayName ?? intent.recipient.value;
    } else if (resolution.status === "AMBIGUOUS") {
      raise({
        field: "RECIPIENT",
        reason: "AMBIGUOUS",
        subject: intent.recipient.value,
        options: resolution.candidates.map((candidate, index) => ({
          id:
            candidate.recipientId ??
            candidate.linkedUserId ??
            candidate.walletAddress ??
            String(index),
          label: candidate.displayName ?? candidate.reference.value,
        })),
      });
    } else {
      raise({
        field: "RECIPIENT",
        reason: "NOT_FOUND",
        subject: intent.recipient.value,
        ...(resolution.reason !== "NO_MATCH" && { detail: resolution.reason }),
      });
    }
  }

  // Destination country and the amount mode
  const country = destinationOf(intent)?.country ?? facts.recipient?.destinationCountry;
  if (country) facts.destinationCountry = country;

  const sourceLabel = sourceLabelOf(intent);
  const destinationLabel = destinationLabelOf(intent);
  const destinationCurrency =
    destinationLabel ?? (country ? deps.countries.currencyOf(country) : undefined);
  // An amount without a currency cannot be interpreted yet; its question was raised above.
  const amount = intent.amount?.currencyOrAsset ? intent.amount : undefined;
  const amountLabel = amount?.currencyOrAsset;
  const mode =
    amount && amountLabel !== undefined
      ? (amount.mode ?? deriveAmountMode(amountLabel, destinationCurrency))
      : undefined;

  const resolveLabel = async (
    label: string | undefined,
    field: MissingField,
  ): Promise<Asset | undefined> => {
    if (!label) return undefined;
    const result = await deps.assets.resolve(label);
    if (result.status === "RESOLVED") return result.asset;
    if (result.status === "NOT_FOUND") {
      raise({ field, reason: "NOT_FOUND", subject: label });
    } else {
      raise({
        field,
        reason: "AMBIGUOUS",
        subject: label,
        options: result.candidates.map((asset) => ({ id: asset.id, label: describeAsset(asset) })),
      });
    }
    return undefined;
  };

  // Amount: its currency decides the asset it is denominated in
  let amountAsset: Asset | undefined;
  if (amount && amountLabel !== undefined && mode) {
    const field = mode === "EXACT_OUTPUT" ? "DESTINATION_ASSET" : "SOURCE_ASSET";
    amountAsset = await resolveLabel(amountLabel, field);
    if (amountAsset) {
      try {
        const money = moneyFromHuman(amount.value, amountAsset);
        facts.amount = { money, mode };
        facts.display.amount = `${formatSmallestUnit(money.amount, amountAsset.decimals)} ${amountAsset.symbol}`;
      } catch (error) {
        if (!isKaadaError(error, "INVALID_AMOUNT")) throw error;
        raise({
          field: "AMOUNT",
          reason: "INVALID",
          subject: amountAsset.symbol,
          decimals: amountAsset.decimals,
        });
      }
    }
  }

  // The other side: validated, and used as the asset when the amount does not fix that side
  const destinationField: MissingField =
    intent.type === "CONVERT" || (intent.type === "QUOTE" && intent.toAsset)
      ? "DESTINATION_ASSET"
      : "DESTINATION";
  const declaredSource = await resolveLabel(sourceLabel, "SOURCE_ASSET");
  const declaredDestination = await resolveLabel(destinationLabel, destinationField);

  const sourceAssetId = mode === "EXACT_INPUT" ? amountAsset?.id : declaredSource?.id;
  const destinationAssetId =
    mode === "EXACT_OUTPUT"
      ? amountAsset?.id
      : (declaredDestination?.id ?? facts.recipient?.preferredAssetId);
  if (sourceAssetId) facts.sourceAssetId = sourceAssetId;
  if (destinationAssetId) facts.destinationAssetId = destinationAssetId;

  // A SEND needs somewhere to deliver. Many recipients imply it; otherwise the user must say.
  if (intent.type === "SEND" && facts.recipient) {
    const recipient = facts.recipient;
    const implied = Boolean(
      recipient.linkedUserId ??
      recipient.walletAddress ??
      recipient.destinationCountry ??
      recipient.preferredAssetId,
    );
    // With EXACT_OUTPUT the amount's own currency is what the recipient receives.
    const declared = Boolean(country) || Boolean(destinationLabel) || mode === "EXACT_OUTPUT";
    if (!implied && !declared) raise({ field: "DESTINATION", reason: "MISSING" });
  }

  if (issues.length === 0) return { status: "READY", facts };

  const rank = (issue: Clarification) => (issue.reason === "MISSING" ? 1 : 0);
  const clarifications = [...issues].sort(
    (a, b) =>
      rank(a) - rank(b) || FIELD_PRIORITY.indexOf(a.field) - FIELD_PRIORITY.indexOf(b.field),
  );
  return { status: "NEEDS_INFO", facts, clarifications };
}
