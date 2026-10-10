import { CELO_CHAIN_ID, KaadaError } from "@kaada/domain";
import type { FxProvider, QuoteRequest, Wallet, WalletRepository } from "@kaada/domain";

import type { AgentRepositories } from "../../src/core/agent/ports.js";
import { PaymentAuthorizationService } from "../../src/core/authorization/payment-authorization-service.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import { AuthorizationPolicyService } from "../../src/core/authorization/policy-service.js";
import type {
  AuthorizationRepositories,
  AuthorizationUnitOfWork,
  PinHasher,
} from "../../src/core/authorization/ports.js";
import { AuthorizationSessionService } from "../../src/core/authorization/session-service.js";
import { WalletFundingResolver } from "../../src/core/routing/funding-resolver.js";
import type { WalletFundingPort } from "../../src/core/routing/funding-resolver.js";
import { Argon2PinHasher } from "../../src/infrastructure/auth/argon2-pin-hasher.js";
import { MockFxProvider } from "../../src/infrastructure/fx/mock-fx-provider.js";
import { intent, SENDER } from "./harness.js";
import { createRoutingHarness } from "./routing-harness.js";
import type { RoutingHarness } from "./routing-harness.js";

/*
 * A complete payment world for tests: the routing harness (MOCK price fixtures: 1 USDT = 5.42 wBRL, so
 * 500 wBRL costs 92.26015 USDT, at most 92.306281 after slippage), a fake wallet, and optionally the
 * real authorization services over in-memory storage. Argon2 runs for real, with a tiny cost.
 */

export const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };
export const USDT = 10n ** 6n;
export const WALLET_ID = "00000000-0000-4000-8000-0000000000aa";
export const WALLET_ADDRESS = "0x00000000000000000000000000000000000000aa";

export class FakePort implements WalletFundingPort {
  address: string | null = WALLET_ADDRESS;
  held = new Map<string, bigint>();
  lookups = 0;
  reads = 0;
  failReads = false;

  activeWallet(): Promise<{ id: string; address: string } | null> {
    this.lookups += 1;
    return Promise.resolve(this.address === null ? null : { id: WALLET_ID, address: this.address });
  }

  balancesOf(_address: string, assetIds: string[]): Promise<Map<string, bigint>> {
    this.reads += 1;
    if (this.failReads) return Promise.reject(new Error("rpc is down"));
    return Promise.resolve(new Map(assetIds.map((id) => [id, this.held.get(id) ?? 0n])));
  }
}

/** Real Argon2id, tiny cost, plus hooks to count checks and to pause one mid-flight. */
export class TestPinHasher implements PinHasher {
  private readonly inner = new Argon2PinHasher({
    params: { memoryCost: 8, timeCost: 1, parallelism: 1 },
  });
  verifyCalls = 0;
  /** When set, every verify waits for it before answering. */
  hold: Promise<void> | undefined;

  hash(pin: string): Promise<string> {
    return this.inner.hash(pin);
  }

  async verify(storedHash: string, pin: string): Promise<boolean> {
    this.verifyCalls += 1;
    const result = await this.inner.verify(storedHash, pin);
    if (this.hold) await this.hold;
    return result;
  }
}

export interface AuthorizationWorld {
  sessions: AuthorizationSessionService;
  payments: PaymentAuthorizationService;
  policy: AuthorizationPolicyService;
  pins: TransactionPinService;
  hasher: TestPinHasher;
  uow: AuthorizationUnitOfWork;
  wallets: Map<string, Wallet>;
}

export interface PaymentWorld {
  r: RoutingHarness;
  port: FakePort;
  /** Every priced pair, as "<input symbol>><output symbol>". */
  priced: string[];
  /** Present when the world was built with authorization. */
  auth: AuthorizationWorld;
  /** Whole tokens (both have 6 decimals). */
  fund(symbol: "USDT" | "USDC", whole: bigint): void;
  /** Issues the secure link for a session and returns its token. */
  token(sessionId: string): Promise<string>;
}

function walletRepository(wallets: Map<string, Wallet>): WalletRepository {
  const unsupported = () => Promise.reject(new Error("not used by the authorization tests"));
  return {
    findById: (id) => Promise.resolve(wallets.get(id) ?? null),
    findEmbedded: unsupported,
    lockUser: unsupported,
    create: unsupported,
    activate: unsupported,
    recordFailure: unsupported,
    setStatus: unsupported,
    setDeployment: unsupported,
    listByUser: unsupported,
  };
}

