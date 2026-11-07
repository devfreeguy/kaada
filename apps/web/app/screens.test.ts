import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationFailure } from "./components/application/application-failure";
import { FlowStatus } from "./components/application/flow-status";
import { RecoveryNeeds } from "./components/recovery-needs";
import { RecoveryWaiting } from "./recovery/recovery-waiting";
import { RootActionScreen } from "./root-action/[token]/root-action-flow";
import type { View as RootView } from "./root-action/[token]/use-root-action";
import { SecurityProgress } from "./security/[token]/security-progress";
import { changeDoneCopy } from "./security/[token]/security-actions";
import { SetupCredentialView } from "./setup/[token]/setup-credential-step";
import { SetupFinalizeStep } from "./setup/[token]/setup-finalize-step";
import { SetupUnconfirmedStep } from "./setup/[token]/setup-unconfirmed-step";
import { AuthorizeScreen } from "./authorize/[token]/authorize-flow";
import type { AuthorizationState, Method, View } from "./authorize/[token]/authorization-machine";
import type { Operation } from "./lib/app-copy";

/** What a person reads on a screen, in the order it is drawn. */
function lines(element: ReactElement): string[] {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, "|")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .split("|")
    .map((line) => line.trim())
    .filter(Boolean);
}
const html = (element: ReactElement) => renderToStaticMarkup(element);
const KEYS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"]);
/** One idea once: no line is drawn twice on a screen (the keypad's digits aside). */
function assertNoRepeats(screen: string[], name: string) {
  const text = screen.filter((line) => !KEYS.has(line));
  assert.equal(new Set(text).size, text.length, `${name}: ${text.join(" / ")}`);
}

const noop = () => undefined;
const summary = {
  amountMode: "EXACT_INPUT" as const,
  senderSpends: { display: "₦700" },
  maximumSpend: { display: "₦720" },
  recipientReceives: { display: "AR$835" },
  minimumReceive: { display: "AR$830" },
};
const viewOf = (operation: Operation, recipient?: string): View => ({
  operation,
  summary: { ...summary, ...(recipient && { recipient }) },
  expiresAt: "2030-01-01T00:00:00Z",
  pin: { isSet: true, resetRequired: false },
});
function authorize(state: AuthorizationState) {
  return createElement(AuthorizeScreen, {
    token: "T",
    state,
    pin: "",
    setPin: noop,
    submit: async () => undefined,
    reload: noop,
  });
}
const ready = (
  method: Method,
  operation: Operation = "SEND",
  recipient?: string,
): AuthorizationState => ({
  name: "ready",
  view: viewOf(operation, recipient),
  method,
  notice: null,
  lock: null,
});

