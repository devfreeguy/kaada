import {
  CELO_CHAIN_ID,
  KaadaError,
  bpsOf,
  createId,
  createMoney,
  inputForOutput,
  outputForInput,
} from "@kaada/domain";
import type {
  AssetRegistry,
  FxExecutionContext,
  FxExecutionResult,
  FxExecutionStatus,
  FxProvider,
  FxQuote,
  QuoteRequest,
  Rate,
} from "@kaada/domain";

/*
 * MOCK / TEST / DEVELOPMENT ONLY.
 *
 * Everything in this file is made-up pricing for exercising Kaada's routing engine. The rates, the
 * fee and the slippage are fixtures, NOT market data and NOT Textile's terms. Nothing here calls any
 * network, and nothing priced here may be shown or used as a real price. Configuration refuses to
 * select this provider in production (FX_PROVIDER=mock is rejected when NODE_ENV=production).
 */

/** One directed pair the mock will price. Each direction is its own fixture (spreads differ). */
export interface MockPairFixture {
  /** Asset symbols on Celo. */
  input: string;
  output: string;
  /** Output units per one input unit, both in human units, as an exact rational. */
  rate: Rate;
  /** Fee taken from the input amount, rounded up, in basis points. */
  feeBps: number;
  slippageBps: number;
}

const pair = (
  input: string,
  output: string,
  numerator: bigint,
  denominator: bigint,
  feeBps = 1,
  slippageBps = 5,
): MockPairFixture => ({
  input,
  output,
  rate: { numerator, denominator },
  feeBps,
  slippageBps,
});

/** Fixture rates: invented, with a wider spread on the way back so directions are not symmetric. */
export const MOCK_FX_FIXTURES: readonly MockPairFixture[] = [
  pair("USDT", "wBRL", 542n, 100n),
  pair("wBRL", "USDT", 100n, 550n),
  pair("USDT", "wARS", 1000n, 1n),
  pair("wARS", "USDT", 1n, 1020n),
  pair("USDT", "cNGN", 1500n, 1n),
  pair("cNGN", "USDT", 1n, 1530n),
  pair("USDT", "IDRX", 16000n, 1n),
  pair("IDRX", "USDT", 1n, 16200n),
  pair("USDT", "USDC", 1n, 1n),
  pair("USDC", "USDT", 1n, 1n, 2),
];

export type MockFailureKind = "UNAVAILABLE" | "ERROR";

export interface MockFxProviderOptions {
  assets: AssetRegistry;
  now: () => Date;
  /** Defaults to the fixtures above. */
  fixtures?: readonly MockPairFixture[];
  /** The id this adapter reports (and is stored under). Defaults to "mock-textile". */
  id?: string;
  /** How long a quote stays valid. Default 30 seconds. */
  quoteTtlMs?: number;
  chainId?: number;
}

const BPS = 10_000n;

/**
 * A deterministic RFQ-style provider. EXACT_INPUT spends exactly the requested input and rounds the
 * output DOWN; EXACT_OUTPUT delivers exactly the requested output and rounds the required input UP.
 * All arithmetic is BigInt.
 */
export class MockFxProvider implements FxProvider {
  readonly id: string;
  private readonly assets: AssetRegistry;
  private readonly now: () => Date;
  private readonly fixtures: readonly MockPairFixture[];
  private readonly ttlMs: number;
  private readonly chainId: number;
  private readonly failures = new Map<string, MockFailureKind>();
  /** Every quote request seen, for tests. */
  readonly requests: QuoteRequest[] = [];

  constructor(options: MockFxProviderOptions) {
    this.id = options.id ?? "mock-textile";
    this.assets = options.assets;
    this.now = options.now;
    this.fixtures = options.fixtures ?? MOCK_FX_FIXTURES;
    this.ttlMs = options.quoteTtlMs ?? 30_000;
    this.chainId = options.chainId ?? CELO_CHAIN_ID;
  }

