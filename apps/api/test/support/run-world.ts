import { createHash, randomBytes } from "node:crypto";

import { KaadaError, SecretValue, createId } from "@kaada/domain";
import type {
  AccountCall,
  KernelExecutionPort,
  OperationReceipt,
  PasskeyVerifier,
  PermissionScope,
  ProviderOrderPort,
  ProviderOrderStatus,
} from "@kaada/domain";

import { ExecutionRunner } from "../../src/core/execution/runner.js";
import { RootActionService } from "../../src/core/execution/root-action-service.js";
import { ValidatedExecutionSigner } from "../../src/core/execution/validated-signer.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";
import { firmWorld, quotedReply, SECRET_KEY } from "./firm-world.js";
import type { FirmWorld } from "./firm-world.js";
import { WALLET_ADDRESS } from "./payment-world.js";

/*
 * A run world: the firm world (a PIN-authorized, planned payment) plus a scripted Kernel/bundler and a
 * scripted provider order API. Nothing reaches a chain or a network; every irreversible call lands in
 * the recorded lists below so tests can assert exactly what would have been sent.
 */

const hash = (seed: string) => `0x${createHash("sha256").update(seed).digest("hex")}`;

export class FakeKernel implements KernelExecutionPort {
  /** Everything the wallet "holds": native CELO for gas, in wei. */
  native = 10n ** 18n;
  /** Session key addresses whose permission reads back as installed. */
  installed = new Set<string>();
  /** The passkey-signed enable data the fake hands back. */
  readonly approvalText = "FAKE-ENABLE-DATA-must-never-leak";
  rootSends = 0;
  prepared: PermissionScope[] = [];
  delegated: { calls: AccountCall[]; hash: string }[] = [];
  sessionKeys: string[] = [];
  /** How the next sends behave. */
  sendMode: "ok" | "reject" | "throw" = "ok";
  /** How the receipt lookups behave. */
  receiptMode: "included" | "pending" | "throw" | "revert" = "included";
  /** Receipts the test pins per user operation hash. */
  receipts = new Map<string, OperationReceipt>();
  constructor(private readonly world: FirmWorld) {}

