/*
 * DEVELOPMENT ONLY: creates a throwaway user with an active wallet, a PIN and one priced payment
 * (500 wBRL to a demo recipient, MOCK numbers), then prints a real /authorize link for it.
 * It talks to the database only; it moves no money and calls no provider.
 *
 * Needs DATABASE_URL. Run: pnpm --filter @kaada/api demo:authorize
 * Remove what it created with: pnpm --filter @kaada/api demo:authorize -- --clean
 */
import { randomBytes } from "node:crypto";

import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import { CELO_CHAIN_ID, createAssetRegistry, createId, createMoney } from "@kaada/domain";

import { TransactionPinService } from "../src/core/authorization/pin-service.js";
import { AuthorizationSessionService } from "../src/core/authorization/session-service.js";
import { Argon2PinHasher } from "../src/infrastructure/auth/argon2-pin-hasher.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const origin = process.env["PASSKEY_ORIGIN"] ?? "http://localhost:3000";
const DEMO_PIN = "2468";
const database = createDatabase({ url: databaseUrl, poolMax: 2, poolTimeoutMs: 20_000 });

try {
  const repositories = createRepositories(database);

  if (process.argv.includes("--clean")) {
    const users = (
      await database.client.user.findMany({
        where: { username: { startsWith: "authorize-demo-" } },
        select: { id: true },
      })
    ).map((user) => user.id);
    const intents = (
      await database.client.intent.findMany({
        where: { userId: { in: users } },
        select: { id: true },
      })
    ).map((intent) => intent.id);
    const owned = { intentId: { in: intents } };
    const byUser = { userId: { in: users } };
    await database.client.execution.deleteMany({ where: byUser });
    await database.client.firmQuoteAttempt.deleteMany({ where: byUser });
    await database.client.paymentAuthorization.deleteMany({ where: owned });
    await database.client.authorizationSession.deleteMany({ where: owned });
    await database.client.routeStep.deleteMany({ where: { route: owned } });
    await database.client.route.deleteMany({ where: owned });
    await database.client.quote.deleteMany({ where: owned });
    await database.client.intent.deleteMany({ where: byUser });
    await database.client.recipient.deleteMany({ where: { ownerUserId: { in: users } } });
    await database.client.conversation.deleteMany({ where: byUser });
    await database.client.transactionPinSecurity.deleteMany({ where: byUser });
    await database.client.auditEvent.deleteMany({ where: byUser });
    await database.client.wallet.deleteMany({ where: byUser });
    await database.client.user.deleteMany({ where: { id: { in: users } } });
    console.log(`removed ${users.length} demo user(s)`);
  } else {
    const [usdt] = await repositories.assets.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
    const [wbrl] = await repositories.assets.findBySymbol("wBRL", { chainId: CELO_CHAIN_ID });
    const textile = await repositories.providers.findBySlug("textile");
    if (!usdt || !wbrl || !textile) throw new Error("run `pnpm db:seed` first");

    const user = await repositories.users.create({
      id: createId(),
      username: `authorize-demo-${createId().slice(0, 8)}`,
    });
    const wallet = await repositories.wallets.create({
      id: createId(),
      userId: user.id,
      chainId: CELO_CHAIN_ID,
      isPrimary: true,
      type: "EMBEDDED",
      status: "ACTIVE",
      deployment: "COUNTERFACTUAL",
      address: `0x${randomBytes(20).toString("hex")}`,
    });
    const conversation = await repositories.conversations.create({
      id: createId(),
      userId: user.id,
      channel: "TELEGRAM",
      status: "ACTIVE",
      externalConversationId: `authorize-demo-${createId()}`,
    });
    const recipient = await repositories.recipients.create({
      id: createId(),
      ownerUserId: user.id,
      type: "SAVED_BENEFICIARY",
      displayName: "João Silva",
      identifier: "joao",
      destinationCountry: "BR",
      isSaved: true,
    });
    const intent = await repositories.intents.create({
      id: createId(),
      userId: user.id,
      conversationId: conversation.id,
      type: "SEND",
      status: "RESOLVED",
      missingFields: [],
      revision: 1,
      sourceAssetId: usdt.id,
      destinationAssetId: wbrl.id,
      recipientId: recipient.id,
      destinationCountry: "BR",
      amount: { money: createMoney("500000000000000000000", wbrl.id), mode: "EXACT_OUTPUT" },
    });
    const quote = await repositories.quotes.create({
      id: createId(),
      intentId: intent.id,
      intentRevision: 1,
      providerId: textile.id,
      input: createMoney("92260150", usdt.id),
      output: createMoney("500000000000000000000", wbrl.id),
      slippageBps: 5,
      rawProviderData: { adapter: "textile", indicative: true, mock: true },
    });
    const routeId = createId();
    const route = await repositories.routes.createWithSteps({
      id: routeId,
      intentId: intent.id,
      intentRevision: 1,
      status: "VALID",
      input: createMoney("92260150", usdt.id),
      output: createMoney("500000000000000000000", wbrl.id),
      steps: [
        {
          id: createId(),
          routeId,
          position: 0,
          type: "SWAP",
          input: createMoney("92260150", usdt.id),
          output: createMoney("500000000000000000000", wbrl.id),
          providerId: textile.id,
          quoteId: quote.id,
        },
      ],
    });

    const uow = {
      read: repositories,
      transaction: <T>(work: (r: typeof repositories) => Promise<T>) =>
        withTransaction(database, work),
    };
    const pins = new TransactionPinService({
      unitOfWork: uow,
      hasher: new Argon2PinHasher(),
    });
    await pins.setPin(user.id, DEMO_PIN);
    const sessions = new AuthorizationSessionService({
      unitOfWork: uow,
      assets: createAssetRegistry(repositories.assets),
      pins,
      origin,
      sessionTtlMs: 30 * 60_000,
    });
    const { sessionId } = await sessions.begin(repositories, {
      userId: user.id,
      walletId: wallet.id,
      intentId: intent.id,
      intentRevision: 1,
      routeId: route.id,
    });
    const link = await sessions.issueLink({ sessionId, userId: user.id });
    console.log("");
    console.log(`Open this link (valid 30 minutes, works once):\n\n  ${link.url}\n`);
    console.log(
      `PIN for this demo user: ${DEMO_PIN}   (a wrong PIN 3 times locks it for 5 minutes)`,
    );
  }
} finally {
  await database.close();
}
