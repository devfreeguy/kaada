import { createId } from "@kaada/domain";
import type { Asset, Interpretation } from "@kaada/domain";

import { AgentService } from "../../src/core/agent/agent-service.js";
import type { AgentTurnResult } from "../../src/core/agent/agent-service.js";
import { MockIntentInterpreter } from "../../src/core/agent/mock-interpreter.js";
import type { InterpretationInput } from "../../src/core/agent/interpreter.js";
import type { AgentLog } from "../../src/core/agent/ports.js";
import { createInMemoryWorld } from "./in-memory.js";
import type { InMemoryWorld } from "./in-memory.js";

export const SENDER = "00000000-0000-4000-8000-000000000001";

const fiat = (symbol: string, name: string, countryCode: string): Asset => ({
  id: createId(),
  symbol,
  name,
  kind: "FIAT",
  decimals: 2,
  fiatCode: symbol,
  countryCode,
  isActive: true,
});

const token = (symbol: string, chainId: number, contractAddress: string): Asset => ({
  id: createId(),
  symbol,
  name: symbol,
  kind: "USD_STABLECOIN",
  decimals: 6,
  chainId,
  contractAddress,
  isActive: true,
});

export interface Harness {
  world: InMemoryWorld;
  assets: Record<"USD" | "NGN" | "BRL" | "ARS" | "USDT" | "USDC_CELO" | "USDC_OTHER", Asset>;
  interpreter: MockIntentInterpreter;
  /** Interpretations to return, keyed by the exact message text. */
  script: Map<string, Interpretation>;
  /** Calls observed on the interpreter along with whether a transaction was open at that time. */
  openTransactionDuringInterpret: boolean[];
  logs: { level: string; event: string; fields: Record<string, unknown> }[];
  agent: AgentService;
  say(
    content: string,
    options?: { externalMessageId?: string; externalConversationId?: string; userId?: string },
  ): Promise<AgentTurnResult>;
}

/** A ready-to-use world: seeded assets, a sender, and an interpreter driven by `script`. */
export function createHarness(
  options: { delayMs?: (input: InterpretationInput) => number } = {},
): Harness {
  const world = createInMemoryWorld();
  const assets = {
    USD: fiat("USD", "US Dollar", "US"),
    NGN: fiat("NGN", "Nigerian Naira", "NG"),
    BRL: fiat("BRL", "Brazilian Real", "BR"),
    ARS: fiat("ARS", "Argentine Peso", "AR"),
    USDT: token("USDT", 42220, "0xusdt"),
    USDC_CELO: token("USDC", 42220, "0xusdc-celo"),
    USDC_OTHER: token("USDC", 1, "0xusdc-other"),
  };
  for (const asset of Object.values(assets)) world.addAsset(asset);
  world.addUser({ id: SENDER, username: "sender" });

  const script = new Map<string, Interpretation>();
  const openTransactionDuringInterpret: boolean[] = [];
  const interpreter = new MockIntentInterpreter(async (input) => {
    openTransactionDuringInterpret.push(world.inTransaction);
    const delay = options.delayMs?.(input) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return script.get(input.message) ?? { kind: "INTENT", intent: { type: "UNKNOWN" } };
  });

  const logs: Harness["logs"] = [];
  const log: AgentLog = (level, event, fields) => void logs.push({ level, event, fields });

  const agent = new AgentService({ unitOfWork: world.unitOfWork, interpreter, log });
  let chat = 0;
  const defaultChat = `chat-${++chat}`;

  return {
    world,
    assets,
    interpreter,
    script,
    openTransactionDuringInterpret,
    logs,
    agent,
    say: (content, opts = {}) =>
      agent.handleMessage({
        userId: opts.userId ?? SENDER,
        channel: "TELEGRAM",
        externalConversationId: opts.externalConversationId ?? defaultChat,
        content,
        ...(opts.externalMessageId && { externalMessageId: opts.externalMessageId }),
      }),
  };
}

/** Shorthand for the most common scripted reading: an intent. */
export const intent = (
  value: Extract<Interpretation, { kind: "INTENT" }>["intent"],
): Interpretation => ({
  kind: "INTENT",
  intent: value,
});
