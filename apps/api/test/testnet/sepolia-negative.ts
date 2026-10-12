/*
 * Server-side REJECTION checks over HTTP against the running Sepolia-composed API. TESTNET ONLY.
 * A throwaway SOFTWARE passkey is used here ONLY to prove what the server refuses (it is never used for a PASS of the
 * real-browser result). Each refusal is checked against a control that succeeds.
 */
import { createDatabase } from "@kaada/database";

import { createSoftwareAuthenticator } from "../support/software-authenticator.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}
const api = (process.env["API_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env["PASSKEY_ORIGIN"] ?? "http://localhost:3000";
const rpId = process.env["PASSKEY_RP_ID"] ?? "localhost";
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(ok ? "PASS" : "FAIL", name, "-", detail);
};

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
const newSession = async () => {
  const created = await fetch(`${api}/api/v1/wallet/dev/setup-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const session = (await created.json()) as { userId: string; url: string };
  return { userId: session.userId, token: session.url.split("/setup/")[1] ?? "" };
};

const session = await newSession();
const { token } = session;
try {
  // ── registration: a wrong challenge, a wrong origin and a wrong RP ID are refused; the right one is accepted ──
  const authenticator = createSoftwareAuthenticator();
  const fresh = async () =>
    (
      (await call(token, "/passkeys/registration/options", { method: "POST" })).body as {
        challenge: string;
      }
    ).challenge;
  const register = (challenge: string, over: Partial<{ origin: string; rpId: string }> = {}) =>
    call(token, "/passkeys/registration/verify", {
      method: "POST",
      body: JSON.stringify(
        authenticator.register({
          challenge,
          origin: over.origin ?? origin,
          rpId: over.rpId ?? rpId,
        }),
      ),
    });
  const wrongChallenge = await register(
    Buffer.from("not-the-servers-challenge").toString("base64url"),
  );
  check(
    "registration with a WRONG challenge is refused",
    wrongChallenge.status >= 400,
    `HTTP ${wrongChallenge.status}`,
  );
  const wrongOrigin = await register(await fresh(), { origin: "https://evil.example" });
  check(
    "registration from a WRONG origin is refused",
    wrongOrigin.status >= 400,
    `HTTP ${wrongOrigin.status}`,
  );
  const wrongRp = await register(await fresh(), { rpId: "evil.example" });
  check(
    "registration for a WRONG RP ID is refused",
    wrongRp.status >= 400,
    `HTTP ${wrongRp.status}`,
  );
  const challenge = await fresh();
  const good = await register(challenge);
  check("control: the right registration is accepted", good.status === 200, `HTTP ${good.status}`);
  const again = await register(challenge);
  check(
    "a REPLAYED registration (same challenge) is refused",
    again.status >= 400,
    `HTTP ${again.status}`,
  );

  // ── the PIN step (a fresh assertion is required) ──
  const ask = async () =>
    (
      (await call(token, "/pin/options", { method: "POST" })).body as {
        options: { challenge: string };
      }
    ).options;
  const pin = (assertion: unknown) =>
    call(token, "/pin", {
      method: "POST",
      body: JSON.stringify({ pin: "246813", proof: { type: "PASSKEY", assertion } }),
    });
  let counter = 5;
  const sign = (
    challenge: string,
    over: Partial<{ origin: string; rpId: string; userVerified: boolean }> = {},
  ) =>
    authenticator.authenticate({
      challenge,
      origin: over.origin ?? origin,
      rpId: over.rpId ?? rpId,
      counter: (counter += 1),
      userVerified: over.userVerified ?? true,
    });

  const c1 = await ask();
  const wrongSignedChallenge = await pin(
    sign(Buffer.from("some-other-challenge").toString("base64url")),
  );
  check(
    "PIN with an assertion over the WRONG challenge is refused",
    wrongSignedChallenge.status === 400,
    `HTTP ${wrongSignedChallenge.status}`,
  );
  const c2 = await ask();
  const noUv = await pin(sign(c2.challenge, { userVerified: false }));
  check(
    "PIN with an assertion WITHOUT user verification is refused",
    noUv.status === 400,
    `HTTP ${noUv.status}`,
  );
  const c3 = await ask();
  const wrongOriginPin = await pin(sign(c3.challenge, { origin: "https://evil.example" }));
  check(
    "PIN with an assertion from the WRONG origin is refused",
    wrongOriginPin.status === 400,
    `HTTP ${wrongOriginPin.status}`,
  );
  const c4 = await ask();
  const wrongRpPin = await pin(sign(c4.challenge, { rpId: "evil.example" }));
  check(
    "PIN with an assertion for the WRONG RP ID is refused",
    wrongRpPin.status === 400,
    `HTTP ${wrongRpPin.status}`,
  );
  void c1;
  const c5 = await ask();
  const valid = sign(c5.challenge);
  const accepted = await pin(valid);
  check(
    "control: a valid assertion over the server's challenge sets the PIN",
    accepted.status === 200,
    `HTTP ${accepted.status}`,
  );
  const replayed = await pin(valid);
  check(
    "REPLAY of that same assertion is refused (challenge is single-use)",
    replayed.status === 400,
    `HTTP ${replayed.status}`,
  );

  // ── tokens ──
  const none = await call("", "");
  check("no bearer token is refused", none.status === 401, `HTTP ${none.status}`);
  const bogus = await call("A".repeat(43), "");
  check("an unknown token is refused", bogus.status === 401, `HTTP ${bogus.status}`);
  const rootBogus = await fetch(`${api}/api/v1/root-action/view`, {
    headers: { Authorization: `Bearer ${"B".repeat(43)}` },
  });
  check(
    "an unknown root-action token is refused",
    rootBogus.status === 401,
    `HTTP ${rootBogus.status}`,
  );
  const spent = await call(token, "/passkeys/registration/options", { method: "POST" });
  check(
    "a SPENT setup link cannot start another registration",
    spent.status === 401,
    `HTTP ${spent.status}`,
  );
} finally {
  const database = createDatabase({
    url: process.env["DATABASE_URL"] ?? "",
    poolMax: 2,
    poolTimeoutMs: 20_000,
  });
  const where = { userId: session.userId };
  await database.client.auditEvent.deleteMany({ where });
  await database.client.transactionPinSecurity.deleteMany({ where });
  await database.client.walletSetupSession.deleteMany({ where });
  await database.client.passkeyChallenge.deleteMany({ where });
  await database.client.passkeyCredential.deleteMany({ where });
  await database.client.wallet.deleteMany({ where });
  await database.client.user.deleteMany({ where: { id: session.userId } });
  await database.close();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
