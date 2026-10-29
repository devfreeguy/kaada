import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_AGENT_URI,
  MAX_COST_WEI,
  REGISTRATION_TYPE,
  assertRegistrationLimits,
  fetchRegistrationFile,
  registrationCostWei,
} from "./agent-identity.js";
import type { RegistrationPlan } from "./agent-identity.js";

const WALLET = "0x92fd470fC469585749a3CedA736A1e426F7D85D5";

/** 300,000 gas at 250 gwei: 0.075 CELO, under the limit. */
const ok: RegistrationPlan = {
  wallet: WALLET,
  owned: 0n,
  gas: 300_000n,
  maxFeePerGas: 250_000_000_000n,
  balance: 200_000_000_000_000_000n,
};

describe("register-agent-identity limits", () => {
  it("accepts a first registration that is cheap and affordable", () => {
    assert.doesNotThrow(() => assertRegistrationLimits(ok));
  });

  it("refuses to register twice: one identity already owned stops it, however cheap", () => {
    assert.throws(
      () => assertRegistrationLimits({ ...ok, owned: 1n }),
      /already owns 1 identity.*never registered twice/,
    );
    assert.throws(() => assertRegistrationLimits({ ...ok, owned: 3n }), /never registered twice/);
  });

  it("checks the double-registration guard before the cost and the balance", () => {
    assert.throws(
      () => assertRegistrationLimits({ ...ok, owned: 1n, gas: 10n ** 9n, balance: 0n }),
      /never registered twice/,
    );
  });

  it("refuses a cost at or over 0.1 CELO and accepts one wei under", () => {
    const gas = 400_000n;
    const exactly = { ...ok, gas, maxFeePerGas: MAX_COST_WEI / gas, balance: 10n ** 18n };
    assert.equal(registrationCostWei(exactly), MAX_COST_WEI);
    assert.throws(() => assertRegistrationLimits(exactly), /not under/);
    assert.throws(
      () => assertRegistrationLimits({ ...exactly, maxFeePerGas: exactly.maxFeePerGas * 2n }),
      /not under/,
    );
    assert.doesNotThrow(() =>
      assertRegistrationLimits({ ...exactly, maxFeePerGas: exactly.maxFeePerGas - 1n }),
    );
  });

  it("stops with a clear message when the balance cannot pay for it", () => {
    const needed = registrationCostWei(ok);
    assert.throws(
      () => assertRegistrationLimits({ ...ok, balance: needed - 1n }),
      /cannot pay.*fund 0x92fd470f/,
    );
    assert.doesNotThrow(() => assertRegistrationLimits({ ...ok, balance: needed }));
  });
});

const goodFile = () => ({
  type: REGISTRATION_TYPE,
  name: "Kaada",
  description: "A description.",
  services: [{ name: "wallet", endpoint: `eip155:42220:${WALLET}` }],
  registrations: [],
});
const serve =
  (body: string, status = 200): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe("the registration file check", () => {
  it("accepts a well-formed file that lists the wallet (any letter case)", async () => {
    const file = goodFile();
    file.services[0]!.endpoint = file.services[0]!.endpoint.toLowerCase();
    assert.equal(
      (await fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve(JSON.stringify(file)))).name,
      "Kaada",
    );
  });

  it("refuses a URI that is not HTTPS, is not a URL or carries credentials, without fetching", async () => {
    const never = (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch;
    await assert.rejects(
      fetchRegistrationFile("http://www.kaada.xyz/a.json", WALLET, never),
      /must be HTTPS/,
    );
    await assert.rejects(fetchRegistrationFile("ipfs://abc", WALLET, never), /must be HTTPS/);
    await assert.rejects(fetchRegistrationFile("not a url", WALLET, never), /not a valid URL/);
    await assert.rejects(
      fetchRegistrationFile("https://u:p@kaada.xyz/a.json", WALLET, never),
      /credentials/,
    );
  });

  it("refuses when the URI cannot be fetched or does not answer 200", async () => {
    const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, down),
      /could not be fetched.*ECONNREFUSED/,
    );
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve("<html>", 404)),
      /HTTP 404/,
    );
  });

  it("asks fetch not to follow redirects, so the stored URI resolves by itself", async () => {
    let seen: RequestInit | undefined;
    const spy = ((_url: unknown, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response(JSON.stringify(goodFile())));
    }) as unknown as typeof fetch;
    await fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, spy);
    assert.equal(seen?.redirect, "error");
  });

  it("refuses a body that is not the registration file", async () => {
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve("<html>")),
      /not return JSON/,
    );
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve("null")),
      /type is not/,
    );
    await assert.rejects(
      fetchRegistrationFile(
        DEFAULT_AGENT_URI,
        WALLET,
        serve(JSON.stringify({ ...goodFile(), type: "x" })),
      ),
      /type is not/,
    );
    await assert.rejects(
      fetchRegistrationFile(
        DEFAULT_AGENT_URI,
        WALLET,
        serve(JSON.stringify({ ...goodFile(), name: " " })),
      ),
      /no name/,
    );
    await assert.rejects(
      fetchRegistrationFile(
        DEFAULT_AGENT_URI,
        WALLET,
        serve(JSON.stringify({ ...goodFile(), services: "x" })),
      ),
      /services array/,
    );
  });

  it("refuses a file that does not list this wallet", async () => {
    const other = goodFile();
    other.services[0]!.endpoint = "eip155:42220:0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4";
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve(JSON.stringify(other))),
      /does not list the wallet/,
    );
    const wrongChain = goodFile();
    wrongChain.services[0]!.endpoint = `eip155:1:${WALLET}`;
    await assert.rejects(
      fetchRegistrationFile(DEFAULT_AGENT_URI, WALLET, serve(JSON.stringify(wrongChain))),
      /does not list the wallet/,
    );
  });

  it("the file committed for the website passes the check for the platform wallet", async () => {
    const path = fileURLToPath(
      new URL("../../../../apps/web/public/.well-known/agent-registration.json", import.meta.url),
    );
    const file = await fetchRegistrationFile(
      DEFAULT_AGENT_URI,
      WALLET,
      serve(readFileSync(path, "utf8")),
    );
    assert.equal(file.registrations.length, 0);
  });
});
