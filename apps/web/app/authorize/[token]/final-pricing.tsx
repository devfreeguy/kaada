"use client";
import { primaryAction } from "../../components/application/styles";
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
    <div className="space-y-3">
      <p role="status" className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
        {outcome?.message ??
          (alreadySent ? "Following your payment..." : "Confirming the final price...")}
      </p>
      {setupUrl ? (
        <a href={setupUrl} className={primaryAction}>
          Confirm wallet setup to continue payment
        </a>
      ) : null}
    </div>
  );
}