export function setup(options: { noMakersFrom?: "USDC"; authorize?: boolean } = {}): PaymentWorld {
  const port = new FakePort();
  const priced: string[] = [];
  const holder: { r?: RoutingHarness; auth?: AuthorizationWorld } = {};
  const symbolOf = (id: string): string => {
    const r = holder.r as RoutingHarness;
    const all = [r.h.assets.USDT, r.h.assets.USDC_CELO, ...Object.values(r.tokens)];
    return all.find((asset) => asset.id === id)?.symbol ?? id;
  };

  const r = createRoutingHarness({
    funding: (registry) => new WalletFundingResolver({ wallet: port, assets: registry }),
    ...(options.authorize && {
      authorization: (world, registry, now) => {
        const wallets = new Map<string, Wallet>([
          [
            WALLET_ID,
            {
              id: WALLET_ID,
              userId: SENDER,
              chainId: CELO_CHAIN_ID,
              address: WALLET_ADDRESS,
              isPrimary: true,
              type: "EMBEDDED",
              status: "ACTIVE",
              deployment: "COUNTERFACTUAL",
              createdAt: now(),
              updatedAt: now(),
            },
          ],
        ]);
        const walletRepo = walletRepository(wallets);
        const compose = (repositories: AgentRepositories): AuthorizationRepositories => ({
          ...repositories,
          transactionPins: world.authorization.repositories.transactionPins,
          wallets: walletRepo,
        });
        const uow: AuthorizationUnitOfWork = {
          read: compose(world.repositories),
          transaction: (work) => world.unitOfWork.transaction((tx) => work(compose(tx))),
        };
        const hasher = new TestPinHasher();
        const pins = new TransactionPinService({ unitOfWork: uow, hasher, now });
        const sessions = new AuthorizationSessionService({
          unitOfWork: uow,
          assets: registry,
          pins,
          origin: "https://app.kaada.test",
          sessionTtlMs: 5 * 60_000,
          now,
        });
        const payments = new PaymentAuthorizationService({
          unitOfWork: uow,
          sessions,
          pins,
          authorizationTtlMs: 3 * 60_000,
          now,
        });
        const policy = new AuthorizationPolicyService({ unitOfWork: uow, now });
        holder.auth = { sessions, payments, policy, pins, hasher, uow, wallets };
        return sessions;
      },
    }),
    pricing: ({ assets, now }): FxProvider => {
      const inner = new MockFxProvider({ assets, now, quoteTtlMs: 30_000 });
      return {
        // Priced as the real Textile adapter would be, so an authorization's provider is "textile" and
        // the firm quote (also "textile") can match it. The numbers are still the mock's.
        id: "textile",
        supports: (request: QuoteRequest) => inner.supports(request),
        execute: (quote, context) => inner.execute(quote, context),
        status: (id) => inner.status(id),
        quote: (request: QuoteRequest) => {
          priced.push(`${symbolOf(request.inputAssetId)}>${symbolOf(request.outputAssetId)}`);
          if (options.noMakersFrom && symbolOf(request.inputAssetId) === options.noMakersFrom) {
            return Promise.reject(
              new KaadaError("NO_ROUTE_AVAILABLE", "no quote", {
                details: { providerReason: "no_makers_online" },
              }),
            );
          }
          return inner.quote(request);
        },
      };
    },
  });
  holder.r = r;

  const amount = (
    value: string,
    currencyOrAsset: string,
    mode: "EXACT_INPUT" | "EXACT_OUTPUT",
  ) => ({ value, currencyOrAsset, mode });
  const script = (text: string, extra: Parameters<typeof intent>[0]) =>
    r.h.script.set(text, intent(extra));
  script("pay 500 brl", {
    type: "SEND",
    recipient: joao,
    amount: amount("500", "BRL", "EXACT_OUTPUT"),
  });
  script("pay 500 brl with usdt", {
    type: "SEND",
    recipient: joao,
    amount: amount("500", "BRL", "EXACT_OUTPUT"),
    sourceAsset: "USDT",
  });
  script("spend 20 usdt", {
    type: "SEND",
    recipient: joao,
    amount: amount("20", "USD", "EXACT_INPUT"),
    sourceAsset: "USDT",
  });
  script("spend 20", { type: "SEND", recipient: joao, amount: amount("20", "USD", "EXACT_INPUT") });
  script("make it 40", {
    type: "SEND",
    amount: { value: "40", currencyOrAsset: "USD" },
  });
  script("quote", {
    type: "QUOTE",
    amount: amount("50", "USDT", "EXACT_INPUT"),
    fromAsset: "USDT",
    destination: { country: "BR" },
  });

  const world: PaymentWorld = {
    r,
    port,
    priced,
    get auth() {
      if (!holder.auth) throw new Error("this world was built without authorization");
      return holder.auth;
    },
    fund(symbol, whole) {
      const asset = symbol === "USDT" ? r.h.assets.USDT : r.h.assets.USDC_CELO;
      port.held.set(asset.id, whole * USDT);
    },
    async token(sessionId) {
      return (await world.auth.sessions.issueLink({ sessionId, userId: SENDER })).token;
    },
  };
  return world;
}
