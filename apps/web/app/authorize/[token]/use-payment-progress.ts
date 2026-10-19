"use client";
import { useEffect, useState } from "react";
import type { Outcome } from "./follow-payment";
import { watchFinalPricing } from "./follow-payment";
export function usePaymentProgress(token: string, alreadySent: boolean) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  useEffect(
    () => watchFinalPricing(token, alreadySent, { setOutcome, setUnavailable, setSetupUrl }),
    [token, alreadySent],
  );
  return { outcome, unavailable, setupUrl };
}
