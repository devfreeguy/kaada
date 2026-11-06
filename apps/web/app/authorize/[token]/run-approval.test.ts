import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOperationGate } from "../../lib/operation-gate.js";
import type { RootChallenge } from "../../lib/root-proof.js";
import { DeviceKeyMissingError } from "../../lib/root-proof.js";
import { authorizationReducer, initialScreen } from "./authorization-machine.js";
import type {
  AuthorizationEvent,
  AuthorizationState,
  Method,
  View,
} from "./authorization-machine.js";
import type { ConfirmDeps } from "./confirm-payment.js";
import { runApproval } from "./run-approval.js";

/*
 * The payment approval end to end, against fake network calls: the real gate, the real state machine and the real
 * orchestration. The rule under test is the one that matters most: a payment that was approved can never end on a failure,
 * while a genuine failure is always shown and can always be retried.
 */

const view: View = {
  summary: {
    amountMode: "EXACT_INPUT",
    senderSpends: { display: "₦700" },
    maximumSpend: { display: "₦700" },
    recipientReceives: { display: "AR$835" },
    minimumReceive: { display: "AR$835" },
  },
  expiresAt: "2026-11-06T12:00:00Z",
  pin: { isSet: true, resetRequired: false },
};

const NOW = Date.parse("2026-11-06T12:00:00Z");

const challenge = {
  action: "ROOT_PASSKEY_REQUIRED",
  type: "PASSKEY",
  options: {},
} as unknown as RootChallenge;

type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);

function screen(method: Method) {
  const initial = initialScreen(view, method, NOW);
  const box = { state: initial as AuthorizationState };
  const history: AuthorizationState["name"][] = [];
  const dispatch = (event: AuthorizationEvent) => {
    box.state = authorizationReducer(box.state, event);
    history.push(box.state.name);
  };
  return { box, history, dispatch };
}

function network(replies: Record<string, Reply[]>, options: { proof?: () => Promise<never> } = {}) {
  const calls: string[] = [];
  const deps: ConfirmDeps = {
    api: async (path) => {
      calls.push(path);
      const next = replies[path]?.shift();
      if (next === undefined) throw new Error(`unexpected call to ${path}`);
      return typeof next === "function" ? next() : next;
    },
    proveRoot:
      options.proof ?? (() => Promise.resolve({ type: "PASSKEY", assertion: {} } as never)),
    now: () => NOW,
  };
  return { deps, calls };
}

const ok = () => Response.json({ status: "ok" });
const wrongPin = (left = 2) =>
  Response.json({ code: "INVALID_PIN", attemptsRemaining: left }, { status: 401 });

async function approve(
  method: Method,
  net: ReturnType<typeof network>,
  s: ReturnType<typeof screen>,
  gate = createOperationGate(),
  pin = "123456",
) {
  await runApproval({ gate, dispatch: s.dispatch, deps: net.deps }, { token: "tok", method, pin });
  return gate;
}

