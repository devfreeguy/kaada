/*
 * Manual live check of the Groq interpreter. NOT part of CI: it calls the real Groq API and needs
 * GROQ_API_KEY (from the environment or the repo-root .env). It uses no database and changes nothing;
 * it only prints how each phrase is interpreted.
 *
 * Run: pnpm --filter @kaada/api smoke:groq
 */
import type { AgentIntent } from "@kaada/domain";

import { GroqIntentInterpreter, createGroqSdkTransport } from "../src/infrastructure/llm/index.js";
import type { InterpretationInput } from "../src/core/agent/interpreter.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const apiKey = process.env["GROQ_API_KEY"];
if (!apiKey) {
  console.error("GROQ_API_KEY is not set. Add it to .env or the environment and run again.");
  process.exit(1);
}

const model = process.env["GROQ_MODEL"] || "openai/gpt-oss-20b";
const timeoutMs = Number(process.env["GROQ_TIMEOUT_MS"] || 8000);
const interpreter = new GroqIntentInterpreter(createGroqSdkTransport({ apiKey }), {
  model,
  timeoutMs,
});

const sendWithAmount: AgentIntent = {
  type: "SEND",
  amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
};

interface Case {
  say: string;
  context?: Partial<InterpretationInput>;
}

const cases: Case[] = [
  { say: "Send $20." },
  {
    say: "Daniel.",
    context: {
      activeIntent: sendWithAmount,
      pendingClarification: "RECIPIENT",
      history: [
        { role: "USER", content: "Send $20." },
        { role: "ASSISTANT", content: "Who would you like to send it to?" },
      ],
    },
  },
  {
    say: "Actually make that $40.",
    context: {
      activeIntent: { ...sendWithAmount, recipient: { type: "USERNAME", value: "Daniel" } },
    },
  },
  { say: "Cancel that.", context: { activeIntent: sendWithAmount } },
  { say: "Don't cancel it.", context: { activeIntent: sendWithAmount } },
  { say: "never mind", context: { activeIntent: sendWithAmount } },
  { say: "Start over" },
  { say: "Convert 100 USDT to wBRL." },
  { say: "How much would 50 USDT give me in Brazil?" },
  { say: "Send João exactly R$500" },
  { say: "Send $20 to Daniel in Brazil" },
  { say: "Send 10k naira to @amaka" },
  { say: "Send 20 USDT to 0x1234567890abcdef1234567890abcdef12345678" },
  { say: "Pay him in BRL, 50 dollars, to +5511999999999" },
  { say: "What's my balance?" },
  { say: "Where is my last payment?" },
  { say: "tell me a joke" },
];

console.log(`model=${model} timeoutMs=${timeoutMs}\n`);
for (const { say, context } of cases) {
  const started = Date.now();
  try {
    const result = await interpreter.interpret({
      message: say,
      history: [],
      now: new Date(),
      ...context,
    });
    console.log(`${say}\n  -> ${JSON.stringify(result)}  (${Date.now() - started} ms)\n`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.log(`${say}\n  !! ${detail}  (${Date.now() - started} ms)\n`);
  }
}
