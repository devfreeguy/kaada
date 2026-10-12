import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GoogleRevocationList } from "../src/infrastructure/attestation/google-revocation-list.js";

// The shape of https://android.googleapis.com/attestation/status: decimal AND hex spellings of revoked serials.
const BODY = {
  entries: {
    "6681152659205225093": { status: "REVOKED", reason: "KEY_COMPROMISE" },
    c35747a084470c3135aeefe2b8d40cd6: { status: "REVOKED", reason: "SOFTWARE_FLAW" },
    "00ab": { status: "REVOKED", reason: "KEY_COMPROMISE" },
  },
};

function harness() {
  let now = new Date("2026-10-12T12:00:00Z");
  let calls = 0;
  let mode: "ok" | "down" = "ok";
  const list = new GoogleRevocationList({
    url: "https://example.test/status",
    cacheMs: 3_600_000,
    now: () => now,
    fetch: () => {
      calls += 1;
      if (mode === "down") return Promise.reject(new Error("offline"));
      return Promise.resolve(new Response(JSON.stringify(BODY), { status: 200 }));
    },
  });
  return {
    list,
    calls: () => calls,
    down: () => (mode = "down"),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("google revocation list", () => {
  it("finds a serial by its hex or its decimal spelling", async () => {
    const { list } = harness();
    assert.equal(await list.isRevoked("c35747a084470c3135aeefe2b8d40cd6"), true);
    assert.equal(await list.isRevoked(BigInt("6681152659205225093").toString(16)), true);
    assert.equal(await list.isRevoked("ab"), true, "leading zeros do not hide a serial");
    assert.equal(await list.isRevoked("deadbeef"), false);
  });

  it("caches, and refreshes after the cache lifetime", async () => {
    const { list, calls, advance } = harness();
    await Promise.all([list.isRevoked("1"), list.isRevoked("2"), list.isRevoked("3")]);
    assert.equal(calls(), 1, "one fetch however many checks");
    advance(3_599_000);
    await list.isRevoked("1");
    assert.equal(calls(), 1);
    advance(2_000);
    await list.isRevoked("1");
    assert.equal(calls(), 2);
  });

  it("fails closed when it has never been able to read the list", async () => {
    const { list, down } = harness();
    down();
    await assert.rejects(list.isRevoked("1"), /offline/);
  });

  it("uses a recent copy through an outage, but not a stale one", async () => {
    const { list, down, advance } = harness();
    await list.isRevoked("1");
    down();
    advance(2 * 3_600_000);
    assert.equal(await list.isRevoked("c35747a084470c3135aeefe2b8d40cd6"), true);
    advance(25 * 3_600_000);
    await assert.rejects(list.isRevoked("1"), /offline/);
  });

  it("refuses a malformed answer and a malformed serial", async () => {
    const bad = new GoogleRevocationList({
      url: "https://example.test/status",
      cacheMs: 1000,
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    await assert.rejects(bad.isRevoked("1"), /no entries/);
    const { list } = harness();
    await assert.rejects(list.isRevoked("XYZ"), /malformed/);
  });
});