describe("approving a payment", () => {
  it("1. passkey + PIN (device key) + payment submitted: ends approved, never a PIN failure", async () => {
    const s = screen("DEVICE_KEY");
    const net = network({
      "/authorization/root/options": [Response.json({ challenge, operation: "sealed" })],
      "/authorization/root/confirm": [ok()],
    });
    await approve("DEVICE_KEY", net, s);
    assert.equal(s.box.state.name, "done");
    assert.deepEqual(s.history, ["submitting", "done"]);
  });

  it("1b. a passkey wallet approves with one prompt and no PIN", async () => {
    const s = screen("PASSKEY");
    const net = network({
      "/authorization/root/options": [Response.json({ challenge, operation: "sealed" })],
      "/authorization/root/confirm": [ok()],
    });
    await approve("PASSKEY", net, s, undefined, "");
    assert.equal(s.box.state.name, "done");
  });

  it("2. an incorrect PIN is shown with the attempts left, and the person can try again", async () => {
    const s = screen("PIN");
    const net = network({ "/authorization/authorize": [wrongPin(2), ok()] });
    const gate = await approve("PIN", net, s);
    assert.equal(s.box.state.name, "ready");
    assert.equal(
      s.box.state.name === "ready" && s.box.state.notice,
      "Incorrect PIN. 2 attempts left.",
    );
    await approve("PIN", net, s, gate);
    assert.equal(s.box.state.name, "done", "7. the retry after a failure succeeds");
    assert.equal(
      net.calls.length,
      2,
      "and the earlier failure did not leave a request in flight to overwrite it",
    );
  });

  it("3. a failed passkey (cancelled prompt) says so, sends nothing, and can be retried", async () => {
    const s = screen("PASSKEY");
    const cancel = () => Promise.reject(new DOMException("private detail", "NotAllowedError"));
    const net = network(
      { "/authorization/root/options": [Response.json({ challenge, operation: "sealed" })] },
      { proof: cancel as never },
    );
    const gate = await approve("PASSKEY", net, s, undefined, "");
    assert.equal(s.box.state.name, "ready");
    assert.equal(
      s.box.state.name === "ready" && s.box.state.notice,
      "Cancelled. Nothing was sent.",
    );
    assert.deepEqual(net.calls, ["/authorization/root/options"], "no confirm was sent");
    assert.equal(gate.succeeded, false);
  });

  it("3b. a missing device key is named, not reported as a wrong PIN", async () => {
    const s = screen("DEVICE_KEY");
    const net = network(
      { "/authorization/root/options": [Response.json({ challenge, operation: "sealed" })] },
      { proof: (() => Promise.reject(new DeviceKeyMissingError())) as never },
    );
    await approve("DEVICE_KEY", net, s);
    assert.match((s.box.state.name === "ready" && s.box.state.notice) || "", /device key/);
  });

  it("4. successful authentication followed by a successful submission: one clean path to done", async () => {
    const s = screen("PIN");
    const net = network({ "/authorization/authorize": [ok()] });
    await approve("PIN", net, s);
    assert.deepEqual(s.history, ["submitting", "done"]);
  });

  it("5. repeated approval attempts: a double tap sends ONE request, and a second approval of the same payment is refused", async () => {
    const s = screen("PIN");
    let release!: (value: Response) => void;
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const net = network({ "/authorization/authorize": [slow] });
    const gate = createOperationGate();
    const first = approve("PIN", net, s, gate);
    // The person taps Go again while the first request is still out: before the screen has even re-rendered.
    await approve("PIN", net, s, gate);
    assert.equal(net.calls.length, 1, "the second tap sent nothing");
    release(ok());
    await first;
    assert.equal(s.box.state.name, "done");
    await approve("PIN", net, s, gate);
    assert.equal(net.calls.length, 1, "an approved payment is not approved again");
    assert.equal(s.box.state.name, "done");
  });

  it("5b. a failure that arrives AFTER an approval cannot replace it", async () => {
    const s = screen("PIN");
    const gate = createOperationGate();
    const net = network({ "/authorization/authorize": [ok()] });
    await approve("PIN", net, s, gate);
    assert.equal(s.box.state.name, "done");
    // Whatever else was in flight (a duplicate request, a retry, a slow callback) reports a failure late.
    s.dispatch({ type: "failed", notice: "Incorrect PIN." });
    s.dispatch({ type: "moved", state: { name: "invalid" } });
    s.dispatch({ type: "load-failed", state: { name: "invalid" } });
    assert.equal(s.box.state.name, "done", "done is final");
  });

  it("6. closing the page and reopening it starts clean: the old attempt's late answer is dropped", async () => {
    const s = screen("PIN");
    let release!: (value: Response) => void;
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const net = network({ "/authorization/authorize": [slow] });
    const gate = createOperationGate();
    const stale = approve("PIN", net, s, gate);
    // The verification UI is closed and reopened: a new context.
    gate.reset();
    s.dispatch({ type: "reset" });
    s.dispatch({ type: "loaded", state: initialScreen(view, "PIN", NOW) });
    release(wrongPin(1));
    await stale;
    assert.equal(s.box.state.name, "ready");
    assert.equal(
      s.box.state.name === "ready" && s.box.state.notice,
      null,
      "the previous attempt's failure does not appear on the fresh screen",
    );
    const net2 = network({ "/authorization/authorize": [ok()] });
    await approve("PIN", net2, s, gate);
    assert.equal(s.box.state.name, "done");
  });

  it("an unmounted page is never written to", async () => {
    const s = screen("PIN");
    let release!: (value: Response) => void;
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const gate = createOperationGate();
    const attempt = approve("PIN", network({ "/authorization/authorize": [slow] }), s, gate);
    gate.dispose();
    const before = s.history.length;
    release(ok());
    await attempt;
    assert.equal(s.history.length, before);
  });

  it("an expired link, a missing PIN and a lock each move the screen to the right place", async () => {
    const a = screen("PIN");
    await approve(
      "PIN",
      network({ "/authorization/authorize": [new Response("{}", { status: 401 })] }),
      a,
    );
    assert.equal(a.box.state.name, "invalid");

    const b = screen("PIN");
    await approve(
      "PIN",
      network({
        "/authorization/authorize": [Response.json({ code: "PIN_NOT_SET" }, { status: 409 })],
      }),
      b,
    );
    assert.deepEqual(b.box.state, { name: "blocked", reason: "no-pin" });

    const c = screen("PIN");
    const until = "2026-11-06T13:00:00Z";
    await approve(
      "PIN",
      network({
        "/authorization/authorize": [
          Response.json({ code: "PIN_LOCKED", lockedUntil: until }, { status: 423 }),
        ],
      }),
      c,
    );
    assert.deepEqual(c.box.state.name === "ready" && c.box.state.lock, {
      until,
      label: "60 minutes",
    });
  });

  it("an unknown outcome is never reported as 'nothing was sent'", async () => {
    const s = screen("PIN");
    await approve(
      "PIN",
      {
        calls: [],
        deps: {
          api: () => Promise.reject(new TypeError("network down")),
          proveRoot: () => Promise.reject(new Error("unused")),
          now: () => NOW,
        },
      },
      s,
    );
    const notice = (s.box.state.name === "ready" && s.box.state.notice) || "";
    assert.match(notice, /Check your chat/);
    assert.doesNotMatch(notice, /nothing was sent/i);
  });
});

