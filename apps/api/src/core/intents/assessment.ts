import { findMissingFields, formatSmallestUnit, isKaadaError, moneyFromHuman } from "@kaada/domain";
import type {
  Asset,
  CountryDirectory,
  Destination,
  IntentAmountResolved,
  MissingField,
  ResolvedRecipient,
  TransactionalIntent,
} from "@kaada/domain";

import { describeAsset } from "../assets/asset-resolver.js";
import type { AssetResolver } from "../assets/asset-resolver.js";
import type { RecipientResolver } from "../recipients/recipient-resolver.js";
import { MAX_OPTIONS } from "../responses/clarifications.js";
import type { Clarification } from "../responses/clarifications.js";
import type { AssetTarget, ChoiceDraft } from "./choices.js";

export type { TransactionalIntent };

/** Everything the application could establish from an intent. Nothing here is guessed. */
export interface ResolvedFacts {
  /** Canonical amount, present once its currency resolved and the value fits that currency. */
  amount?: IntentAmountResolved;
  sourceAssetId?: string;
  destinationAssetId?: string;
  /** The explicit funding preference ("use USDT"), kept apart from the amount's currency. */
  preferredSourceAssetId?: string;
  destinationCountry?: string;
  recipient?: ResolvedRecipient;
  /** Ready-to-show pieces for building messages. */
  display: {
    amount?: string;
    recipient?: string;
    preferredSource?: string;
    country?: string;
  };
}

export type Assessment =
  | { status: "READY"; facts: ResolvedFacts }
  | { status: "NEEDS_INFO"; facts: ResolvedFacts; clarifications: Clarification[] };

export interface AssessmentDeps {
  userId: string;
  assets: AssetResolver;
  recipients: RecipientResolver;
  countries: CountryDirectory;
  /**
   * A recipient already resolved for this exact reference (reused from the stored intent, or picked
   * from a list of options). When given, the resolver is not asked again.
   */
  resolvedRecipient?: ResolvedRecipient;
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

/** "0x1234...abcd": enough to recognise an address without printing all of it. */
function maskAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

/** How a recipient candidate is shown in a list: a name, plus only a public handle to tell them apart. */
function recipientChoice(candidate: ResolvedRecipient): ChoiceDraft {
  const description = candidate.handle
    ? `@${candidate.handle}`
    : candidate.walletAddress
      ? maskAddress(candidate.walletAddress)
      : undefined;
  return {
    label: candidate.displayName ?? candidate.reference.value,
    ...(description && { description }),
    value: { kind: "RECIPIENT", recipient: candidate },
  };
}

/**
 * Works out what an extracted intent means and what is still needed before routing can start.
 *
 * Human currency versus token: the amount's own label (e.g. "USD") fixes the asset the canonical
 * amount is denominated in, and fiat is never silently turned into a stablecoin. A funding asset the
 * user names for a SEND ("using USDT") is validated and recorded separately as a preference; it never
 * replaces the amount's currency.
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
    const resolution = deps.resolvedRecipient
      ? ({ status: "RESOLVED", recipient: deps.resolvedRecipient } as const)
      : await deps.recipients.resolve(deps.userId, intent.recipient);
    if (resolution.status === "RESOLVED") {
      facts.recipient = resolution.recipient;
      facts.display.recipient = resolution.recipient.displayName ?? intent.recipient.value;
    } else if (resolution.status === "AMBIGUOUS") {
      const tooMany = resolution.candidates.length > MAX_OPTIONS;
      raise({
        field: "RECIPIENT",
        reason: "AMBIGUOUS",
        subject: intent.recipient.value,
        ...(tooMany
          ? { detail: "TOO_MANY" as const }
          : { choices: resolution.candidates.map(recipientChoice) }),
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
  if (country) {
    facts.destinationCountry = country;
    facts.display.country = deps.countries.labelOf(country);
  }

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

  /** Resolves an asset label; an ambiguous one becomes a question with an option per candidate. */
  const resolveLabel = async (
    label: string | undefined,
    field: MissingField,
    target: AssetTarget,
  ): Promise<Asset | undefined> => {
    if (!label) return undefined;
    const result = await deps.assets.resolve(label);
    if (result.status === "RESOLVED") return result.asset;
    if (result.status === "NOT_FOUND") {
      raise({ field, reason: "NOT_FOUND", subject: label });
    } else if (result.candidates.length > MAX_OPTIONS) {
      raise({ field, reason: "AMBIGUOUS", subject: label, detail: "TOO_MANY" });
    } else {
      raise({
        field,
        reason: "AMBIGUOUS",
        subject: label,
        choices: result.candidates.map((asset): ChoiceDraft => ({
          label: describeAsset(asset),
          value: { kind: "ASSET", target, assetId: asset.id },
        })),
      });
    }
    return undefined;
  };

  // Amount: its currency decides the asset it is denominated in
  let amountAsset: Asset | undefined;
  if (amount && amountLabel !== undefined && mode) {
    const field = mode === "EXACT_OUTPUT" ? "DESTINATION_ASSET" : "SOURCE_ASSET";
    amountAsset = await resolveLabel(amountLabel, field, "AMOUNT");
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
  const declaredSource = await resolveLabel(
    sourceLabel,
    "SOURCE_ASSET",
    intent.type === "SEND" ? "SOURCE_PREFERENCE" : "FROM_ASSET",
  );
  const declaredDestination = await resolveLabel(
    destinationLabel,
    destinationField,
    intent.type === "QUOTE" && intent.toAsset
      ? "TO_ASSET"
      : intent.type === "CONVERT"
        ? "TO_ASSET"
        : "DESTINATION",
  );

  // For a SEND, the sender side is whatever the amount is denominated in; a named funding asset is a
  // preference on top of it. For CONVERT and QUOTE the named assets are the operation itself.
  const sourceAssetId =
    mode === "EXACT_INPUT"
      ? amountAsset?.id
      : intent.type === "SEND"
        ? undefined
        : declaredSource?.id;
  const destinationAssetId =
    mode === "EXACT_OUTPUT"
      ? amountAsset?.id
      : (declaredDestination?.id ?? facts.recipient?.preferredAssetId);
  if (sourceAssetId) facts.sourceAssetId = sourceAssetId;
  if (destinationAssetId) facts.destinationAssetId = destinationAssetId;
  if (intent.type === "SEND" && declaredSource && declaredSource.id !== sourceAssetId) {
    facts.preferredSourceAssetId = declaredSource.id;
    facts.display.preferredSource = declaredSource.symbol;
  }

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
