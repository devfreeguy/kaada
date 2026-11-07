/*
 * What the application says, chosen by what the person is doing RIGHT NOW.
 *
 * A screen never carries a sentence written for another flow: the same reusable component asks this module for its
 * wording with the operation, the method and the state it was given. Add a context here, not a conditional in a component.
 *
 * Rules the wording follows: say what is needed or what happened, in as few words as are clear; no tagline, no repeated
 * reassurance; proving who you are is never reported as the outcome of the payment; and no sentence claims an outcome
 * ("nothing was sent", "failed", "safe") unless the server's own state says so.
 */

/** What a payment is, as the server states it. The page never assumes one. */
export type Operation = "SEND" | "CONVERT";

const OPERATION_NOUN: Record<Operation, string> = { SEND: "payment", CONVERT: "conversion" };
const capitalised = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * What the person is doing. Each context owns its own titles and actions. The "-root" contexts are the one extra security
 * check a payment or conversion can need from the wallet's root credential: part of THAT operation, not a wallet setup.
 */
export type VerifyContext =
  "payment" | "conversion" | "payment-root" | "conversion-root" | "wallet-setup";
/** How they prove it. */
export type VerifyMethod = "passkey" | "device" | "pin";

export interface VerifyCopy {
  title: string;
  /** One short line, only when the action is not obvious from the title and button. */
  hint?: string;
  /** The button, or the keypad's submit key when the proof is typed. */
  action: string;
  /** What the button says while the prompt or request is open. Absent when the proof is typed (the keypad just locks). */
  waiting?: string;
  /** What the person sees once this proof has been accepted. Only for steps that end on their own screen. */
  done?: { title: string; description: string };
}

/** Approving an operation with the PIN, a passkey, or a device key plus the PIN. The method changes the action, not the meaning. */
function confirmStep(noun: string): Partial<Record<VerifyMethod, VerifyCopy>> {
  const title = `Confirm ${noun}`;
  const typed: VerifyCopy = { title, hint: "Enter your PIN.", action: "Confirm" };
  return {
    passkey: { title, action: "Confirm with passkey", waiting: "Waiting for your passkey…" },
    device: typed,
    pin: typed,
  };
}

/** The extra security check an operation can need. What it ends on says what was verified, not what the payment did. */
function rootStep(noun: string): Partial<Record<VerifyMethod, VerifyCopy>> {
  const title = `Confirm ${noun}`;
  const description = "We'll update you in your chat.";
  return {
    passkey: {
      title,
      action: "Use passkey",
      waiting: "Waiting for your passkey…",
      done: { title: "Passkey verified", description },
    },
    device: {
      title,
      action: "Continue on this device",
      waiting: "Confirming…",
      done: { title: "Device verified", description },
    },
  };
}

const VERIFY: Record<VerifyContext, Partial<Record<VerifyMethod, VerifyCopy>>> = {
  payment: confirmStep("payment"),
  conversion: confirmStep("conversion"),
  "payment-root": rootStep("payment"),
  "conversion-root": rootStep("conversion"),
  "wallet-setup": {
    passkey: {
      title: "Set up your wallet",
      hint: "Use your fingerprint, face or screen lock.",
      action: "Create passkey",
      waiting: "Waiting for your device…",
    },
    device: {
      title: "Set up your wallet",
      hint: "Keep a key on this device and confirm payments with your PIN.",
      action: "Use this device",
      waiting: "Creating key…",
    },
  },
};

export function verifyCopy(context: VerifyContext, method: VerifyMethod): VerifyCopy {
  const copy = VERIFY[context][method];
  if (!copy) throw new Error(`no copy for ${context} with ${method}`);
  return copy;
}

/** The context an operation's own verification screen uses. */
export const verifyContextOf = (operation: Operation): VerifyContext =>
  operation === "CONVERT" ? "conversion" : "payment";

/** The context of the extra security check an operation can need. */
export const rootContextOf = (operation: Operation): VerifyContext =>
  operation === "CONVERT" ? "conversion-root" : "payment-root";

/** The ending of a verification step that has one. A step without one is a mistake in the caller, not a reason to guess words. */
export function verifiedCopy(context: VerifyContext, method: VerifyMethod) {
  const done = verifyCopy(context, method).done;
  if (!done) throw new Error(`no ending for ${context} with ${method}`);
  return done;
}

