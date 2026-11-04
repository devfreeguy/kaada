import { AsyncLocalStorage } from "node:async_hooks";

/*
 * A per-request collector for the structured log events the application ALREADY emits.
 *
 * It adds no new instrumentation of its own: the services keep logging exactly what they logged before, and this simply tees
 * those events into the request that caused them, so a developer can see the execution trace of one turn. Outside a collected
 * request it does nothing at all, so production behaviour is unchanged.
 *
 * Only the development playground reads it. Values are redacted here as well as at the edge, so a field that should never be
 * shown cannot reach a browser even if some future log line includes it.
 */

export interface TraceEvent {
  level: "info" | "warn" | "error";
  event: string;
  /** Milliseconds since the collection began, so the stages of a turn can be read in order. */
  atMs: number;
  fields: Record<string, unknown>;
}

interface Collector {
  startedAt: number;
  events: TraceEvent[];
  /**
   * True only inside a development playground turn. It is set by the playground controller, which exists only when
   * AGENT_PLAYGROUND is on, and that flag is refused in production. A Telegram turn never establishes this context, so
   * `playgroundTurn()` is false for every real request and production behaviour cannot change.
   */
  playground: boolean;
}

const storage = new AsyncLocalStorage<Collector>();

/**
 * Whether the work running right now belongs to a development playground turn. Used at the ONE place that would otherwise
 * reach for a wallet (RoutingService.plan), so a payment can be understood and priced without any wallet, signing or
 * execution service being involved.
 */
export function playgroundTurn(): boolean {
  return storage.getStore()?.playground === true;
}

/**
 * Field names that must never leave the server, whatever a log line contains. Matched case-insensitively on the whole name,
 * so `botToken`, `apiKey` and `pinHash` are all caught.
 */
// `recovery` and `backup` are here rather than a bare `code`, because an error code ("WALLET_SETUP_REQUIRED") is exactly the
// kind of thing a developer needs to see, while a recovery code is exactly the kind they must never be shown.
const SECRET_FIELD =
  /(secret|token|key|pin|password|credential|seed|mnemonic|signature|cookie|authorization|session|recovery|backup|totp|otp)/i;

/** Field names that are safe despite matching the pattern above: they are identifiers, not credentials. */
const ALLOWED_FIELD = new Set([
  "authorizationsessionid",
  "sessionid",
  "tokens",
  "promptTokens".toLowerCase(),
  "completionTokens".toLowerCase(),
  "totalTokens".toLowerCase(),
]);

const MAX_EVENTS = 200;
const MAX_STRING = 600;

/** One field, made safe to show: secrets replaced, long values clipped, structures kept. */
function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") return redactFields(value as Record<string, unknown>, depth + 1);
  // Anything left is a symbol or a function: name the kind rather than stringify it.
  return `[${typeof value}]`;
}

export function redactFields(
  fields: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    const lower = name.toLowerCase();
    safe[name] =
      SECRET_FIELD.test(lower) && !ALLOWED_FIELD.has(lower)
        ? "[redacted]"
        : redactValue(value, depth);
  }
  return safe;
}

/** Records an event against the request being collected, if any. A no-op everywhere else. */
export function recordTrace(
  level: TraceEvent["level"],
  event: string,
  fields: Record<string, unknown>,
): void {
  const collector = storage.getStore();
  if (!collector || collector.events.length >= MAX_EVENTS) return;
  collector.events.push({
    level,
    event,
    atMs: Date.now() - collector.startedAt,
    fields: redactFields(fields),
  });
}

/** Runs `work`, collecting every traced event it causes, and returns the events with the result. */
export async function collectTrace<T>(
  work: () => Promise<T>,
  options: { playground?: boolean } = {},
): Promise<{ result: T; events: TraceEvent[] }> {
  const collector: Collector = {
    startedAt: Date.now(),
    events: [],
    playground: options.playground === true,
  };
  const result = await storage.run(collector, work);
  return { result, events: collector.events };
}
