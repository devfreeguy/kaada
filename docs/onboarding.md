# Onboarding awareness and the notification outbox (Build 14.2)

Kaada's chat reacts to what is **true in the application**, not only to what a person types. When someone finishes a step on a
secure web page (wallet, PIN), the chat finds out on its own and continues the conversation. The design is a small, general
notification system; onboarding is its first producer, and a second chat adapter gets the same messages with no new code in the
wallet or PIN services.

```
 wallet row · PIN record · recovery configuration          (authoritative state, written by the existing services)
        │ read only
        ▼
 OnboardingStateReader ──▶ deriveOnboarding ──▶ step: WALLET → PIN → (RECOVERY) → COMPLETE
        │
        ▼ observe()  (each pass, from every instance)
 UserNotification outbox  (one row per user and kind; unique key = idempotency)
        │ claim()  (exactly one claimant per row, across instances; stale claims are taken over)
        ▼
 OnboardingAnnouncer ──▶ ChannelMessageService.announceOnboarding ──▶ every linked chat ──▶ TelegramAdapter
        │ delivered: markDelivered()        failed: release() → retried on the next pass
```

## Authoritative state, never chat words

`core/onboarding/state.ts` derives the step from facts only: an ACTIVE wallet with an address, a PIN record, and (where this
deployment has recovery) an active recovery configuration. Typing "done", "finished" or "okay" proves nothing; the answer to those
words is a fresh read of this state.

| Step       | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `WALLET`   | no active wallet yet                                     |
| `PIN`      | wallet ready, 6-digit PIN not set                        |
| `RECOVERY` | wallet and PIN done, recovery required and not yet armed |
| `COMPLETE` | everything required is done: the person can use Kaada    |

Recovery is **encouraged, not required** today (a person with a wallet and a PIN can already pay), so `COMPLETE` does not wait for
it. `SETTINGS.onboarding.requireRecovery` in `packages/config/src/settings.ts` makes it a required step; the chat then walks people
to it before saying they are all set. The step has no secure-link button yet (see Known limits).

## The notification outbox

`UserNotification` (table, migration `20261024000000`) has one row per `(user, kind)` with `kind` one of `ONBOARDING_STARTED`,
`WALLET_ROOT_CREATED` (reserved), `WALLET_READY`, `PIN_CREATED`, `RECOVERY_CONFIGURED`, `ONBOARDING_COMPLETED`. The unique key is
the state-transition id: however many instances, sweeps and inbound messages notice a transition, only the call that inserts the
row is its observer.

- **Idempotent and persisted:** survives restarts; no in-process events.
- **Claim:** `claim()` gives each undelivered row to exactly one caller (a conditional update per row). A claim older than 60 s is
  taken over, so a crashed worker cannot lose a message.
- **Retry:** a failed delivery `release()`s the row (attempts + 1) and the next pass tries again, up to 8 attempts.
- **Coalescing:** if several milestones are reached between two passes (wallet and PIN done), only the most advanced one is
  announced; the earlier ones are marked delivered. The words always come from the person's **current** state, never from the
  event, so a stale event can never say something that is no longer true.
- **Baseline:** when a person is first tracked, milestones already reached are recorded silently, so nobody is congratulated for
  something that happened long ago.

## What the chat says

| Situation                                           | Message (the model may phrase it; the state decides it)                                      | Button                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| new person, `/start`                                | "Welcome to Kaada 👋 … First, let's get your wallet ready." (fixed wording)                  | Set up Kaada                                             |
| wallet created on the web (announced by the system) | "Your wallet is ready 🎉 Now set up your 6-digit PIN …"                                      | Set up PIN                                               |
| PIN created on the web                              | "You're all set ✅ Your Kaada wallet is ready to use. What do you want to do first?"         | Fund wallet · Send money · Today's rates · Check balance |
| returning person, `/start`                          | "Hey 👋 Good to see you again. What are we doing today?" — no setup prompt                   | Send money · Today's rates · Check balance               |
| half-set-up person, `/start`                        | "Looks like your wallet is ready, but your PIN still needs setting up. Want to finish that?" | Continue setup                                           |
| typed "Done" with a wallet but no PIN               | "Yep, your wallet is ready 🎉 One more step: set up your 6-digit PIN …"                      | Set up PIN                                               |

The PIN is never typed in chat: the button opens the secure page. A model reply for the PIN step must actually name the PIN (and
for recovery, recovery); otherwise the fixed wording is used, so a model cannot skip or swap a step. It may say ✅ and "all set"
only in the complete state.

## Messages and events never race into two answers

Both paths build their message from the same state function and claim the same outbox rows, so exactly one of them speaks:

- The background pass and an inbound "Done" both `observe()` and `claim()`. Whoever claims the row tells the person; the other
  finds it claimed and stays quiet.
- A message typed **before** an announcement arrived is already answered by it: the reply is suppressed
  (`announcedSince(message.timestamp)`), so the person does not get the same instruction twice in two wordings.
- A message typed after the announcement gets a normal reply (the state is read again).
- `/start` settles any waiting announcement itself, so a "welcome back" is never followed by a stale "you're all set".

Only a typed message the interpreter could not place, a greeting, small talk or a goodbye is answered from onboarding state
(for someone still setting up, or who has just finished). Everything else (payments, rates, questions) goes through the Agent
Core as usual.

## Conversation context

Where setup stands is a trusted fact in every model-phrased reply (`knownFacts.onboardingStep`). While setup is incomplete the
conversation does not suggest or describe anything that needs a wallet and a PIN (sending, balance, funding); once it is complete
those suggestions appear and the setup prompts stop.

## Funding

`FUND_WALLET` is a normal capability, offered only when at least one funding method really works. `capabilities.ts` is the one
registry: `FUND_FROM_WALLET` and `VIEW_WALLET_ADDRESS` need `funding.walletTransfer`; `FUND_LOCAL_CURRENCY` needs
`funding.localCurrency`, which is **off** until a real provider flow exists, so "Fund with local currency" is never shown. Nothing
about funding is hardcoded in an adapter.

The details are trusted state, built by code (`funding.ts`): the person's own address, the network and the tokens Kaada supports.
No model is involved in funding, and a button for a method that is not offered answers "not available" without reading the wallet.
There is no QR code or open-wallet action yet because the web experience has none.

## Known limits

- **Linking an existing web user to Telegram** is still not built: a Telegram account starts as its own user, so onboarding
  awareness covers people who start in chat. Someone who set up on the web first will not be linked.
- **Recovery as a required step** has no button (the recovery page needs its own token issuance, not wired to chat). With the
  default policy this step is never reached.
- **Progress polling** runs every 4 s from the existing channel timer, so "real time" means a few seconds. An instant push from the
  setup page (an endpoint that triggers a pass) is a possible refinement; the outbox makes it safe to add.
- The webhook-less tunnel and Telegram's HTTPS-only buttons still apply (see docs/channels.md): over a plain `http://localhost` web
  origin the setup links arrive as text.
