import { formatSmallestUnit } from "@kaada/domain";

/** "92.250000" -> "92.25", "500.000000000000000000" -> "500". For people only. */
export function formatAmount(amount: string, decimals: number): string {
  const exact = formatSmallestUnit(amount, decimals);
  return exact.includes(".") ? exact.replace(/\.?0+$/, "") : exact;
}
