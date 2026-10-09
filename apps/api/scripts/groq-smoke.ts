/*
 * Manual live check of the Groq interpreter. NOT part of CI: it calls the real Groq API and needs
 * GROQ_API_KEY (from the environment or the repo-root .env). It uses no database and changes nothing;
 * it only prints how each phrase is interpreted, with token usage, latency and HTTP attempts.
 *
 * Free-tier Groq allows about 8K tokens per minute, so calls are paced (SMOKE_DELAY_MS, default
 * 7000). Use SMOKE_DELAY_MS=0 on a higher tier. SMOKE_ONLY="text one|text two" runs a subset.
 *
 * Run: pnpm --filter @kaada/api smoke:groq
 */
import type { AgentIntent } from "@kaada/domain";

import type { InterpretationInput } from "../src/core/agent/interpreter.js";
import { GroqIntentInterpreter, createGroqSdkTransport } from "../src/infrastructure/llm/index.js";

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
const delayMs = Number(process.env["SMOKE_DELAY_MS"] ?? 7000);

// Count HTTP attempts per interpretation (the SDK may retry once) without touching the request.
let attempts = 0;
const countingFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  attempts += 1;
  return fetch(url, init);
};

let usage = "";
const interpreter = new GroqIntentInterpreter(
  createGroqSdkTransport({ apiKey, fetch: countingFetch }),
  {
    model,
    timeoutMs,
    log: (_level, _event, fields) => {
      usage = `tokens prompt=${fields["promptTokens"] ?? "-"} completion=${fields["completionTokens"] ?? "-"}`;
    },
  },
);

const sendWithAmount: AgentIntent = {
  type: "SEND",
  amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
};

interface Case {
  say: string;
  context?: Partial<InterpretationInput>;
}

const cases: Case[] = [
  { say: "Send $20 to Daniel in Brazil." },
  { say: "Send Daniel twenty dollars." },
  { say: "Send João exactly R$500." },
  { say: "Send 10k naira to Daniel." },
  { say: "Send 2.5k BRL to João." },
  { say: "Convert 100 USDT to wBRL." },
  { say: "Convert $50 to Brazilian reais." },
  { say: "How much would 50 USDT give me in Brazil?" },
  { say: "Pay Daniel in Argentina." },
  { say: "Send 20 to Daniel." },
  { say: "What's my balance?" },
  { say: "Where is my last payment?" },
  { say: "Cancel that.", context: { activeIntent: sendWithAmount } },
  { say: "Don't cancel it.", context: { activeIntent: sendWithAmount } },
  { say: "Start over." },
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
  {
    say: "dollars",
    context: {
      activeIntent: {
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "20" },
      },
      pendingClarification: "CURRENCY",
      history: [
        { role: "USER", content: "Send 20 to Daniel." },
        { role: "ASSISTANT", content: "What currency is the 20 in?" },
      ],
    },
  },
  // Build 6 corrections and negations (a short regression set; run with SMOKE_ONLY).
  {
    say: "Use USDT.",
    context: {
      activeIntent: { ...sendWithAmount, recipient: { type: "USERNAME", value: "Daniel" } },
    },
  },
  {
    say: "No, use USDC.",
    context: {
      activeIntent: {
        ...sendWithAmount,
        recipient: { type: "USERNAME", value: "Daniel" },
        sourceAsset: "USDT",
      },
    },
  },
  {
    say: "Don't use USDT.",
    context: {
      activeIntent: {
        ...sendWithAmount,
        recipient: { type: "USERNAME", value: "Daniel" },
        sourceAsset: "USDT",
      },
    },
  },
  {
    say: "Not Daniel, João.",
    context: {
      activeIntent: { ...sendWithAmount, recipient: { type: "USERNAME", value: "Daniel" } },
    },
  },
  { say: "Send 20 USDT to 0x1234567890abcdef1234567890abcdef12345678." },
  { say: "tell me a joke" },
];

const only = process.env["SMOKE_ONLY"]?.split("|").map((text) => text.trim());
const selected = only ? cases.filter((c) => only.includes(c.say)) : cases;

console.log(`model=${model} timeoutMs=${timeoutMs} delayMs=${delayMs} cases=${selected.length}\n`);
for (const [index, { say, context }] of selected.entries()) {
  if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  attempts = 0;
  usage = "";
  const started = Date.now();
  try {
    const result = await interpreter.interpret({
      message: say,
      history: [],
      now: new Date(),
      ...context,
    });
    console.log(
      `${say}\n  -> ${JSON.stringify(result)}\n     ${Date.now() - started} ms, ${attempts} HTTP attempt(s), ${usage}\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.log(
      `${say}\n  !! ${detail}\n     ${Date.now() - started} ms, ${attempts} HTTP attempt(s)\n`,
    );
  }
}
