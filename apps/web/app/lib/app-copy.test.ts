import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockedCopy,
  errorCopy,
  failureCopy,
  linkCopy,
  rootContextOf,
  verifiedCopy,
  verifyContextOf,
  verifyCopy,
} from "./app-copy";
import type { LinkSubject, Operation, VerifyMethod } from "./app-copy";

const OPERATIONS: Operation[] = ["SEND", "CONVERT"];
const ROOT_METHODS: VerifyMethod[] = ["passkey", "device"];

describe("approving an operation", () => {
  it("says the same thing whichever method proves it, and names the operation", () => {
    for (const operation of OPERATIONS) {
      const noun = operation === "CONVERT" ? "conversion" : "payment";
      const titles = (["passkey", "device", "pin"] as VerifyMethod[]).map(
        (method) => verifyCopy(verifyContextOf(operation), method).title,
      );
      assert.deepEqual(titles, [`Confirm ${noun}`, `Confirm ${noun}`, `Confirm ${noun}`]);
    }
  });

  it("has a busy label only where a button is shown: a typed PIN has none", () => {
    assert.equal(verifyCopy("payment", "pin").waiting, undefined);
    assert.equal(verifyCopy("payment", "device").waiting, undefined);
    assert.equal(verifyCopy("payment", "passkey").waiting, "Waiting for your passkey…");
  });
});

describe("the extra security check a payment can need", () => {
  it("is worded as the operation it belongs to, never as a wallet setup", () => {
    for (const operation of OPERATIONS) {
      for (const method of ROOT_METHODS) {
        const copy = verifyCopy(rootContextOf(operation), method);
        const done = verifiedCopy(rootContextOf(operation), method);
        const words = [copy.title, copy.action, done.title, done.description].join(" ");
        assert.doesNotMatch(words, /setup|set up/i, words);
        assert.equal(
          copy.title,
          operation === "CONVERT" ? "Confirm conversion" : "Confirm payment",
        );
      }
    }
  });

  it("names the action by the signer, and does not repeat the heading in the button", () => {
    assert.equal(verifyCopy("payment-root", "passkey").action, "Use passkey");
    assert.equal(verifyCopy("payment-root", "device").action, "Continue on this device");
    for (const method of ROOT_METHODS) {
      const copy = verifyCopy("payment-root", method);
      assert.doesNotMatch(copy.action, /confirm payment/i);
    }
  });

  it("ends on what was verified and where the update will arrive, never on the payment's outcome", () => {
    assert.equal(verifiedCopy("payment-root", "passkey").title, "Passkey verified");
    assert.equal(verifiedCopy("payment-root", "device").title, "Device verified");
    for (const method of ROOT_METHODS) {
      const done = verifiedCopy("conversion-root", method);
      assert.equal(done.description, "We'll update you in your chat.");
      assert.doesNotMatch(`${done.title} ${done.description}`, /sent|approved|complete/i);
    }
  });

  it("has no ending for a step that has none, rather than a borrowed one", () => {
    assert.throws(() => verifiedCopy("payment", "passkey"));
    assert.throws(() => verifiedCopy("wallet-setup", "passkey"));
  });

  it("is a different screen from the first approval of the same operation", () => {
    for (const operation of OPERATIONS) {
      assert.notEqual(
        verifyCopy(rootContextOf(operation), "passkey").action,
        verifyCopy(verifyContextOf(operation), "passkey").action,
      );
    }
  });
});

describe("a link that cannot be used", () => {
  it("says one thing for expired, used or replaced, and points the way the bot continues", () => {
    const subjects: LinkSubject[] = ["payment", "setup", "request"];
    for (const subject of subjects) {
      const copy = linkCopy.unavailable(subject);
      assert.equal(copy.title, "This link is no longer available");
      assert.doesNotMatch(`${copy.title} ${copy.body}`, /expired|new link|ask kaada/i);
    }
    assert.equal(linkCopy.unavailable("payment").body, "Start the payment again in your chat.");
    assert.equal(linkCopy.unavailable("setup").body, "Send /start in your chat to continue.");
  });
});

describe("shared wording", () => {
  it("never claims an outcome after an unknown result", () => {
    assert.doesNotMatch(failureCopy.unknownResult, /nothing was sent|failed|safe/i);
    assert.match(failureCopy.unknownResult, /Check your chat/);
  });

  it("points a missing or reset PIN at the actual way forward", () => {
    assert.match(blockedCopy.noPin.body, /\/start/);
    assert.match(blockedCopy.reset.body, /wallet recovery/);
  });

  it("gives both crash screens the same words", () => {
    assert.equal(errorCopy.title, "Something went wrong");
    assert.match(errorCopy.body, /check your chat before trying again/);
  });
});
