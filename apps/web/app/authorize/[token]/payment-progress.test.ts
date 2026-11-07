import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Operation } from "../../lib/app-copy";
import type { Method } from "./authorization-machine";
import { advanceOutcome } from "./follow-payment";
import type { Outcome } from "./follow-payment";
import { PaymentProgressView } from "./final-pricing";

function screen(
  state: string | null,
  options: {
    operation?: Operation;
    method?: Method;
    action?: string;
    url?: string | null;
    message?: string;
  } = {},
) {
  const outcome: Outcome | null =
    state === null
      ? null
      : {
          state,
          ...(options.message && { message: options.message }),
          ...(options.action && { action: options.action }),
        };
  const html = renderToStaticMarkup(
    createElement(PaymentProgressView, {
      operation: options.operation ?? "SEND",
      method: options.method ?? "PIN",
      outcome,
      alreadyRunning: (options.method ?? "PIN") !== "PIN",
      setupUrl: options.url ?? null,
    }),
  );
  return {
    html,
    lines: html
      .replace(/<[^>]+>/g, "|")
      .replace(/&#x27;/g, "'")
      .split("|")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

describe("the payment screen after an authorization is accepted", () => {
  it("before the server says anything, names the proof and what is being done", () => {
    assert.deepEqual(screen(null).lines, ["PIN verified", "Confirming the final price…"]);
    assert.deepEqual(screen(null, { method: "PASSKEY" }).lines, [
      "Passkey verified",
      "Following your payment…",
    ]);
    assert.deepEqual(screen("EXECUTION_READY").lines, ["PIN verified", "Final price confirmed."]);
  });

  it("a completed payment is one heading, not a heading and the same words again", () => {
    assert.deepEqual(screen("PAYMENT_SENT").lines, ["Payment sent"]);
    assert.deepEqual(screen("PAYMENT_SENT", { operation: "CONVERT" }).lines, [
      "Conversion complete",
    ]);
  });

  it("a payment in progress points to the chat instead of repeating itself", () => {
    assert.deepEqual(screen("PROCESSING_PAYMENT").lines, [
      "Sending payment",
      "Follow the update in your chat.",
    ]);
    assert.deepEqual(screen("PAYMENT_PENDING").lines, [
      "Payment pending",
      "We'll update you in your chat. Don't send it again.",
    ]);
    assert.deepEqual(screen("PAYMENT_PENDING", { operation: "CONVERT" }).lines, [
      "Conversion pending",
      "We'll update you in your chat. Don't start it again.",
    ]);
  });

  it("the extra security check is named for the operation and offers the right signer", () => {
    const passkey = screen("ROOT_ACTION_REQUIRED", {
      action: "ROOT_PASSKEY_REQUIRED",
      url: "https://app.example/root-action/T",
    });
    assert.deepEqual(passkey.lines, [
      "Confirm payment",
      "Your PIN was verified. One more security check is needed.",
      "Use passkey",
    ]);
    assert.match(passkey.html, /href="https:\/\/app\.example\/root-action\/T"/);
    const device = screen("ROOT_ACTION_REQUIRED", {
      action: "ROOT_DEVICE_KEY_REQUIRED",
      url: "https://app.example/root-action/T",
      operation: "CONVERT",
      method: "PASSKEY",
    });
    assert.deepEqual(device.lines, [
      "Confirm conversion",
      "Your passkey was verified. One more security check is needed.",
      "Continue on this device",
    ]);
    // No link yet, or no known signer: no button that would lead nowhere.
    assert.equal(
      screen("ROOT_ACTION_REQUIRED", { action: "ROOT_PASSKEY_REQUIRED" }).lines.length,
      2,
    );
    assert.equal(screen("ROOT_ACTION_REQUIRED", { url: "https://x" }).lines.length, 2);
  });

  it("every preparation failure is a payment that was not sent, over the proof that did succeed", () => {
    for (const state of [
      "EXECUTION_BLOCKED",
      "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY",
      "FINAL_PRICE_UNAVAILABLE",
      "PROVIDER_CAPACITY_REACHED",
    ]) {
      const { lines } = screen(state);
      assert.equal(lines[0], "Payment not sent", state);
      assert.match(lines[1] ?? "", /^Your PIN was verified, but /, state);
      assert.match(lines[1] ?? "", /Nothing was sent\./, state);
      assert.equal(screen(state, { operation: "CONVERT" }).lines[0], "Conversion not sent", state);
      assert.equal(
        screen(state, { method: "PASSKEY" }).lines[1]?.startsWith(
          "Your passkey was verified, but ",
        ),
        true,
      );
    }
  });

  it("an unreadable status is never reported as the payment not having gone out", () => {
    const { lines } = screen("ERROR");
    assert.equal(lines[0], "Payment status unavailable");
    assert.doesNotMatch(lines.join(" "), /nothing was sent|not sent|failed|safe/i);
    assert.match(lines[1] ?? "", /Check your chat before trying again/);
  });

  it("a definitive failure says what to do next, and never that funds are safe", () => {
    const { lines } = screen("PAYMENT_FAILED");
    assert.deepEqual(lines, [
      "Payment failed",
      "It didn't go through. You can start it again from your chat.",
    ]);
    assert.doesNotMatch(lines.join(" "), /safe/i);
  });

  it("balance, fee and route problems are not headed as a verified or sent payment", () => {
    assert.equal(screen("INSUFFICIENT_BALANCE").lines[0], "Balance too low");
    assert.equal(screen("GAS_FUNDING_REQUIRED").lines[0], "Network fee needed");
    assert.equal(screen("EXECUTION_ROUTE_UNSUPPORTED").lines[0], "Route not supported");
    assert.equal(screen("REAUTHORIZATION_REQUIRED").lines[0], "Confirm payment again");
    assert.equal(
      screen("REAUTHORIZATION_REQUIRED", { operation: "CONVERT" }).lines[0],
      "Confirm conversion again",
    );
  });

  it("a state this page does not know shows the server's sentence under the proof, not a guess", () => {
    assert.deepEqual(screen("SOMETHING_NEW", { message: "Server words." }).lines, [
      "PIN verified",
      "Server words.",
    ]);
  });

  it("never repeats a line, in any state, for either operation", () => {
    const states = [
      null,
      "EXECUTION_READY",
      "NOT_STARTED",
      "ROOT_ACTION_REQUIRED",
      "PROCESSING_PAYMENT",
      "PAYMENT_PENDING",
      "PAYMENT_SENT",
      "PAYMENT_FAILED",
      "REAUTHORIZATION_REQUIRED",
      "INSUFFICIENT_BALANCE",
      "GAS_FUNDING_REQUIRED",
      "EXECUTION_ROUTE_UNSUPPORTED",
      "EXECUTION_BLOCKED",
      "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY",
      "FINAL_PRICE_UNAVAILABLE",
      "PROVIDER_CAPACITY_REACHED",
      "ERROR",
    ];
    for (const operation of ["SEND", "CONVERT"] as const) {
      for (const state of states) {
        const { lines } = screen(state, { operation });
        assert.equal(
          new Set(lines).size,
          lines.length,
          `${operation} ${String(state)}: ${lines.join(" / ")}`,
        );
        // A conversion never talks about a payment.
        if (operation === "CONVERT")
          assert.doesNotMatch(lines.join(" "), /payment/i, String(state));
      }
    }
  });
});

describe("which payment state the page keeps", () => {
  const o = (state: string): Outcome => ({ state });

  it("a status read that precedes the run's first answer does not undo a confirmed price", () => {
    assert.equal(advanceOutcome(o("EXECUTION_READY"), o("NOT_STARTED")).state, "EXECUTION_READY");
    assert.equal(
      advanceOutcome(o("PROCESSING_PAYMENT"), o("NOT_STARTED")).state,
      "PROCESSING_PAYMENT",
    );
    assert.equal(
      advanceOutcome(o("ROOT_ACTION_REQUIRED"), o("NOT_STARTED")).state,
      "ROOT_ACTION_REQUIRED",
    );
  });

  it("a final state is never replaced", () => {
    for (const final of [
      "PAYMENT_SENT",
      "PAYMENT_FAILED",
      "INSUFFICIENT_BALANCE",
      "EXECUTION_BLOCKED",
    ]) {
      for (const later of ["NOT_STARTED", "PROCESSING_PAYMENT", "ROOT_ACTION_REQUIRED", "ERROR"]) {
        assert.equal(advanceOutcome(o(final), o(later)).state, final, `${final} then ${later}`);
      }
    }
  });

  it("real transitions still show", () => {
    assert.equal(advanceOutcome(null, o("PREPARING")).state, "PREPARING");
    assert.equal(advanceOutcome(o("PREPARING"), o("EXECUTION_READY")).state, "EXECUTION_READY");
    assert.equal(
      advanceOutcome(o("EXECUTION_READY"), o("ROOT_ACTION_REQUIRED")).state,
      "ROOT_ACTION_REQUIRED",
    );
    assert.equal(
      advanceOutcome(o("ROOT_ACTION_REQUIRED"), o("PROCESSING_PAYMENT")).state,
      "PROCESSING_PAYMENT",
    );
    assert.equal(advanceOutcome(o("PROCESSING_PAYMENT"), o("PAYMENT_SENT")).state, "PAYMENT_SENT");
    assert.equal(advanceOutcome(o("PREPARING"), o("NOT_STARTED")).state, "NOT_STARTED");
  });
});