describe("the approval state machine", () => {
  it("keeps a failure notice inside the attempt: a reload does not bring it back", () => {
    let state: AuthorizationState = initialScreen(view, "PIN", NOW);
    state = authorizationReducer(state, { type: "submit" });
    state = authorizationReducer(state, { type: "failed", notice: "Incorrect PIN." });
    assert.equal(state.name === "ready" && state.notice, "Incorrect PIN.");
    state = authorizationReducer(state, { type: "reset" });
    state = authorizationReducer(state, { type: "loaded", state: initialScreen(view, "PIN", NOW) });
    assert.equal(state.name === "ready" && state.notice, null);
  });

  it("ignores events that do not belong to the current state", () => {
    const ready = initialScreen(view, "PIN", NOW);
    assert.equal(authorizationReducer(ready, { type: "failed", notice: "x" }), ready);
    assert.equal(authorizationReducer(ready, { type: "succeeded" }), ready);
    assert.equal(
      authorizationReducer(ready, { type: "loaded", state: { name: "invalid" } }),
      ready,
    );
  });

  it("starts blocked when a PIN is needed and not set, or must be reset, and never for a passkey", () => {
    const noPin = { ...view, pin: { isSet: false, resetRequired: false } };
    assert.deepEqual(initialScreen(noPin, "PIN", NOW), { name: "blocked", reason: "no-pin" });
    assert.deepEqual(
      initialScreen({ ...noPin, pin: { isSet: true, resetRequired: true } }, "DEVICE_KEY", NOW),
      {
        name: "blocked",
        reason: "reset",
      },
    );
    assert.equal(initialScreen(noPin, "PASSKEY", NOW).name, "ready");
  });
});