describe("payment approval screens", () => {
  it("passkey: one heading, the summary, the passkey action, a way out that does not call the passkey broken", () => {
    const screen = lines(authorize(ready("PASSKEY", "SEND", "Maria")));
    assert.deepEqual(screen, [
      "Confirm payment",
      "Maria receives",
      "about AR$835",
      "at least AR$830",
      "Maximum spend",
      "₦720",
      "Estimate. The final price is confirmed before sending and never exceeds the maximum.",
      "Confirm with passkey",
      "Can't use your passkey?",
      "Recover your wallet",
    ]);
  });

  it("device key: the same heading, a PIN keypad whose key says Confirm, and its own way out", () => {
    const screen = lines(authorize(ready("DEVICE_KEY")));
    assert.equal(screen[0], "Confirm payment");
    assert.equal(screen[1], "Enter your PIN.");
    assert.ok(screen.includes("Recipient receives"));
    assert.ok(screen.includes("Confirm"));
    assert.deepEqual(screen.slice(-2), ["Can't use this device?", "Recover your wallet"]);
    assert.ok(!screen.some((line) => /authorize/i.test(line)));
  });

  it("PIN only: the same heading as every other method, and no recovery footer", () => {
    const screen = lines(authorize(ready("PIN")));
    assert.equal(screen[0], "Confirm payment");
    assert.equal(screen[1], "Enter your PIN.");
    assert.ok(!screen.includes("Recover your wallet"));
    assert.ok(screen.includes("Confirm"));
  });

  it("conversion: says conversion and what the person gets, and never mentions a payment or a recipient", () => {
    for (const method of ["PASSKEY", "DEVICE_KEY", "PIN"] as const) {
      const screen = lines(authorize(ready(method, "CONVERT")));
      assert.equal(screen[0], "Confirm conversion", method);
      assert.ok(screen.includes("You get"), method);
      assert.doesNotMatch(screen.join(" "), /recipient|payment/i, method);
    }
  });

  it("a PIN lock replaces the keypad and shows one reason, not two", () => {
    const state: AuthorizationState = {
      ...(ready("PIN") as Extract<AuthorizationState, { name: "ready" }>),
      lock: { until: "2030-01-01T00:00:00Z", label: "about a minute" },
      notice: "Incorrect PIN.",
    };
    const screen = lines(authorize(state));
    assert.ok(screen.includes("Too many attempts. Try again in about a minute."));
    assert.ok(!screen.includes("Incorrect PIN."));
    assert.ok(!screen.includes("⌫"));
  });

  it("a wrong PIN shows the attempt count under the summary, above the keypad", () => {
    const state: AuthorizationState = {
      ...(ready("PIN") as Extract<AuthorizationState, { name: "ready" }>),
      notice: "Incorrect PIN. 2 attempts left.",
    };
    const screen = lines(authorize(state));
    assert.ok(screen.indexOf("Incorrect PIN. 2 attempts left.") > screen.indexOf("Maximum spend"));
    assert.ok(screen.indexOf("Incorrect PIN. 2 attempts left.") < screen.indexOf("⌫"));
  });

  it("a missing PIN says how to continue; a PIN that needs resetting offers the recovery link", () => {
    assert.deepEqual(lines(authorize({ name: "blocked", reason: "no-pin" })), [
      "Create your PIN",
      "Send /start in your chat to finish setup.",
    ]);
    const reset = authorize({ name: "blocked", reason: "reset" });
    assert.deepEqual(lines(reset), [
      "Reset your PIN",
      "Your PIN can only be replaced through wallet recovery.",
      "Recover your wallet",
    ]);
    assert.match(html(reset), /href="\/recovery"/);
  });

  it("an unavailable link does not claim to have expired, and tells the person where to continue", () => {
    assert.deepEqual(lines(authorize({ name: "invalid" })), [
      "This link is no longer available",
      "Start the payment again in your chat.",
    ]);
  });

  it("no approval screen repeats a line", () => {
    for (const operation of ["SEND", "CONVERT"] as const) {
      for (const method of ["PASSKEY", "DEVICE_KEY", "PIN"] as const) {
        assertNoRepeats(lines(authorize(ready(method, operation))), `${operation} ${method}`);
      }
    }
  });
});

const rootView = (
  name: "ready" | "confirming",
  action: "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED",
  operation: Operation,
  message: string,
  notice?: string,
): RootView =>
  name === "ready"
    ? { name, action, operation, message, ...(notice && { notice }) }
    : { name, action, operation, message };
function root(view: RootView) {
  return createElement(RootActionScreen, { view, confirm: noop, reload: noop });
}

describe("the extra security check", () => {
  it("payment with a passkey: heading, one supporting line, one action", () => {
    assert.deepEqual(
      lines(
        root(
          rootView("ready", "ROOT_PASSKEY_REQUIRED", "SEND", "One more security check is needed."),
        ),
      ),
      ["Confirm payment", "One more security check is needed.", "Use passkey"],
    );
  });

  it("conversion on a device: the same hierarchy, the conversion's own words", () => {
    assert.deepEqual(
      lines(
        root(
          rootView(
            "ready",
            "ROOT_DEVICE_KEY_REQUIRED",
            "CONVERT",
            "One more security check is needed to convert between your own currencies.",
          ),
        ),
      ),
      [
        "Confirm conversion",
        "One more security check is needed to convert between your own currencies.",
        "Continue on this device",
      ],
    );
  });

  it("a failure sits between the line and the action, and the heading does not change", () => {
    const screen = lines(
      root(
        rootView(
          "ready",
          "ROOT_PASSKEY_REQUIRED",
          "SEND",
          "One more security check is needed.",
          "Cancelled. Nothing was sent.",
        ),
      ),
    );
    assert.deepEqual(screen, [
      "Confirm payment",
      "One more security check is needed.",
      "Cancelled. Nothing was sent.",
      "Use passkey",
    ]);
  });

  it("while it is open, the button says what it is waiting for", () => {
    const passkey = html(root(rootView("confirming", "ROOT_PASSKEY_REQUIRED", "SEND", "x")));
    assert.match(passkey, /Waiting for your passkey…/);
    const device = html(root(rootView("confirming", "ROOT_DEVICE_KEY_REQUIRED", "SEND", "x")));
    assert.match(device, /Confirming…/);
  });

  it("done: what was verified and where the update arrives, not the payment's outcome and not a setup", () => {
    for (const operation of ["SEND", "CONVERT"] as const) {
      assert.deepEqual(lines(root({ name: "done", method: "passkey", operation })), [
        "Passkey verified",
        "We'll update you in your chat.",
      ]);
      assert.deepEqual(lines(root({ name: "done", method: "device", operation })), [
        "Device verified",
        "We'll update you in your chat.",
      ]);
    }
  });

  it("an unusable link says so once, and sends the person back to the chat", () => {
    assert.deepEqual(lines(root({ name: "invalid" })), [
      "This link is no longer available",
      "Return to your chat to continue.",
    ]);
  });
});

