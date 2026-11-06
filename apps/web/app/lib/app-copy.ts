/*
 * What the application says, chosen by what the person is doing RIGHT NOW.
 *
 * A screen never carries a sentence written for another flow: the same reusable component asks this module for its
 * wording with the context and method it was given. Add a context here, not a conditional in a component.
 *
 * Rules the wording follows: say what is needed or what happened, in as few words as are clear; no tagline, no repeated
 * reassurance; and after an uncertain submission never claim "nothing was sent".
 */

/** What the person is doing. Each context owns its own titles and actions. */
export type VerifyContext = "payment" | "wallet-setup" | "wallet-action";
/** How they prove it. */
export type VerifyMethod = "passkey" | "device" | "pin";

export interface VerifyCopy {
  title: string;
  /** One short line, only when the action is not obvious from the title and button. */
  hint?: string;
  action: string;
  /** What the button says while the prompt or request is open. */
  waiting: string;
}

const VERIFY: Record<VerifyContext, Partial<Record<VerifyMethod, VerifyCopy>>> = {
  payment: {
    passkey: {
      title: "Confirm payment",
      action: "Confirm with passkey",
      waiting: "Waiting for your passkey…",
    },
    device: {
      title: "Confirm payment",
      hint: "Enter your PIN.",
      action: "Confirm",
      waiting: "Confirming…",
    },
    pin: {
      title: "Authorize payment",
      hint: "Enter your PIN.",
      action: "Authorize",
      waiting: "Authorizing…",
    },
  },
  "wallet-setup": {
    passkey: {
      title: "Secure your wallet",
      hint: "Use your fingerprint, face or screen lock.",
      action: "Create passkey",
      waiting: "Waiting for your device…",
    },
    device: {
      title: "Secure your wallet",
      hint: "Keep a key on this device and confirm payments with your PIN.",
      action: "Use this device",
      waiting: "Creating key…",
    },
  },
  "wallet-action": {
    passkey: {
      title: "Confirm setup",
      action: "Confirm with passkey",
      waiting: "Waiting for your passkey…",
    },
    device: {
      title: "Confirm setup",
      action: "Confirm with this device",
      waiting: "Confirming…",
    },
  },
};

export function verifyCopy(context: VerifyContext, method: VerifyMethod): VerifyCopy {
  const copy = VERIFY[context][method];
  if (!copy) throw new Error(`no copy for ${context} with ${method}`);
  return copy;
}

/** The screens every link-driven flow shares: loading, an expired link, a load failure. `subject` says what failed. */
export type LinkSubject = "payment" | "setup" | "request" | "security";

const SUBJECT_NOUN: Record<LinkSubject, string> = {
  payment: "payment",
  setup: "setup",
  request: "request",
  security: "security options",
};

export const linkCopy = {
  loading: "Loading…",
  expired: (subject: LinkSubject) => ({
    title: "Link expired",
    body: `Ask Kaada in your chat for a new ${subject === "request" ? "link" : `${SUBJECT_NOUN[subject]} link`}.`,
  }),
  loadFailed: (subject: LinkSubject) => ({
    title: `Couldn't load ${SUBJECT_NOUN[subject]}`,
    action: "Try again",
  }),
} as const;

/** Words for a person who cancelled, lost something, or hit a limit. Shared so every flow says them the same way. */
export const failureCopy = {
  cancelled: "Cancelled. Nothing was changed.",
  cancelledPayment: "Cancelled. Nothing was sent.",
  deviceKeyMissing:
    "This browser doesn't hold your device key. Open the link on the device you set up.",
  /** After a submission whose outcome is not known: never claim nothing happened. */
  unknownPayment: "Couldn't confirm the result. Check your chat before trying again.",
  unknownRequest: "Couldn't confirm the result. Check your payment before trying again.",
  wrongPin: (left?: number) =>
    left !== undefined && left > 0
      ? `Incorrect PIN. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
      : "Incorrect PIN.",
  locked: "Too many attempts. Try again later.",
  lockedFor: (duration: string) => `Too many attempts. Try again in ${duration}.`,
  rateLimited: "Too many attempts. Wait a moment.",
  pinRequired: "Enter your PIN.",
  insufficientBalance: "Not enough balance for this payment and its fee. Nothing was sent.",
  gasFunding: "Your wallet needs CELO for the network fee. Nothing was sent.",
  notSent: "The payment wasn't sent. Start it again from your chat.",
} as const;

/** The state a person ends in after a payment is approved. */
export const paymentDoneCopy = {
  passkey: "Payment confirmed",
  pin: "Payment approved",
  following: "Following your payment…",
  pricing: "Confirming the final price…",
  leave: "You can also return to your chat.",
} as const;