  /** Test control: make quotes for a pair fail (or stop failing with undefined). */
  setFailure(input: string, output: string, kind: MockFailureKind | undefined): void {
    const key = `${input}>${output}`;
    if (kind) this.failures.set(key, kind);
    else this.failures.delete(key);
  }

  async supports(request: QuoteRequest): Promise<boolean> {
    return (await this.fixtureFor(request)) !== undefined;
  }

  async quote(request: QuoteRequest): Promise<FxQuote> {
    this.requests.push(request);
    const resolved = await this.fixtureFor(request);
    if (!resolved) {
      throw new KaadaError("PAIR_NOT_SUPPORTED", "the mock provider has no fixture for this pair");
    }
    const { fixture, input, output } = resolved;
    const failure = this.failures.get(`${fixture.input}>${fixture.output}`);
    if (failure === "UNAVAILABLE") {
      throw new KaadaError(
        "PROVIDER_UNAVAILABLE",
        "mock provider is unavailable (configured failure)",
      );
    }
    if (failure === "ERROR") {
      throw new Error("mock provider failed to price (configured failure)");
    }
    if (request.amount.assetId !== (request.mode === "EXACT_INPUT" ? input.id : output.id)) {
      throw new KaadaError("ASSET_MISMATCH", "amount is not in the fixed side's asset");
    }

    const amount = BigInt(request.amount.amount);
    const feeOf = (gross: bigint) => bpsOf(gross, BigInt(fixture.feeBps), "UP");
    const netOf = (gross: bigint) => gross - feeOf(gross);

    let inputAmount: bigint;
    let outputAmount: bigint;
    if (request.mode === "EXACT_INPUT") {
      inputAmount = amount;
      outputAmount = outputForInput(netOf(amount), fixture.rate, input.decimals, output.decimals);
    } else {
      outputAmount = amount;
      const net = inputForOutput(amount, fixture.rate, input.decimals, output.decimals);
      // Smallest gross whose net (after the rounded-up fee) still covers the required net amount.
      let gross =
        (net * BPS + (BPS - BigInt(fixture.feeBps)) - 1n) / (BPS - BigInt(fixture.feeBps));
      while (netOf(gross) < net) gross += 1n;
      while (gross > 0n && netOf(gross - 1n) >= net) gross -= 1n;
      inputAmount = gross;
    }
    if (inputAmount === 0n || outputAmount === 0n) {
      throw new KaadaError("INVALID_AMOUNT", "amount is too small to price");
    }

    const id = createId();
    return {
      id,
      provider: this.id,
      input: createMoney(inputAmount.toString(), input.id),
      output: createMoney(outputAmount.toString(), output.id),
      fee: createMoney(feeOf(inputAmount).toString(), input.id),
      slippageBps: fixture.slippageBps,
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
      providerQuoteId: `mock-${id}`,
      metadata: { mock: true, label: "MOCK / DEVELOPMENT - not a real price" },
    };
  }

  execute(_quote: FxQuote, _context: FxExecutionContext): Promise<FxExecutionResult> {
    return Promise.reject(
      new KaadaError("EXECUTION_FAILED", "the mock FX provider never executes anything"),
    );
  }

  status(_providerExecutionId: string): Promise<FxExecutionStatus> {
    return Promise.reject(
      new KaadaError("EXECUTION_FAILED", "the mock FX provider never executes anything"),
    );
  }

  private async fixtureFor(request: QuoteRequest) {
    const [input, output] = await Promise.all([
      this.assets.getById(request.inputAssetId),
      this.assets.getById(request.outputAssetId),
    ]);
    if (!input || !output || !input.isActive || !output.isActive) return undefined;
    if (input.chainId !== this.chainId || output.chainId !== this.chainId) return undefined;
    const fixture = this.fixtures.find(
      (candidate) => candidate.input === input.symbol && candidate.output === output.symbol,
    );
    return fixture ? { fixture, input, output } : undefined;
  }
}
