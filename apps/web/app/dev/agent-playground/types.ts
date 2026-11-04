/** The shapes the playground API returns. They mirror the API's own types; nothing is interpreted in the browser. */

export interface OutboundAction {
  type: "OPEN_URL" | "COPY_TEXT" | "ACTION";
  label: string;
  description?: string;
  /** ACTION only: the opaque handle to send back, exactly as Telegram's callback_data carries it. */
  handle?: string;
  /** OPEN_URL only. The playground never opens these: they lead to real pages. */
  url?: string;
  semantic?: string;
}

export interface OutboundMessage {
  text: string;
  actions?: OutboundAction[];
  code?: string[];
}

export interface TraceEvent {
  level: "info" | "warn" | "error";
  event: string;
  atMs: number;
  fields: Record<string, unknown>;
}

export interface StoredIntentView {
  id: string;
  type: string;
  status: string;
  revision: number;
  missingFields: string[];
  parsed: unknown;
  amount: unknown;
  sourceAssetId?: string;
  destinationAssetId?: string;
  preferredSourceAssetId?: string;
  destinationCountry?: string;
  recipientId?: string;
}

export interface SimulatedExecutionIntent {
  intent: string;
  executionMode: "simulation";
  intentId: string;
  revision: number;
  recipient?: string;
  sourceCurrency?: string;
  targetCurrency?: string;
  amountMode?: string;
  operations: { type: string; from?: string; to?: string; currency?: string; recipient?: string }[];
  note?: string;
}

export interface PlaygroundTurn {
  messages: OutboundMessage[];
  responses: unknown[];
  intent: StoredIntentView | null;
  focus: unknown;
  simulated: SimulatedExecutionIntent | null;
  simulationNote: string | null;
  trace: TraceEvent[];
  elapsedMs: number;
  result: string;
}

export interface PlaygroundSession {
  sessionId: string;
  conversationId: string;
  executionMode: "simulation";
}

/** One line of the transcript, as the page shows it. */
export interface Entry {
  id: string;
  /** "you" is what was typed or pressed; "kaada" is what the agent answered; "system" is the playground itself. */
  from: "you" | "kaada" | "system";
  text: string;
  actions?: OutboundAction[];
  /** The turn this line belongs to, so the debug panel can follow the transcript. */
  turn?: PlaygroundTurn;
}