  isDeployed(): Promise<boolean> {
    return Promise.resolve(this.world.chain.deployed);
  }
  nativeBalance(): Promise<bigint> {
    return Promise.resolve(this.native);
  }
  prepareRootOperation(input: {
    permission?: { scope: PermissionScope };
  }): ReturnType<KernelExecutionPort["prepareRootOperation"]> {
    if (input.permission) this.prepared.push(input.permission.scope);
    const key = `0x${randomBytes(32).toString("hex")}`;
    const address = `0x${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    this.sessionKeys.push(address);
    return Promise.resolve({
      challenge: hash(`challenge:${key}`),
      prepared: { kind: "root", sessionKeyAddress: address },
      sessionKey: { address, privateKey: new SecretValue(key) },
    });
  }
  sendRootOperation(input: {
    prepared: { sessionKeyAddress?: unknown };
  }): ReturnType<KernelExecutionPort["sendRootOperation"]> {
    if (this.sendMode === "reject") {
      return Promise.reject(
        new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation"),
      );
    }
    this.rootSends += 1;
    const address = String(input.prepared.sessionKeyAddress);
    this.world.chain.deployed = true;
    this.installed.add(address);
    return Promise.resolve({
      userOpHash: hash(`root:${this.rootSends}`),
      approval: new SecretValue(this.approvalText),
    });
  }
  /** Every scope the runner asked about, to check what a read-back is made of. */
  readBacks: PermissionScope[] = [];
  isPermissionInstalled(input: {
    sessionKeyAddress: string;
    scope: PermissionScope;
  }): Promise<boolean> {
    this.readBacks.push(input.scope);
    return Promise.resolve(this.installed.has(input.sessionKeyAddress));
  }
  sendDelegatedCalls(input: {
    calls: AccountCall[];
  }): ReturnType<KernelExecutionPort["sendDelegatedCalls"]> {
    if (this.sendMode === "reject") {
      return Promise.reject(
        new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation"),
      );
    }
    const userOpHash = hash(`delegated:${this.delegated.length + 1}`);
    this.delegated.push({ calls: input.calls, hash: userOpHash });
    if (this.sendMode === "throw") return Promise.reject(new Error("socket closed after sending"));
    // An approval changes what the chain shows, like a real one would once included.
    for (const call of input.calls) {
      if (call.data.startsWith("0x095ea7b3")) {
        this.world.chain.allowance = BigInt(`0x${call.data.slice(-64)}`);
      }
    }
    return Promise.resolve({ userOpHash });
  }
  getUserOperationReceipt(userOpHash: string): Promise<OperationReceipt> {
    const pinned = this.receipts.get(userOpHash);
    if (pinned) return Promise.resolve(pinned);
    // The receipt knobs shape payment steps only; the wallet-setup operation is always included.
    const isPaymentStep = this.delegated.some((d) => d.hash === userOpHash);
    if (!isPaymentStep) {
      return Promise.resolve({
        status: "INCLUDED",
        success: true,
        txHash: hash(`tx:${userOpHash}`),
        blockNumber: "999",
      });
    }
    if (this.receiptMode === "throw") return Promise.reject(new Error("rpc unavailable"));
    if (this.receiptMode === "pending") return Promise.resolve({ status: "PENDING" });
    return Promise.resolve({
      status: "INCLUDED",
      success: this.receiptMode === "included",
      txHash: hash(`tx:${userOpHash}`),
      blockNumber: "1000",
    });
  }
  getTransactionReceipt(): ReturnType<KernelExecutionPort["getTransactionReceipt"]> {
    return Promise.resolve({ status: "SUCCESS" });
  }
}

export class FakeOrders implements ProviderOrderPort {
  readonly id = "textile";
  submits: { providerQuoteId: string; claim: string; txHash: string }[] = [];
  statuses = 0;
  /** What the provider says about the order. */
  result: ProviderOrderStatus = { state: "FILLED" };
  submitFails = false;
  statusFails = false;

  submit(input: {
    providerQuoteId: string;
    claimToken: SecretValue;
    txHash: string;
  }): Promise<ProviderOrderStatus> {
    if (this.submitFails) return Promise.reject(new Error("provider unavailable"));
    this.submits.push({
      providerQuoteId: input.providerQuoteId,
      claim: input.claimToken.reveal(),
      txHash: input.txHash,
    });
    return Promise.resolve({ state: "SUBMITTED" });
  }
  status(): Promise<ProviderOrderStatus> {
    this.statuses += 1;
    if (this.statusFails) return Promise.reject(new Error("provider unavailable"));
    return Promise.resolve(this.result);
  }
}

export const verifier: PasskeyVerifier = {
  verifyRegistration: () => Promise.resolve(null),
  verifyAuthentication: (input) =>
    Promise.resolve(
      (input.response as { good?: boolean } | null)?.good ? { newSignCount: 1 } : null,
    ),
};

export interface RunWorld extends FirmWorld {
  kernel: FakeKernel;
  orders: FakeOrders;
  runner: ExecutionRunner;
  signer: ValidatedExecutionSigner;
  rootActions: RootActionService;
  cipher: AesGcmSecretCipher;
  executionId: string;
  /** Completes the pending root action as the user's passkey would. */
  confirmRootAction(good?: boolean): Promise<void>;
}

/** The firm world, prepared to READY, with a runner over fakes. The default quote is a 500 BRL payment. */
export const EXACT_OUT = "500000000000000000000";

export async function runWorld(
  options: {
    sellAmount?: string;
    buyAmount?: string;
    minNativeWei?: bigint;
    held?: number;
    quote?: Partial<Parameters<typeof quotedReply>[0]>;
  } = {},
): Promise<RunWorld> {
  const world = await firmWorld({
    text: "pay 500 brl with usdt",
    ...(options.held !== undefined && { held: options.held }),
  });
  world.transport.enqueue(
    quotedReply({
      now: world.now(),
      sellAmount: options.sellAmount ?? "92200000",
      takerPays: options.sellAmount ?? "92200000",
      buyAmount: options.buyAmount ?? EXACT_OUT,
      ...options.quote,
    }),
  );
  return attachRunner(world, options.minNativeWei);
}

export async function attachRunner(world: FirmWorld, minNativeWei = 10n ** 15n): Promise<RunWorld> {
  const kernel = new FakeKernel(world);
  const orders = new FakeOrders();
  const cipher = new AesGcmSecretCipher([{ version: 1, key: SECRET_KEY }]);
  const { uow, chainState: chain } = world;
  const wallets = { getWallet: (userId: string) => world.wallets.getWallet(userId) };
  const infrastructure = { rpcConfigured: true, bundlerConfigured: true };
  const now = () => world.now();

  const signer = new ValidatedExecutionSigner({
    unitOfWork: uow,
    wallets,
    kernel,
    cipher,
    chain,
    minWindowMs: 5_000,
    infrastructure,
    now,
  });
  const rootActions = new RootActionService({
    unitOfWork: uow,
    kernel,
    cipher,
    wallets: {
      getWallet: wallets.getWallet,
      createDelegatedPermission: (request) =>
        uow.read.delegatedPermissions.create({
          id: createId(),
          userId: request.userId,
          walletId: request.walletId,
          provider: "zerodev-kernel-v3.3",
          chainId: request.chainId,
          status: "PENDING",
          allowedOperations: request.allowedOperations,
          allowedContracts: request.allowedContracts,
          allowedAssetIds: request.allowedAssetIds,
          perTransactionLimit: request.perTransactionLimit,
          enforcement: {
            contracts: "ONCHAIN",
            operations: "ONCHAIN",
            assets: "ONCHAIN",
            perTransactionLimit: "ONCHAIN",
            cumulativeLimit: "KAADA_POLICY",
            validity: "ONCHAIN",
          },
          validFrom: request.validFrom,
          expiresAt: request.expiresAt,
        }),
    },
    verifier,
    rpId: "kaada.test",
    origin: "https://app.kaada.test",
    now,
  });
  const runner = new ExecutionRunner({
    unitOfWork: uow,
    preparation: world.service,
    wallets,
    kernel,
    orders,
    cipher,
    chain,
    signer,
    rootActions,
    minWindowMs: 5_000,
    minNativeWei,
    infrastructure,
    poll: { intervalMs: 1, maxWaitMs: 3 },
    // Waiting moves the test clock, so bounded polls end instead of spinning on a frozen time.
    sleep: (ms) => {
      world.w.r.clock.now = new Date(world.w.r.clock.now.getTime() + ms);
      return Promise.resolve();
    },
    now,
  });

  const outcome = await world.service.prepare(world.authorization.id);
  if (outcome.status !== "EXECUTION_READY") throw new Error(`not ready: ${outcome.status}`);
  const record = await uow.read.executionPlans.findByAuthorization(world.authorization.id);
  if (!record) throw new Error("no plan record");

  const run: RunWorld = {
    ...world,
    kernel,
    orders,
    runner,
    signer,
    rootActions,
    cipher,
    executionId: record.id,
    async confirmRootAction(good = true) {
      const session = await uow.read.rootActions.findPendingByExecution(record.id);
      if (!session) throw new Error("no pending root action");
      const { token } = await rootActions.issueLink({
        sessionId: session.id,
        userId: record.userId,
      });
      await rootActions.complete(token, { id: "credential-0", good });
    },
  };
  return run;
}

export { WALLET_ADDRESS };
