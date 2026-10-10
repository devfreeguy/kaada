import { randomBytes } from "node:crypto";

import type { DelegatedPermission, PaymentAuthorization } from "@kaada/domain";
import { SENDER } from "./harness.js";

import { AccountReadinessService } from "../../src/core/execution/account-readiness.js";
import { FirmQuoteService } from "../../src/core/execution/firm-quote-service.js";
import { ExecutionPreparationService } from "../../src/core/execution/preparation-service.js";
import type { ExecutionRepositories, ExecutionUnitOfWork } from "../../src/core/execution/ports.js";
import { PreparationTracker } from "../../src/core/execution/tracker.js";
import {
  TextileClient,
  TextileFirmQuoteProvider,
} from "../../src/infrastructure/fx/textile/index.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";
import { createFirmStores } from "./firm-memory.js";
import { FakeTextileTransport } from "./textile-fixtures.js";
import type { RecordedCall, Reply } from "./textile-fixtures.js";
import { WALLET_ADDRESS, WALLET_ID, setup } from "./payment-world.js";
import type { PaymentWorld } from "./payment-world.js";

/*
 * A firm-quote world for tests: the Build 11 payment world with a PIN-authorized payment, plus the
 * firm services over in-memory storage and a scripted Textile transport. NOTHING here reaches a
 * network, a chain or a signer. Token and wallet addresses are test values.
 */

export const PIN = "7351";
export const USDT_ADDRESS = `0x${"11".repeat(20)}`;
export const WBRL_ADDRESS = `0x${"22".repeat(20)}`;
export const REACTOR = `0x${"33".repeat(20)}`;
export const SWAP_TARGET = `0x${"44".repeat(20)}`;
export const SECRET_KEY = randomBytes(32).toString("base64");
export const CLAIM_TOKEN = "rfqc_TEST_CLAIM_TOKEN_must_never_leak_0123456789";

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

/** ERC-20 `approve(spender, amount)` calldata. */
export function approveCalldata(spender: string, amount: bigint): string {
  return `0x095ea7b3${word(spender)}${word(amount.toString(16))}`;
}

export interface QuotedOptions {
  rfqId?: string;
  sellAmount: string;
  buyAmount: string;
  takerPays?: string;
  feeAmount?: string;
  taker?: string;
  expiresInMs?: number;
  /** Calldata amount of the unsigned approval (defaults to takerPays). */
  approvalAmount?: bigint;
  approvalTo?: string;
  approvalValue?: string;
  swapValue?: string;
  chainId?: number;
  spender?: string;
  now: Date;
}

/** A documented-shape firm response (made-up numbers; NOT a captured live response). */
export function quotedReply(o: QuotedOptions): Reply {
  const takerPays = o.takerPays ?? o.sellAmount;
  const expires = new Date(o.now.getTime() + (o.expiresInMs ?? 60_000));
  const chainId = o.chainId ?? 42220;
  return {
    status: 200,
    body: {
      data: {
        status: "quoted",
        rfqId: o.rfqId ?? "rfq_test_1",
        claimToken: CLAIM_TOKEN,
        quote: {
          sellAmount: o.sellAmount,
          buyAmount: o.buyAmount,
          feeAmount: o.feeAmount ?? "9227",
          takerPays,
          rateRay: "1",
          expiresAt: expires.toISOString(),
          orderDeadline: new Date(expires.getTime() + 30_000).toISOString(),
          latestOrderDeadline: new Date(expires.getTime() + 120_000).toISOString(),
          reactor: REACTOR,
          ...(o.spender && { spender: o.spender }),
          taker: o.taker ?? WALLET_ADDRESS,
          encodedOrder: "0xabc",
          signature: "0xdef",
        },
        transactions: {
          approval: {
            to: o.approvalTo ?? USDT_ADDRESS,
            data: approveCalldata(o.spender ?? REACTOR, o.approvalAmount ?? BigInt(takerPays)),
            value: o.approvalValue ?? "0",
            chainId,
          },
          swap: { to: SWAP_TARGET, data: "0xdeadbeef", value: o.swapValue ?? "0", chainId },
        },
      },
    },
  };
}

export const noQuoteReply: Reply = {
  status: 200,
  body: { data: { status: "no_quote", reason: "no_makers_online" } },
};

export interface FirmWorld {
  w: PaymentWorld;
  transport: FakeTextileTransport;
  firm: ReturnType<typeof createFirmStores>;
  authorization: PaymentAuthorization;
  /** The authorization link token (the PIN session is spent). */
  token: string;
  service: ExecutionPreparationService;
  firmQuotes: FirmQuoteService;
  tracker: PreparationTracker;
  logs: { level: string; event: string; fields: Record<string, unknown> }[];
  /** Mutable chain state the read-only fakes serve. */
  chain: { allowance: bigint; deployed: boolean };
  permissions: DelegatedPermission[];
  credentials: { length: number };
  bundler: { configured: boolean };
  calls(): RecordedCall[];
  now(): Date;
}

