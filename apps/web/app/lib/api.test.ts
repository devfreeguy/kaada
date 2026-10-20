import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, describeError, json } from "./api";

describe("safe API errors", () => {
  it("distinguishes a rejected PIN from an expired session at the same HTTP status", async () => {
    await assert.rejects(
      json(Response.json({ code: "INVALID_PIN", message: "internal detail" }, { status: 401 })),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, "rejected");
        assert.match(describeError(error, "fallback"), /PIN is incorrect/);
        return true;
      },
    );
    await assert.rejects(
      json(Response.json({ message: "internal detail" }, { status: 401 })),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, "invalid");
        return true;
      },
    );
  });
  it("tells a wallet with no CELO for gas to add a little, and keeps the sponsoring answer as it was", async () => {
    await assert.rejects(
      json(
        Response.json(
          { code: "GAS_FUNDING_REQUIRED", message: "internal detail" },
          { status: 409 },
        ),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(
          describeError(error, "fallback"),
          "To finish securing your account, add a small amount of CELO to your wallet.",
        );
        return true;
      },
    );
    await assert.rejects(
      json(
        Response.json(
          { code: "SPONSORSHIP_UNAVAILABLE", message: "internal detail" },
          { status: 409 },
        ),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.match(describeError(error, "fallback"), /deposit a larger amount/);
        return true;
      },
    );
  });
  it("tells a wallet to try again later, not to add CELO, when the platform's own gas estimate is down", async () => {
    await assert.rejects(
      json(
        Response.json(
          { code: "GAS_ESTIMATE_UNAVAILABLE", message: "internal detail", retryable: true },
          { status: 503 },
        ),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        const text = describeError(error, "fallback");
        assert.equal(
          text,
          "We can't finish securing your account right now. Please try again in a few minutes.",
        );
        assert.doesNotMatch(text, /CELO|deposit/);
        return true;
      },
    );
    // A plain 503 with no such code still gets the generic wording.
    await assert.rejects(json(Response.json({ message: "x" }, { status: 503 })), (error) => {
      assert.equal(
        describeError(error, "fallback"),
        "Kaada is temporarily unavailable. Please try again.",
      );
      return true;
    });
  });
  it("does not surface raw backend messages, including non-JSON proxy failures", async () => {
    for (const response of [
      Response.json({ message: "private provider detail" }, { status: 500 }),
      new Response("private proxy detail", { status: 502 }),
    ]) {
      await assert.rejects(json(response), (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(
          describeError(error, "fallback"),
          "Kaada is temporarily unavailable. Please try again.",
        );
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
    }
  });
  it("keeps lockouts, rate limits and device cancellation distinct", () => {
    assert.match(
      describeError(new ApiError(423, "rejected", "PIN_LOCKED"), "fallback"),
      /wrong PIN/,
    );
    assert.match(describeError(new ApiError(429, "rate-limited"), "fallback"), /Too many attempts/);
    assert.match(
      describeError(new DOMException("private detail", "NotAllowedError"), "fallback"),
      /cancelled/,
    );
  });
});
