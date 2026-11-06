import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOperationGate } from "./operation-gate.js";

describe("the operation gate", () => {
  it("runs one operation at a time: a second start is refused before any request is made", () => {
    const gate = createOperationGate();
    const first = gate.begin();
    assert.ok(first);
    assert.equal(gate.begin(), null, "a double tap cannot start a second attempt");
    first.finish();
    assert.ok(gate.begin(), "and once the first is over a retry is allowed");
  });

  it("a success is final: a late failure from the same attempt cannot replace it", () => {
    const gate = createOperationGate();
    const op = gate.begin();
    assert.ok(op);
    const screen: string[] = [];
    assert.equal(
      op.succeed(() => screen.push("done")),
      true,
    );
    assert.equal(
      op.commit(() => screen.push("PIN is incorrect")),
      false,
    );
    assert.deepEqual(screen, ["done"]);
  });

  it("after a success nothing new may start until the page enters a new context", () => {
    const gate = createOperationGate();
    gate.begin()?.succeed(() => undefined);
    assert.equal(gate.succeeded, true);
    assert.equal(gate.begin(), null, "no repeated approval of the same payment");
    gate.reset();
    assert.ok(gate.begin(), "a new flow starts clean");
  });

  it("a stale attempt cannot write after the page moved on (reset), even if it finishes last", () => {
    const gate = createOperationGate();
    const stale = gate.begin();
    assert.ok(stale);
    gate.reset();
    const fresh = gate.begin();
    assert.ok(fresh);
    const screen: string[] = [];
    fresh.succeed(() => screen.push("fresh result"));
    assert.equal(
      stale.commit(() => screen.push("stale failure")),
      false,
    );
    assert.equal(
      stale.succeed(() => screen.push("stale success")),
      false,
    );
    assert.deepEqual(screen, ["fresh result"]);
  });

  it("a failure is shown, and the person can retry", () => {
    const gate = createOperationGate();
    const op = gate.begin();
    assert.ok(op);
    const screen: string[] = [];
    assert.equal(
      op.commit(() => screen.push("That PIN is incorrect.")),
      true,
    );
    op.finish();
    assert.equal(gate.succeeded, false);
    const retry = gate.begin();
    assert.ok(retry, "retry after a genuine failure");
    retry.succeed(() => screen.push("done"));
    assert.deepEqual(screen, ["That PIN is incorrect.", "done"]);
  });

  it("an unmounted page is never written to, and Strict Mode's remount works again", () => {
    const gate = createOperationGate();
    const op = gate.begin();
    assert.ok(op);
    gate.dispose();
    assert.equal(
      op.commit(() => assert.fail("wrote after unmount")),
      false,
    );
    assert.equal(gate.begin(), null);
    gate.revive();
    assert.ok(gate.begin(), "the second mount of Strict Mode is usable");
  });

  it("an old attempt that ends late does not release a newer attempt's lock", () => {
    const gate = createOperationGate();
    const old = gate.begin();
    assert.ok(old);
    gate.reset();
    const current = gate.begin();
    assert.ok(current);
    old.finish();
    assert.equal(gate.running, true, "the current attempt is still the one running");
    assert.equal(gate.begin(), null);
  });
});
