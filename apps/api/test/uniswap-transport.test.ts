import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import {
  UniswapTransportError,
  createUniswapFetchTransport,
} from "../src/infrastructure/fx/uniswap/transport.js";

/*
 * The Uniswap API key travels in a custom `x-api-key` header. A custom header is NOT stripped when a request is redirected to
 * a different origin: only `Authorization` is. Demonstrated on this Node version (2026-11-06) before the fix, with exactly
 * the setup below: the second server received the key. Textile sends its key as `Authorization: Bearer`, which is stripped,
 * so it never had this exposure; this transport did.
 *
 * Two real local servers on different ports (different origins), with the first redirecting to the second. No mocks: the
 * point is what the platform's fetch actually does.
 */

const SECRET = "uniswap-key-must-never-leave";

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe("the Uniswap transport never lets its API key follow a redirect", () => {
  it("fails the request instead of forwarding the key to another origin", async () => {
    const received: { headers?: IncomingHttpHeaders; hits: number } = { hits: 0 };
    const target = await listen((req, res) => {
      received.hits += 1;
      received.headers = req.headers;
      res.end("{}");
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/landing` });
      res.end();
    });
    try {
      const transport = createUniswapFetchTransport({
        baseUrl: `http://127.0.0.1:${redirector.port}`,
        apiKey: SECRET,
      });
      await assert.rejects(
        transport.post("/quote", { a: 1 }, { timeoutMs: 5_000 }),
        (error: unknown) => error instanceof UniswapTransportError,
        "a redirect is a failure, not something to follow",
      );
      assert.equal(received.hits, 0, "the other origin was never contacted");
      assert.equal(received.headers?.["x-api-key"], undefined, "so it never saw the key");
    } finally {
      await close(redirector.server);
      await close(target.server);
    }
  });

  it("still talks to the API normally when there is no redirect", async () => {
    let seenKey: string | undefined;
    const api = await listen((req, res) => {
      seenKey = req.headers["x-api-key"] as string | undefined;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const transport = createUniswapFetchTransport({
        baseUrl: `http://127.0.0.1:${api.port}`,
        apiKey: SECRET,
      });
      const response = await transport.post("/quote", { a: 1 }, { timeoutMs: 5_000 });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
      assert.equal(seenKey, SECRET, "the key still reaches the host it was meant for");
    } finally {
      await close(api.server);
    }
  });

  it("never puts the key in the error it raises", async () => {
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      res.end();
    });
    try {
      const transport = createUniswapFetchTransport({
        baseUrl: `http://127.0.0.1:${redirector.port}`,
        apiKey: SECRET,
      });
      const error = await transport.post("/quote", {}, { timeoutMs: 5_000 }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof UniswapTransportError);
      assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(SECRET), false);
    } finally {
      await close(redirector.server);
    }
  });
});