/** The screens every link-driven flow shares: loading, an unavailable link, a load failure. `subject` says what failed. */
export type LinkSubject = "payment" | "setup" | "request";

const SUBJECT_NOUN: Record<LinkSubject, string> = {
  payment: "payment",
  setup: "setup",
  request: "request",
};

/** Where to go from a link that cannot be used: the way the bot actually continues each operation. */
const UNAVAILABLE_NEXT: Record<LinkSubject, string> = {
  payment: "Start the payment again in your chat.",
  setup: "Send /start in your chat to continue.",
  request: "Return to your chat to continue.",
};

export const linkCopy = {
  loading: "Loading…",
  /** Expired, already used, replaced or no longer valid: said the same way, so a link never reveals which. */
  unavailable: (subject: LinkSubject) => ({
    title: "This link is no longer available",
    body: UNAVAILABLE_NEXT[subject],
  }),
  loadFailed: (subject: LinkSubject) => ({
    title: `Couldn't load ${SUBJECT_NOUN[subject]}`,
    action: "Try again",
  }),
} as const;

/** The one wording for a link that stopped working, for a page that reports it from an error rather than a screen. */
export const LINK_UNAVAILABLE = "This link is no longer available.";

/** Words for a person who cancelled, lost something, or hit a limit. Shared so every flow says them the same way. */
export const failureCopy = {
  cancelled: "Cancelled. Nothing was changed.",
  cancelledPayment: "Cancelled. Nothing was sent.",
  deviceKeyMissing:
    "This browser doesn't hold your device key. Open the link on the device you set up.",
  /** After a submission whose outcome is not known: never claim nothing happened. */
  unknownResult: "Couldn't confirm the result. Check your chat before trying again.",
  wrongPin: (left?: number) =>
    left !== undefined && left > 0
      ? `Incorrect PIN. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
      : "Incorrect PIN.",
  locked: "Too many attempts. Try again later.",
  lockedFor: (duration: string) => `Too many attempts. Try again in ${duration}.`,
  rateLimited: "Too many attempts. Wait a moment.",
  pinRequired: "Enter your PIN.",
  pinNotSet: "Create your PIN first.",
  pinResetRequired: "Your PIN can only be replaced through wallet recovery.",
  insufficientBalance: "Not enough balance for this payment and its fee. Nothing was sent.",
  gasFunding: "Your wallet needs a little CELO for the network fee. Nothing was sent.",
  notSent: "The payment wasn't sent. Start it again from your chat.",
} as const;

/** The screens a payment cannot be approved from until the PIN is dealt with. */
export const blockedCopy = {
  noPin: { title: "Create your PIN", body: "Send /start in your chat to finish setup." },
  reset: {
    title: "Reset your PIN",
    body: failureCopy.pinResetRequired,
    action: "Recover your wallet",
  },
} as const;

/** What a screen says while the wallet's root is being asked to confirm, by the prompt the server chose. */
export const rootPromptCopy = {
  pending: "Preparing…",
  passkey: "Confirm with your passkey…",
  device: "Confirming on this device…",
} as const;

/** The way out for a person who cannot use the credential this screen asks for. */
export const recoverCopy = {
  passkey: "Can't use your passkey?",
  device: "Can't use this device?",
  link: "Recover your wallet",
} as const;

/** What both crash screens say. The reference, when there is one, is shown next to it. */
export const errorCopy = {
  title: "Something went wrong",
  body: "If you approved something, check your chat before trying again.",
  action: "Try again",
} as const;

/** The proof that was just accepted, named as what it is. */
export type ProofMethod = "PASSKEY" | "DEVICE_KEY" | "PIN";
const PROOF_TITLE: Record<ProofMethod, string> = {
  PASSKEY: "Passkey verified",
  DEVICE_KEY: "PIN verified",
  PIN: "PIN verified",
};
const PROOF_SENTENCE: Record<ProofMethod, string> = {
  PASSKEY: "Your passkey was verified",
  DEVICE_KEY: "Your PIN was verified",
  PIN: "Your PIN was verified",
};

/** What the server has told the page about the payment, as far as the words are concerned. */
export interface PaymentProgress {
  state?: string | undefined;
  /** The server's own sentence. Used only for a state this module does not know. */
  message?: string | undefined;
}

export interface ProgressCopy {
  title: string;
  description?: string;
}

/**
 * The screen after an authorization is accepted, from the server's state for the payment.
 *
 * Accepting a PIN or a passkey and the payment's own outcome are different facts: the heading names the payment's state once
 * the server reports one, and the supporting line names the proof only where it explains why the payment is not going out.
 * "Sent" appears only when the server says sent; "not sent" only for a state the server reports from before anything was
 * submitted; every other uncertainty points to the chat instead of claiming an outcome.
 */
export function paymentProgressCopy(
  operation: Operation,
  method: ProofMethod,
  progress: PaymentProgress,
  context: { alreadyRunning: boolean },
): ProgressCopy {
  const noun = OPERATION_NOUN[operation];
  const Noun = capitalised(noun);
  const verified = PROOF_SENTENCE[method];
  const again = operation === "CONVERT" ? "start it" : "send it";
  switch (progress.state) {
    case "ROOT_ACTION_REQUIRED":
      return {
        title: `Confirm ${noun}`,
        description: `${verified}. One more security check is needed.`,
      };
    case "PROCESSING_PAYMENT":
      return { title: `Sending ${noun}`, description: "Follow the update in your chat." };
    case "PAYMENT_PENDING":
      return {
        title: `${Noun} pending`,
        description: `We'll update you in your chat. Don't ${again} again.`,
      };
    case "PAYMENT_SENT":
      return { title: operation === "CONVERT" ? "Conversion complete" : "Payment sent" };
    case "PAYMENT_FAILED":
      return {
        title: `${Noun} failed`,
        description: "It didn't go through. You can start it again from your chat.",
      };
    case "REAUTHORIZATION_REQUIRED":
      return {
        title: `Confirm ${noun} again`,
        description:
          "The price or your approval changed. Nothing was sent. Start it again from your chat.",
      };
    case "INSUFFICIENT_BALANCE":
      return {
        title: "Balance too low",
        description: `Your wallet doesn't hold enough for this ${noun}. Add funds, then continue in your chat.`,
      };
    case "GAS_FUNDING_REQUIRED":
      return {
        title: "Network fee needed",
        description:
          "Your wallet needs a little CELO for the network fee. Add some, then continue in your chat.",
      };
    case "EXECUTION_ROUTE_UNSUPPORTED":
      return { title: "Route not supported", description: `This ${noun} can't be sent yet.` };
    case "EXECUTION_BLOCKED":
      return {
        title: `${Noun} not sent`,
        description: `${verified}, but this ${noun} needs a manual check first. Nothing was sent.`,
      };
    case "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY":
      return {
        title: `${Noun} not sent`,
        description: `${verified}, but the final price expired too quickly. Nothing was sent. Try again from your chat.`,
      };
    case "FINAL_PRICE_UNAVAILABLE":
      return {
        title: `${Noun} not sent`,
        description: `${verified}, but we couldn't confirm a final price. Nothing was sent. Try again shortly.`,
      };
    case "PROVIDER_CAPACITY_REACHED":
      return {
        title: `${Noun} not sent`,
        description: `${verified}, but the pricing provider is busy. Nothing was sent. Try again in a few minutes.`,
      };
    case "ERROR":
      // The page could not read the payment's state. That is not the same as the payment not having gone out.
      return {
        title: `${Noun} status unavailable`,
        description: "We couldn't confirm it. Check your chat before trying again.",
      };
    case "EXECUTION_READY":
      return { title: PROOF_TITLE[method], description: "Final price confirmed." };
    case undefined:
    case "PREPARING":
    case "PREPARATION_IN_PROGRESS":
    case "NOT_STARTED":
      return {
        title: PROOF_TITLE[method],
        description: context.alreadyRunning
          ? `Following your ${noun}…`
          : "Confirming the final price…",
      };
    default:
      // A state this page was not written for: the server's sentence, under the proof, rather than a guess.
      return {
        title: PROOF_TITLE[method],
        ...(progress.message && { description: progress.message }),
      };
  }
}
