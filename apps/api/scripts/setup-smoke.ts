/*
 * Manual, END-TO-END check of passkey onboarding against a RUNNING API (WALLET_PROVIDER=kernel) and
 * the real Celo RPC. NOT part of CI. It creates a throwaway user through the development helper,
 * registers a SOFTWARE passkey (a throwaway P-256 key that is discarded with the process), verifies the
 * counterfactual Kernel address and reads balances, then deletes everything it created.
 *
 * Needs DATABASE_URL (for cleanup only) and API_URL (default http://localhost:4000).
 * PASSKEY_ORIGIN / PASSKEY_RP_ID must match the API's (defaults: http://localhost:3000, localhost).
 * Run: pnpm --filter @kaada/api smoke:setup
 */
import { createDatabase } from "@kaada/database";

import { createSoftwareAuthenticator } from "../test/support/software-authenticator.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const api = (process.env["API_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env["PASSKEY_ORIGIN"] ?? "http://localhost:3000";
const rpId = process.env["PASSKEY_RP_ID"] ?? "localhost";

async function call(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${api}/api/v1/wallet${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
  return { status: response.status, body: await response.json().catch((): unknown => null) };
}

const created = await fetch(`${api}/api/v1/wallet/dev/setup-sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const session = (await created.json()) as { userId: string; url: string };
const token = session.url.split("/setup/")[1] ?? "";
console.log(`setup link issued for a throwaway user (token length ${token.length})`);

try {
  const options = (await call(token, "/passkeys/registration/options", { method: "POST" }))
    .body as {
    challenge: string;
  };
  const authenticator = createSoftwareAuthenticator();
  const verified = await call(token, "/passkeys/registration/verify", {
    method: "POST",
    body: JSON.stringify(authenticator.register({ challenge: options.challenge, origin, rpId })),
  });
  console.log(`verify -> ${verified.status}`, JSON.stringify(verified.body));

  const replay = await call(token, "/passkeys/registration/options", { method: "POST" });
  console.log(`spent link, options again -> ${replay.status} (expected 401)`);

  const details = await call(token, "");
  console.log("details", JSON.stringify(details.body));
  const balances = await call(token, "/balances");
  const view = balances.body as {
    wallet: { address: string; deploymentStatus: string };
    balances: { symbol: string; formatted: string }[];
  };
  console.log(
    `balances -> ${balances.status}; ${view.wallet.address} ${view.wallet.deploymentStatus}; ` +
      view.balances.map((line) => `${line.symbol}=${line.formatted}`).join(" "),
  );
} finally {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl) {
    const database = createDatabase({ url: databaseUrl, poolMax: 2, poolTimeoutMs: 20_000 });
    const where = { userId: session.userId };
    await database.client.walletSetupSession.deleteMany({ where });
    await database.client.delegatedPermission.deleteMany({ where });
    await database.client.auditEvent.deleteMany({ where });
    await database.client.passkeyChallenge.deleteMany({ where });
    await database.client.passkeyCredential.deleteMany({ where });
    await database.client.wallet.deleteMany({ where });
    await database.client.user.deleteMany({ where: { id: session.userId } });
    await database.close();
    console.log("throwaway rows deleted");
  }
}
