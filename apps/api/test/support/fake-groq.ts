import type {
  GroqChatRequest,
  GroqChatResult,
  GroqTransport,
} from "../../src/infrastructure/llm/groq-transport.js";
import type { WireInterpretation } from "../../src/infrastructure/llm/intent-wire.js";

/** A complete wire object: every field present, unspecified ones null (what strict mode produces). */
export function wire(
  fields: Partial<WireInterpretation> & Pick<WireInterpretation, "type">,
): string {
  const full: WireInterpretation = {
    recipient: null,
    amount: null,
    sourceAsset: null,
    fromAsset: null,
    toAsset: null,
    asset: null,
    reference: null,
    topic: null,
    reason: null,
    destination: null,
    constraints: null,
    ...fields,
  };
  return JSON.stringify(full);
}

export const amount = (
  value: string,
  currencyOrAsset: string,
  mode: "EXACT_INPUT" | "EXACT_OUTPUT" | null = null,
) => ({ value, currencyOrAsset, mode });

export const destination = (fields: { country?: string; currency?: string; asset?: string }) => ({
  country: fields.country ?? null,
  currency: fields.currency ?? null,
  asset: fields.asset ?? null,
});

type Reply = string | null | Error;

/** The message the prompt carries, recovered from its JSON-quoted line. */
export function latestMessage(request: GroqChatRequest): string {
  const line = request.user.split("\n").find((l) => l.startsWith("Latest user message: ")) ?? "";
  return JSON.parse(line.slice("Latest user message: ".length)) as string;
}

/** A scripted stand-in for Groq. It records every request and never touches the network. */
export class FakeGroqTransport implements GroqTransport {
  readonly calls: GroqChatRequest[] = [];

  constructor(private readonly respond: (request: GroqChatRequest, index: number) => Reply) {}

  /** Replies by the latest user message; anything unlisted is an UNKNOWN intent. */
  static byMessage(script: Record<string, Reply>): FakeGroqTransport {
    return new FakeGroqTransport(
      (request) => script[latestMessage(request)] ?? wire({ type: "UNKNOWN" }),
    );
  }

  chat(request: GroqChatRequest): Promise<GroqChatResult> {
    const index = this.calls.length;
    this.calls.push(request);
    const reply = this.respond(request, index);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      content: reply,
      model: request.model,
      usage: { promptTokens: 400, completionTokens: 40, totalTokens: 440 },
    });
  }
}
