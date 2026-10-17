import assert from "node:assert/strict";
import { test } from "node:test";

import { pickFees, readBundlerFeeFloor } from "./zerodev-kernel-adapter.js";

const URL_WITH_KEY = "https://api.pimlico.io/v2/42220/rpc?apikey=SECRET-API-KEY-123";
const gwei = (n: bigint) => n * 1_000_000_000n;
const hex = (n: bigint) => `0x${n.toString(16)}`;

/** A fetch that answers with `body` (or throws). Records what it was asked. */
function fakeFetch(answer: unknown, calls: { url: string; body: string }[] = []) {
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(
      new Response(typeof answer === "string" ? answer : JSON.stringify(answer)),
    );
  }) as typeof fetch;
  return impl;
}

const price = (maxFee: bigint, tip: bigint) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { standard: { maxFeePerGas: hex(maxFee), maxPriorityFeePerGas: hex(tip) } },
});

test("a bundler price above the chain's is used", async () => {
  const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(price(gwei(377n), 1_575_000n)));
  assert.deepEqual(pickFees({ maxFeePerGas: gwei(242n), maxPriorityFeePerGas: gwei(2n) }, floor), {
    maxFeePerGas: gwei(377n),
    maxPriorityFeePerGas: gwei(2n), // the chain's tip is higher than the bundler's: each field takes its own maximum
  });
});

test("a chain price above the bundler's is kept", async () => {
  const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(price(gwei(100n), gwei(1n))));
  assert.deepEqual(pickFees({ maxFeePerGas: gwei(242n), maxPriorityFeePerGas: gwei(2n) }, floor), {
    maxFeePerGas: gwei(242n),
    maxPriorityFeePerGas: gwei(2n),
  });
});

test("equal prices change nothing", async () => {
  const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(price(gwei(200n), gwei(2n))));
  assert.deepEqual(pickFees({ maxFeePerGas: gwei(200n), maxPriorityFeePerGas: gwei(2n) }, floor), {
    maxFeePerGas: gwei(200n),
    maxPriorityFeePerGas: gwei(2n),
  });
});

test("a bundler that does not support the method leaves the chain's fees exactly as they were", async () => {
  const chain = { maxFeePerGas: gwei(242n), maxPriorityFeePerGas: gwei(2n) };
  for (const answer of [
    { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unsupported method" } }, // Alchemy's style
    { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    { jsonrpc: "2.0", id: 1, result: null },
    { jsonrpc: "2.0", id: 1, result: {} },
  ]) {
    const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(answer));
    assert.equal(floor, null);
    assert.deepEqual(pickFees(chain, floor), chain);
  }
});

test("a malformed or hostile price is ignored, never thrown and never used", async () => {
  const chain = { maxFeePerGas: gwei(242n), maxPriorityFeePerGas: gwei(2n) };
  const bad = [
    "not json at all",
    "",
    "<html>502 bad gateway</html>",
    price(0n, 1n), // a zero floor is no floor
    { result: { standard: { maxFeePerGas: "377", maxPriorityFeePerGas: "0x1" } } }, // not hex
    { result: { standard: { maxFeePerGas: "0xZZ", maxPriorityFeePerGas: "0x1" } } },
    { result: { standard: { maxFeePerGas: -5, maxPriorityFeePerGas: 1 } } },
    { result: { standard: { maxFeePerGas: `0x${"f".repeat(64)}`, maxPriorityFeePerGas: "0x1" } } }, // absurdly large
    { result: { standard: { maxFeePerGas: { toString: "x" }, maxPriorityFeePerGas: "0x1" } } },
    { result: { standard: { maxFeePerGas: "0x10" } } },
    { result: { standard: null } },
    { result: [] },
  ];
  for (const answer of bad) {
    const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(answer));
    assert.equal(floor, null, JSON.stringify(answer));
    assert.deepEqual(pickFees(chain, floor), chain);
  }
});

test("an unreachable bundler or a timeout never breaks fee selection and leaks nothing", async () => {
  const logged: unknown[][] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args: unknown[]) => void logged.push(args);
  try {
    for (const failure of [
      new Error(`connect ECONNREFUSED ${URL_WITH_KEY}`),
      Object.assign(new Error(`fetch failed for ${URL_WITH_KEY}`), { name: "TimeoutError" }),
      new TypeError(`Failed to parse URL from ${URL_WITH_KEY}`),
    ]) {
      const floor = await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(failure));
      assert.equal(floor, null);
      assert.equal(JSON.stringify(floor).includes("SECRET-API-KEY"), false);
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, [], "nothing is logged, so the key in the URL cannot reach a log");
});

test("the request carries only the method (the API key stays in the URL it was configured with), to that URL and no other", async () => {
  const calls: { url: string; body: string }[] = [];
  await readBundlerFeeFloor(URL_WITH_KEY, fakeFetch(price(gwei(377n), 1n), calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, URL_WITH_KEY);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    jsonrpc: "2.0",
    id: 1,
    method: "pimlico_getUserOperationGasPrice",
    params: [],
  });
  assert.equal((calls[0]?.body ?? "").includes("SECRET-API-KEY"), false);
});

test("choosing fees never mutates the chain's estimate or returns the bundler's object", () => {
  const chain = { maxFeePerGas: gwei(100n), maxPriorityFeePerGas: gwei(1n) };
  const floor = { maxFeePerGas: gwei(300n), maxPriorityFeePerGas: gwei(3n) };
  const picked = pickFees(chain, floor);
  assert.deepEqual(chain, { maxFeePerGas: gwei(100n), maxPriorityFeePerGas: gwei(1n) });
  assert.notEqual(picked, floor);
  assert.notEqual(pickFees(chain, null), chain);
});