const view = (retry: "create" | "device" | "load", message: string) =>
  ({ name: "error", message, retry }) as const;
function setup(options: {
  passkey: boolean;
  deviceKey: boolean;
  deviceKeysEnabled: boolean;
  view?: Parameters<typeof SetupCredentialView>[0]["view"];
}) {
  return createElement(SetupCredentialView, {
    view: options.view ?? { name: "ready", deviceKeysEnabled: options.deviceKeysEnabled },
    deviceKeysEnabled: options.deviceKeysEnabled,
    createWithDevice: async () => undefined,
    create: async () => undefined,
    capabilities: { ready: true, passkey: options.passkey, deviceKey: options.deviceKey },
  });
}

describe("wallet setup: only what this browser can do", () => {
  it("a passkey browser with device keys offers the passkey first and the device second", () => {
    assert.deepEqual(lines(setup({ passkey: true, deviceKey: true, deviceKeysEnabled: true })), [
      "Set up your wallet",
      "Use your fingerprint, face or screen lock.",
      "Create passkey",
      "Use this device",
      "Kaada never sees your passkey or key.",
    ]);
  });

  it("without device keys on the server there is only the passkey", () => {
    const screen = lines(setup({ passkey: true, deviceKey: true, deviceKeysEnabled: false }));
    assert.ok(!screen.includes("Use this device"));
    assert.ok(screen.includes("Create passkey"));
  });

  it("a browser that cannot keep a device key is never offered one", () => {
    const screen = lines(setup({ passkey: true, deviceKey: false, deviceKeysEnabled: true }));
    assert.ok(!screen.includes("Use this device"));
  });

  it("a browser without passkeys but with device keys has the device as its only action", () => {
    const screen = lines(setup({ passkey: false, deviceKey: true, deviceKeysEnabled: true }));
    assert.deepEqual(screen, [
      "Set up your wallet",
      "Keep a key on this device and confirm payments with your PIN.",
      "Use this device",
      "Kaada never sees your passkey or key.",
    ]);
    assert.ok(!screen.includes("Create passkey"));
  });

  it("a browser that can do neither is told so and has no action that could fail", () => {
    const element = setup({ passkey: false, deviceKey: false, deviceKeysEnabled: true });
    assert.deepEqual(lines(element), [
      "Set up your wallet",
      "This browser can’t use a passkey or device key. Open the link in Safari or Chrome.",
    ]);
    assert.doesNotMatch(html(element), /<button/);
  });

  it("a cancelled passkey keeps the passkey action, with the reason above it", () => {
    const screen = lines(
      setup({
        passkey: true,
        deviceKey: false,
        deviceKeysEnabled: false,
        view: view("create", "Cancelled. Nothing was changed."),
      }),
    );
    assert.deepEqual(screen.slice(0, 4), [
      "Set up your wallet",
      "Use your fingerprint, face or screen lock.",
      "Cancelled. Nothing was changed.",
      "Create passkey",
    ]);
  });

  it("a request that went out and was not confirmed offers only to check again", () => {
    const element = createElement(SetupUnconfirmedStep, {
      message: "We couldn't confirm your setup. Check again before creating another passkey.",
      onCheck: noop,
    });
    assert.deepEqual(lines(element), [
      "Setup not confirmed",
      "We couldn't confirm your setup. Check again before creating another passkey.",
      "Check again",
    ]);
  });

  it("finishing the wallet does not promise it is the last step", () => {
    const first = lines(
      createElement(SetupFinalizeStep, { busy: false, onFinish: async () => undefined }),
    );
    assert.deepEqual(first, ["Almost done", "Create wallet"]);
    const failed = lines(
      createElement(SetupFinalizeStep, {
        busy: false,
        message: "Your setup is saved, but your wallet isn't confirmed yet.",
        onFinish: async () => undefined,
      }),
    );
    assert.deepEqual(failed, [
      "Almost done",
      "Your setup is saved, but your wallet isn't confirmed yet.",
      "Create wallet",
    ]);
    assert.ok(!first.concat(failed).some((line) => /last/i.test(line)));
  });
});

