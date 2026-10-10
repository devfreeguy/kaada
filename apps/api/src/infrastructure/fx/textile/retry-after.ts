/**
 * Parses a `Retry-After` header given in whole seconds into milliseconds. This is a DURATION, not
 * money: it is the one place in the Textile adapter that converts text to a JavaScript number, and
 * it is kept in its own file so the money-safety scan can hold every other file to BigInt only.
 * The HTTP-date form is not honoured (returns undefined).
 */
export function retryAfterMs(raw: string | null): number | undefined {
  return raw !== null && /^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) * 1000 : undefined;
}