/** Builds a world with one ACTIVE authorization for the given text ("pay 500 brl with usdt" etc.). */
export async function firmWorld(
  options: {
    text?: "pay 500 brl with usdt" | "spend 20 usdt" | "pay 500 brl";
    replies?: Reply[];
    maxOutstanding?: number;
    minWindowMs?: number;
    held?: number;
    /** Fund only USDC, so the cheapest route is the two-hop USDC -> USDT -> wBRL one. */
    usdcOnly?: boolean;
  } = {},
): Promise<FirmWorld> {
  const w = setup({ authorize: true });
  if (!options.usdcOnly) w.fund("USDT", 500n);
  w.fund("USDC", 500n);
  // Real-looking token addresses (the base fixtures use short placeholders).
  w.r.h.assets.USDT.contractAddress = USDT_ADDRESS;
  w.r.tokens.wBRL.contractAddress = WBRL_ADDRESS;
  await w.auth.pins.setPin(SENDER, PIN);

  const turn = await w.r.h.say(options.text ?? "pay 500 brl with usdt");
  if (turn.response.type !== "AUTHORIZATION_REQUIRED") {
    throw new Error(`expected AUTHORIZATION_REQUIRED, got ${JSON.stringify(turn.response)}`);
  }
  const token = await w.token(turn.response.authorizationSessionId);
  const result = await w.auth.payments.authorize(token, PIN);
  if (result.status !== "AUTHORIZED") throw new Error(`PIN was not accepted: ${result.status}`);
  const authorization = result.authorization;

  const transport = new FakeTextileTransport(options.replies ?? []);
  const client = new TextileClient({
    transport,
    timeoutMs: 8000,
    sleep: () => Promise.resolve(),
  });
  const logs: FirmWorld["logs"] = [];
  const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) =>
    void logs.push({ level, event, fields });
  const provider = new TextileFirmQuoteProvider({ client, timeoutMs: 75_000, log });
  const cipher = new AesGcmSecretCipher([{ version: 1, key: SECRET_KEY }]);
  const firm = createFirmStores();

  const chain = { allowance: 0n, deployed: false };
  const permissions: DelegatedPermission[] = [];
  const credentials = { length: 1 };
  const bundler = { configured: false };
  const now = () => w.r.clock.now;

  const compose = (repositories: typeof w.r.world.repositories): ExecutionRepositories =>
    ({
      ...repositories,
      wallets: w.auth.uow.read.wallets,
      passkeys: {
        listActiveForUser: () => Promise.resolve(Array.from({ length: credentials.length })),
      },
      delegatedPermissions: { listForWallet: () => Promise.resolve(permissions) },
      ...firm.repositories,
    }) as unknown as ExecutionRepositories;
  const uow: ExecutionUnitOfWork = {
    read: compose(w.r.world.repositories),
    transaction: (work) => w.r.world.unitOfWork.transaction((tx) => work(compose(tx))),
  };
  // Held slots can be pre-loaded to test Kaada's own count.
  for (let i = 0; i < (options.held ?? 0); i += 1) {
    firm.attempts.push({
      id: `00000000-0000-4000-8000-00000000${String(i).padStart(4, "0")}`,
      paymentAuthorizationId: `held-${i}`,
      userId: SENDER,
      walletId: WALLET_ID,
      providerId: (await w.r.world.repositories.providers.findBySlug("textile"))?.id ?? "",
      status: "REQUESTING",
      idempotencyKey: `held-${i}`,
      amountMode: "EXACT_OUTPUT",
      exactAmount:
        authorization.bounds.mode === "EXACT_OUTPUT"
          ? authorization.bounds.exactOutput
          : authorization.bounds.authorizedInput,
      takerAddress: WALLET_ADDRESS,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  const chainState = {
    allowances: { readAllowance: () => Promise.resolve(chain.allowance) },
    balances: { balancesOf: (a: string, ids: string[]) => w.port.balancesOf(a, ids) },
    isDeployed: () => Promise.resolve(chain.deployed),
  };
  const firmQuotes = new FirmQuoteService({
    unitOfWork: uow,
    provider,
    cipher,
    chain: chainState,
    maxOutstanding: options.maxOutstanding ?? 4,
    requestTimeoutMs: 75_000,
    now,
    log,
  });
  const service = new ExecutionPreparationService({
    unitOfWork: uow,
    firmQuotes,
    policy: w.auth.policy,
    readiness: new AccountReadinessService({
      repositories: uow.read,
      chain: chainState,
      get infrastructure() {
        return { rpcConfigured: true, bundlerConfigured: bundler.configured };
      },
    }),
    chain: chainState,
    wallets: {
      getWallet: (userId) => {
        const wallet = [...w.auth.wallets.values()].find((x) => x.userId === userId);
        return Promise.resolve(wallet ?? null);
      },
    },
    minWindowMs: options.minWindowMs ?? 12_000,
    now,
    log,
  });

  return {
    w,
    transport,
    firm,
    authorization,
    token,
    service,
    firmQuotes,
    tracker: new PreparationTracker(),
    logs,
    chain,
    permissions,
    credentials,
    bundler,
    calls: () => transport.calls,
    now,
  };
}
