"use client";
import { ActionLink } from "../../components/application/action-button";
import { StatusNote } from "../../components/application/status-note";
import { paymentDoneCopy } from "../../lib/app-copy";
import { usePaymentProgress } from "./use-payment-progress";
export function FinalPricing({
  token,
  alreadySent = false,
}: {
  token: string;
  alreadySent?: boolean;
}) {
  const { outcome, unavailable, setupUrl } = usePaymentProgress(token, alreadySent);
  if (unavailable) return null;
  return (
    <div className="flex flex-col gap-3">
      <StatusNote>
        {outcome?.message ?? (alreadySent ? paymentDoneCopy.following : paymentDoneCopy.pricing)}
      </StatusNote>
      {setupUrl ? <ActionLink href={setupUrl}>Confirm setup to continue</ActionLink> : null}
    </div>
  );
}
