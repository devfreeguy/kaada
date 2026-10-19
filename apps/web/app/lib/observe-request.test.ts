import assert from "node:assert/strict";
import { it } from "node:test";
import { observeRequest } from "./observe-request";

it("ignores a read that completes after the subscriber leaves", async () => {
  let complete!: (value: string) => void;
  const read = new Promise<string>((resolve) => {
    complete = resolve;
  });
  let updates = 0;
  const leave = observeRequest(
    () => read,
    () => {
      updates += 1;
    },
    () => {
      updates += 1;
    },
  );
  leave();
  complete("stale");
  await read;
  assert.equal(updates, 0);
});

it("reports a failed read to its active subscriber", async () => {
  const expected = new Error("unavailable");
  let failure: unknown;
  observeRequest(
    () => Promise.reject(expected),
    () => assert.fail("unexpected success"),
    (error) => {
      failure = error;
    },
  );
  await Promise.resolve();
  assert.equal(failure, expected);
});