describe("wallet security", () => {
  const pending = (kind: "ROTATE_ROOT" | "ENROLL_BACKUP", type: "PASSKEY" | "DEVICE_KEY") =>
    ({
      name: "pending",
      message: "Still confirming. Check again shortly.",
      changeId: "c1",
      change: { kind, type },
    }) as const;

  it("says the same specific thing whether a change finished at once or after Check status", () => {
    for (const [kind, type, text] of [
      ["ROTATE_ROOT", "PASSKEY", "Your new passkey is ready. The old one no longer works."],
      ["ROTATE_ROOT", "DEVICE_KEY", "Your device key is ready. The old one no longer works."],
      ["ENROLL_BACKUP", "PASSKEY", "Backup added. You can use either method."],
      ["ENROLL_BACKUP", "DEVICE_KEY", "Backup added. You can use either method."],
    ] as const) {
      assert.equal(changeDoneCopy(kind, type), text);
      assert.deepEqual(
        lines(
          createElement(SecurityProgress, {
            progress: { name: "done", change: { kind, type } },
            check: async () => undefined,
          }),
        ),
        [text],
      );
    }
  });

  it("a change that is still confirming keeps its identity for the next check", () => {
    const calls: unknown[] = [];
    const element = createElement(SecurityProgress, {
      progress: pending("ROTATE_ROOT", "PASSKEY"),
      check: async (...args: unknown[]) => void calls.push(args),
    });
    assert.deepEqual(lines(element), ["Still confirming. Check again shortly.", "Check status"]);
  });

  it("never says credential", () => {
    for (const kind of ["ROTATE_ROOT", "ENROLL_BACKUP"] as const) {
      for (const type of ["PASSKEY", "DEVICE_KEY"] as const) {
        assert.doesNotMatch(changeDoneCopy(kind, type), /credential/i);
      }
    }
  });
});

describe("wallet recovery", () => {
  const waiting = (status: Record<string, unknown>, now = Date.parse("2030-01-01T00:00:00Z")) =>
    createElement(RecoveryWaiting, { status, now, waiting: true } as never);

  it("a safety delay is described as one, with its countdown", () => {
    const screen = lines(waiting({ nextStep: "WAIT", executeAfter: "2030-01-01T02:30:00Z" }));
    assert.equal(screen[0], "Recovery in progress");
    assert.match(screen[1] ?? "", /^This delay protects you\./);
    assert.deepEqual(screen.slice(2), ["Your wallet moves to this device in about", "2h 30m"]);
  });

  it("when the delay is over it says so instead of counting down to zero", () => {
    const screen = lines(waiting({ nextStep: "WAIT", executeAfter: "2029-12-31T23:59:00Z" }));
    assert.ok(screen.includes("The delay is over. Finishing recovery…"));
    assert.ok(!screen.some((line) => /0h 0m/.test(line)));
  });

  it("only a safety delay talks about a delay", () => {
    for (const nextStep of ["SUBMITTING", "FINALIZING", "WAITING_FOR_PAYMENT"]) {
      const screen = lines(waiting({ nextStep, executeAfter: "2030-01-02T00:00:00Z" }));
      assert.doesNotMatch(screen.join(" "), /delay|moves to this device in about/i, nextStep);
    }
    assert.deepEqual(lines(waiting({ nextStep: "SUBMITTING" })), ["Starting recovery", "Working…"]);
    assert.deepEqual(lines(waiting({ nextStep: "FINALIZING" })), [
      "Finishing recovery",
      "Moving your wallet to this device…",
    ]);
    assert.deepEqual(lines(waiting({ nextStep: "WAITING_FOR_PAYMENT" })), [
      "Waiting for a payment to finish",
      "A payment is still being processed. Recovery continues once it finishes. You don't need to do anything.",
    ]);
  });

  it("the requirements are shown in full once, and as the warning alone where the Recovery Code is made", () => {
    const full = lines(createElement(RecoveryNeeds, {}));
    assert.equal(full.length, 5);
    const warning = lines(createElement(RecoveryNeeds, { only: "warning" }));
    assert.deepEqual(warning, [
      "If you lose your Recovery Code or your authenticator app, Kaada cannot restore your wallet.",
    ]);
  });
});

describe("shared screens", () => {
  it("both crash screens use the same wording", () => {
    const screen = lines(createElement(ApplicationFailure, { reference: "abc", reset: noop }));
    assert.deepEqual(screen, [
      "Something went wrong",
      "If you approved something, check your chat before trying again.",
      "Reference: abc",
      "Try again",
    ]);
  });

  it("a load failure names what failed and offers one retry", () => {
    assert.deepEqual(
      lines(
        createElement(FlowStatus, {
          kind: "load-failed",
          subject: "payment",
          message: "Kaada is temporarily unavailable. Please try again.",
          onRetry: noop,
        }),
      ),
      ["Couldn't load payment", "Kaada is temporarily unavailable. Please try again.", "Try again"],
    );
  });
});
