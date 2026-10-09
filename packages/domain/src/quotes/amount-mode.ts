/**
 * Which side of a trade is fixed.
 * - EXACT_INPUT:  "I want to spend exactly $20."
 * - EXACT_OUTPUT: "The recipient must receive exactly R$2,000."
 */
export const AMOUNT_MODES = ["EXACT_INPUT", "EXACT_OUTPUT"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];
