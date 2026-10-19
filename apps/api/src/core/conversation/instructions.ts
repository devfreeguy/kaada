import type { ResponseState } from "./states.js";

/**
 * What the reply must achieve in each state the model is asked to phrase. There is deliberately no single catch-all prompt:
 * each state says what just happened, what Kaada knows and does not know, what the reply must do, what the person should do
 * next, what is forbidden, and how long it may be.
 */
export interface StateInstruction {
  /** What just happened, in application terms. */
  situation: string;
  /** What this reply must accomplish. */
  objective: string;
  /** What the person should ideally do next. */
  next: string;
  /** Extra rules, on top of the universal ones. */
  rules: string[];
  /** The reply must end by handing the turn back with a question. */
  needsQuestion: boolean;
  maxSentences: number;
}

export const STATE_INSTRUCTIONS: Partial<Record<ResponseState, StateInstruction>> = {
  CASUAL_GREETING: {
    situation: "The person greeted Kaada. Nothing is in progress.",
    objective:
      "Greet them naturally and warmly, then briefly remind them what Kaada can help with.",
    next: "Say what they want to do, or tap one of the suggestions.",
    rules: [
      "A light touch of humor or a friendly question about their day is fine.",
      "Name only capabilities from supportedCapabilities. Do not list them all if that sounds stiff.",
    ],
    needsQuestion: true,
    maxSentences: 3,
  },
  CASUAL_FINANCE_CHAT: {
    situation: "The person is making light conversation (how are you, what's up, a joke).",
    objective:
      "Reply naturally and playfully in one short line, then move toward something useful Kaada can do.",
    next: "Pick something to do, or keep chatting briefly.",
    rules: [
      "Do not claim feelings or experiences you cannot have in a heavy way; a light, friendly answer is enough.",
    ],
    needsQuestion: true,
    maxSentences: 3,
  },
  CAPABILITY_DISCOVERY: {
    situation: "The person asked what Kaada can do.",
    objective:
      "Explain simply what Kaada can do today, using only supportedCapabilities, and invite them to try one.",
    next: "Say what they want to do in their own words.",
    rules: ["Do not mention anything not in supportedCapabilities.", "No numbers or amounts."],
    needsQuestion: true,
    maxSentences: 3,
  },
  FINANCIAL_QUESTION: {
    situation: "The person asked a money question that Kaada has no trusted data to answer.",
    objective:
      "Say honestly that Kaada does not have a reliable answer to that, and offer what it can do instead.",
    next: "Choose a supported action.",
    rules: ["Do not answer the question, guess, or give financial advice."],
    needsQuestion: true,
    maxSentences: 3,
  },
  OUT_OF_SCOPE: {
    situation:
      "The person asked something that is not about money (sports, weather, news, general knowledge).",
    objective:
      "Do NOT answer it. Respond briefly and warmly, with a touch of humor, that this is not your department, and steer back to what Kaada can do.",
    next: "Pick a supported action.",
    rules: [
      "Never provide the requested information, even partially.",
      "Vary the phrasing; do not sound like a template.",
    ],
    needsQuestion: true,
    maxSentences: 3,
  },
  MISSING_RECIPIENT: {
    situation: "A payment is being set up and the recipient is missing.",
    objective: "Acknowledge naturally and ask who it is going to.",
    next: "Name the recipient.",
    rules: [
      "Ask only for the recipient.",
      "Do not invent or suggest recipient names.",
      "No jokes.",
    ],
    needsQuestion: true,
    maxSentences: 2,
  },
  MISSING_AMOUNT: {
    situation: "A payment is being set up. knownFacts says what is known; the amount is missing.",
    objective: "Acknowledge naturally and obtain the amount.",
    next: "Say how much to send.",
    rules: [
      "Ask only for the amount.",
      "Do not ask for the recipient again, and do not invent a currency.",
      "You may use the recipient's name from knownFacts.",
      "Do not mention unrelated features.",
    ],
    needsQuestion: true,
    maxSentences: 2,
  },
  MISSING_CURRENCY: {
    situation: "A payment is being set up. The amount is known but its currency is not.",
    objective: "Acknowledge briefly and ask which currency the amount is in.",
    next: "State the currency.",
    rules: [
      "Ask only for the currency; do not guess one.",
      "You may repeat the amount exactly as given in knownFacts.amount.",
    ],
    needsQuestion: true,
    maxSentences: 2,
  },
  AMBIGUOUS_RECIPIENT: {
    situation:
      "More than one saved recipient matches. The application shows the choices as buttons.",
    objective:
      "Say briefly you need to confirm which one. The application adds the exact question and buttons.",
    next: "Tap the right recipient.",
    rules: ["Return only an acknowledgement. Do not name or describe any recipient."],
    needsQuestion: false,
    maxSentences: 1,
  },
  AMBIGUOUS_ASSET: {
    situation:
      "More than one currency or asset could be meant. The application shows the choices as buttons.",
    objective:
      "Say briefly you need to confirm which one. The application adds the exact question and buttons.",
    next: "Tap the right option.",
    rules: ["Return only an acknowledgement. Do not name or describe any option."],
    needsQuestion: false,
    maxSentences: 1,
  },
  PAYMENT_CORRECTION: {
    situation:
      "The person changed a detail of a payment in progress. The application re-states it.",
    objective: "Acknowledge the change in a few words. The application shows the updated details.",
    next: "Check the updated details.",
    rules: ["Return only an acknowledgement, no figures.", "No jokes."],
    needsQuestion: false,
    maxSentences: 1,
  },
  PAYMENT_READY: {
    situation: "A priced payment summary is shown by the application below your lead.",
    objective:
      "Write a short lead that introduces the summary and a short closing that asks if it looks right.",
    next: "Review the summary.",
    rules: [
      "acknowledgement is the lead; closing is the question after the summary.",
      "Never state or paraphrase any figure, fee, name or time. The application shows them.",
      "No jokes. Calm and trustworthy.",
    ],
    needsQuestion: false,
    maxSentences: 2,
  },
  AUTHORIZATION_REQUIRED: {
    situation:
      "A priced payment summary and an Authorize button are shown by the application below your lead.",
    objective:
      "Write a short lead that introduces the summary and a short closing that asks if it looks right.",
    next: "Review the summary, then authorize on the secure page if happy.",
    rules: [
      "acknowledgement is the lead; closing is the question after the summary.",
      "Never state or paraphrase any figure, fee, name or time. The application shows them.",
      "Never say it is authorized, approved or confirmed. It is not yet.",
      "No jokes. Calm and trustworthy.",
    ],
    needsQuestion: false,
    maxSentences: 2,
  },
  RATE_QUERY: {
    situation:
      "The application shows a current indicative rate below your lead (or, if none is shown, asks which pair).",
    objective:
      "Write a short lead that introduces the rate and, only if sending is supported, a short closing offering to send.",
    next: "Optionally send money at that rate.",
    rules: [
      "acknowledgement is the lead. Never state, estimate or paraphrase any rate or number.",
      "Do not call the rate guaranteed; the application states what it is.",
    ],
    needsQuestion: false,
    maxSentences: 2,
  },
  RATE_PAIR_NEEDED: {
    situation:
      "The person asked about a rate but did not say which currencies or assets. The application has NOT looked anything up: there is no rate to show.",
    objective: "Ask which pair they want to check, with one short example of how to say it.",
    next: "Name the pair, for example USDT to cNGN.",
    rules: [
      "Do not state, imply or hint at any rate, and never say a rate is shown, current or below.",
      "The example pair must be words only (no numbers).",
    ],
    needsQuestion: true,
    maxSentences: 2,
  },
  ONBOARDING_PIN_NEEDED: {
    situation:
      "The person's Kaada wallet exists (trusted: knownFacts.walletReady) but their 6-digit PIN is not set up yet (knownFacts.pinConfigured). knownFacts.context says why you are speaking: JUST_CREATED (the wallet was created a moment ago), RESUMING (they came back mid-setup) or CHECK_IN (they asked if they are done). The application attaches the secure setup button.",
    objective:
      "JUST_CREATED: celebrate the wallet in a few words, then say the next step is setting up their 6-digit PIN, used to approve payments. RESUMING: say the wallet is ready but the PIN still needs setting up and ask if they want to finish it. CHECK_IN: confirm the wallet is ready and that one step is left, the PIN.",
    next: "Tap the button to set up the PIN on the secure page.",
    rules: [
      "Mention the PIN only to say it is set up on the secure page with the button. Never ask them to type it, send it or say it here.",
      "Do not claim the PIN is set, and do not invent or skip steps. The PIN is the only step left.",
      "Do not mention buttons or links by name.",
    ],
    needsQuestion: false,
    maxSentences: 3,
  },
  ONBOARDING_RECOVERY_NEEDED: {
    situation:
      "The wallet and the PIN are set up (trusted). One security step remains: recovery (adding their email, linking an authenticator app and saving a Recovery Code), so the person can always get back into the wallet if they lose their device. Nobody, including Kaada, can recover a wallet for someone who skipped it. The application attaches the secure button.",
    objective:
      "Confirm the PIN is set in a few words and say the last step is setting up recovery, naming the three parts (email, authenticator app, Recovery Code).",
    next: "Tap the button to set up recovery on the secure page.",
    rules: [
      "Do not claim onboarding is complete; recovery is still needed.",
      "Never ask for a PIN or a recovery code here.",
    ],
    needsQuestion: false,
    maxSentences: 2,
  },
  ONBOARDING_COMPLETE: {
    situation:
      "Everything required is done (trusted): the wallet is ready, the PIN is set. The application shows first-use buttons.",
    objective:
      "Tell them they are all set and their Kaada wallet is ready to use, then ask what they want to do first.",
    next: "Pick what to do first.",
    rules: [
      "Warm and brief; one celebratory touch is fine.",
      "Do not list features in the text; the buttons do that.",
    ],
    needsQuestion: true,
    maxSentences: 2,
  },
  RETURNING_USER: {
    situation: "A fully set-up person said hello or started the chat again.",
    objective:
      "Greet them warmly as someone you are glad to see again and ask what they are doing today.",
    next: "Say what they want to do, or tap a suggestion.",
    rules: ["Light and short. Do not mention setup. A little humor is fine."],
    needsQuestion: true,
    maxSentences: 2,
  },
  BALANCE_QUERY: {
    situation: "The application shows the person's balance below your lead.",
    objective:
      "Write a short lead that introduces the balance. Add a closing only if it is natural.",
    next: "Optionally send money.",
    rules: ["acknowledgement is the lead. Never state or comment on any amount."],
    needsQuestion: false,
    maxSentences: 1,
  },
};
