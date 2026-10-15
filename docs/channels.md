# Chat channels (Build 14)

Kaada is usable from a chat app. Telegram is the first adapter, **not** the architecture: the Agent Core, routing, authorization
and execution are untouched and know nothing about chat apps. A second adapter (WhatsApp) implements the same interface and changes
none of them.

```
Telegram webhook                                              secure browser pages
      │                                                       /setup  /authorize  /root-action
      ▼                                                                   ▲
 TelegramAdapter ── InboundChannelMessage ──▶ ChannelMessageService ──────┘ (links only)
 (verify, normalise,                           │   identity → user
  render buttons)                              │   idempotency (webhook claim)
      ▲                                        │   button handles (opaque, bound)
      │ OutboundChannelMessage                 ▼
      └──────────────◀──────────────── Agent Core (AgentService) ─▶ routing ─▶ authorization
                                                                          │
 PaymentStatusDispatcher ◀── reads ── authorization session · PIN approval · execution record
 (edits ONE status message)                                               ▲
                                                           ExecutionRunner (driven by the secure page, as before)
```

## The adapter contract (`apps/api/src/core/channels/types.ts`)

A `ChannelAdapter` may only:

- `verifyWebhook(request)`: constant-time check of the provider's shared secret;
- `parseWebhook(body)`: provider payload → `InboundChannelMessage` (or `null` for anything it does not handle; never throws);
- `send` / `update`: `OutboundChannelMessage` → the provider's messages and buttons (edit in place where supported);
- `acknowledge`, `indicateTyping`, `remove`: best-effort provider niceties.

It must not interpret payment language, resolve recipients or assets, choose routes, create a `PaymentAuthorization`, sign,
execute or compute amounts. Those stay in the services it never imports.

| Model                    | Shape                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelIdentity`        | `channel`, `externalUserId` (the **stable** id), optional `username`, `displayName`, `languageCode`                                                                           |
| `InboundChannelMessage`  | `channel`, `externalEventId` (idempotency unit), `externalMessageId`, `externalConversationId`, `sender`, `isPrivate`, `content`, `timestamp`                                 |
| `content`                | `TEXT` · `COMMAND` (`START`/`HELP`/`CANCEL`, syntax only) · `ACTION` (an opaque button handle)                                                                                |
| `OutboundChannelMessage` | `text` + `actions[]`                                                                                                                                                          |
| `OutboundAction`         | `OPEN_URL` (semantic `OPEN_AUTHORIZATION` / `OPEN_SETUP` / `OPEN_ROOT_ACTION`) · `ACTION` (semantic `SELECT_OPTION` / `CANCEL` / `RETRY` / `VIEW_STATUS`, an opaque `handle`) |

The Agent Core's answer stays channel-neutral (`AgentResponse`). `presenter.ts` turns it into words plus semantic actions;
`ChannelMessageService` stores the buttons and issues the secure links; the adapter turns those into provider markup.

## Identity and linking

- A Telegram account is an `Identity` (`type=TELEGRAM`, `externalId` = the **numeric** Telegram user id) attached to a Kaada `User`.
  Usernames and names are metadata only: a changed username updates the identity and never creates another account.
- `(type, externalId)` is unique in the database, so one Telegram account can never belong to two Kaada users, and two
  simultaneous first messages resolve to the same user (the loser re-reads the winner). Tested on the real database.
- `/start` creates the user on first contact (no wallet, no key, no secret) and answers with a **"Set up Kaada"** button to the
  existing `/setup/[token]` page: the same single-use, hashed, short-lived setup link as before. A returning person with a wallet is
  welcomed back.
- Payments are only handled in a **private** chat; in a group the bot only says so.
- Not covered yet: linking Telegram to a Kaada user that already exists from the web (that needs a link token minted from the web
  side). Today every Telegram account starts as its own user.

## Webhook and idempotency

`POST /api/v1/channels/telegram/webhook`:

1. `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (constant time), else `401` with no explanation.
2. The body is parsed leniently; anything that is not a private text message or one of **our** button presses is acknowledged and
   ignored (edits, stickers, bots, malformed JSON).
3. `ChannelInboundEvent` claims the update id: `NEW` handle it, `DUPLICATE` acknowledge and do nothing, `IN_PROGRESS` answer `503`
   so Telegram comes back, `RECLAIMED` take over a worker that died (stale after 60 s). A failure releases the claim and answers
   `503`, so Telegram's retry is processed.
4. Below that the Agent Core is itself idempotent per message id, so even a missed claim cannot create two intents, two routes or
   two authorizations. A duplicate is never answered twice.

## Buttons (`callback_data`)

`callback_data` is `kaada:a:<22-char random handle>` and nothing else: no PIN, token, Recovery Code, claim token, amount or
state. `ChannelAction` (database) holds what the handle means, **bound to** the Kaada user, the Telegram account it was shown to,
the conversation, an expiry (30 min) and, unless reusable, a single use claimed by one conditional `UPDATE`:

- another Telegram account pressing it gets "no longer available" and nothing changes;
- a replay or ten simultaneous presses apply it once;
- an unknown, malformed or expired handle changes nothing.

A recipient/asset choice carries only the Agent Core's own option id; applying it calls the Agent Core's deterministic choice path,
**not** the language model.

## The payment, end to end

1. "Send Daniel $20" → Agent Core (missing currency / amount, ambiguous recipient and asset, corrections, cancel all use the
   existing conversation state; a choice or `/cancel` never calls the interpreter).
2. A priced payment becomes `AUTHORIZATION_REQUIRED`. Telegram shows the summary and an **Authorize payment** URL button
   (`/authorize/[token]`, issued at render time by `AuthorizationSessionService.issueLink`, single-use, short-lived):
   - exact input: you spend exactly X; they receive about Y, at least Z;
   - exact output: they receive exactly R; you spend about A, never more than B;
   - fees, and a note that the final price is confirmed after authorizing and can never cross those limits.
3. The **PIN is entered only on that page**. A message of exactly six digits typed into the chat is deleted from it, never stored,
   never sent to the interpreter, and answered with a warning.
4. First payment: the page asks for the root step (passkey or device key) exactly as before. Telegram never does it; it only
   sends **Continue securely** (a `/root-action/[token]` link) when the execution reports it is needed. A repeat payment is
   PIN-only: there is no root step to announce.
5. The browser page drives `prepare` and `run` as before (`ExecutionRunner` is unchanged: locking, authorization consumption,
   userOpHash-before-submit, reconciliation, ambiguous-send handling).

## Status delivery

`PaymentStatusDispatcher` is a pure observer, driven from the database every 4 s (so it survives restarts and works across
instances). For each unfinished payment it derives a state from the authorization session, the PIN approval and the execution
record (`deriveProgress`, using the existing `paymentView`), compares it with `ChannelPaymentStatus.lastState`, claims a change with
a compare-and-set, and only then sends. One status message is **edited** as the payment moves; a failed send reverts the claim so
the next pass tries again.

| State                                                         | Message                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| awaiting authorization                                        | (summary shown)                                                                 |
| authorization expired / cancelled                             | summary replaced, button removed: "wasn't confirmed in time… nothing was spent" |
| preparing                                                     | "Authorized ✅ Confirming the final price…"                                     |
| root step                                                     | "One security step is needed…" + **Continue securely**                          |
| processing                                                    | "Processing your payment…"                                                      |
| pending / outcome unknown                                     | "submitted and still confirming… please don't send it again" (never "retry")    |
| completed                                                     | "Payment sent ✅" (only when the record says COMPLETED)                         |
| failed                                                        | "didn't go through, funds are safe" + a reference code                          |
| insufficient balance, no route, gas funding, re-authorization | plain sentences, nothing sent                                                   |

## Outbound notifications

`NotificationService.send(userId, { type, … })` reaches every linked account through `DeliveryChannel`s (any chat adapter via
`adapterDelivery`), with one renderer for payment and recovery events. Recovery's Telegram alerts now go through the **same**
`TelegramAdapter` (there is one Telegram client). Execution and recovery code say what happened; they never import Telegram.

## Configuration

```
TELEGRAM_BOT_TOKEN=            # [secret] the bot
TELEGRAM_WEBHOOK_SECRET=       # [secret] 16-256 chars of A-Z a-z 0-9 _ - ; needs WALLET_PROVIDER=kernel
TELEGRAM_WEBHOOK_URL=          # tooling only: https://<public-host>/api/v1/channels/telegram/webhook
pnpm --filter @kaada/api telegram:webhook info|set|delete
```

The token alone enables recovery alerts only. Token + secret enables conversations. The bot username and domain are never
hardcoded.

## How Kaada sounds

The wording of replies (greetings, friendly questions, lead-ins around summaries, suggestion buttons) comes from the channel-neutral
conversation engine: see [conversation.md](conversation.md). The adapter only renders the neutral message and its semantic actions
(a `SUGGESTION` action is a server-bound button like any other; Telegram pairs short ones two to a row).

## Adding WhatsApp

Implement `ChannelAdapter` for WhatsApp (verify the signature header, normalise a message/button reply, render the neutral actions
as reply buttons or a template), add it to the `adapters` map in `channels.module.ts`, add a webhook controller, and add an
`IdentityType`/`ChannelType` mapping (both already exist). `ChannelMessageService`, the presenter, the status dispatcher, the
button store, the idempotency table and the notification service are reused unchanged, and nothing in the Agent Core, resolvers,
route planner, authorization, wallet or execution code changes. Provider-specific limits (button counts, template approval, the
24-hour session window) belong in that adapter.

## Local development over HTTPS (Telegram needs it)

Telegram will only call an HTTPS webhook, and only opens HTTPS buttons. For local development:

```
pnpm --filter @kaada/api dev:tunnels     # opens two cloudflared tunnels and writes the matching .env values
pnpm dev:api                             # restart the API so it reads them
pnpm dev:web
pnpm --filter @kaada/api telegram:webhook set
```

`dev:tunnels` (`apps/api/scripts/dev-tunnels.ts`) tunnels the API (:4000) and the web app (:3000), waits until **both are really
connected** (it uses HTTP/2 over TCP, because the default QUIC transport is silently blocked on some networks and leaves a tunnel
that starts but never connects), then sets `WEB_URL`, `CORS_ORIGINS`, `PASSKEY_ORIGIN`, `PASSKEY_RP_ID` and
`TELEGRAM_WEBHOOK_URL`. Notes:

- **`PASSKEY_RP_ID` is the tunnel's full host** (`abc-def.trycloudflare.com`), not its first label. A WebAuthn RP ID must be the
  origin's host or a registrable parent; `trycloudflare.com` is a public suffix, so the host itself is the only valid choice.
- trycloudflare hostnames change on every run, and a passkey is bound to its RP ID, so wallets created under one hostname cannot
  sign under the next. Use throw-away test wallets. The credential architecture is untouched: these are environment values only.
- The web dev server allows `*.trycloudflare.com` as a dev origin (`allowedDevOrigins`, development only).
- The webhook must keep refusing requests without the secret (401), and the secret header is redacted from request logs.

## Commands (Build 14.2 live-review fixes)

Slash commands are shortcuts to things people can also say in words; natural typing stays the main way to use Kaada (there is no
`/send`: "Send Daniel $20" is the interface). The menu is published with `pnpm --filter @kaada/api telegram:webhook commands` (and
by `set`), built by `commandMenu(flags)` so a command exists only when its feature does:

| Command    | Does                                                       | Same as                      |
| ---------- | ---------------------------------------------------------- | ---------------------------- |
| `/start`   | state-aware welcome, or resumes the exact setup step       | first contact                |
| `/help`    | concise list of what is available here, plus the shortcuts | "what can you do?"           |
| `/balance` | the wallet's balance (empty wallet leads to funding)       | "what's my balance?"         |
| `/fund`    | the wallet address, network and supported assets           | "how can I fund my account?" |
| `/wallet`  | the wallet address and network                             | -                            |
| `/rates`   | asks which pair to check                                   | "what's today's rate?"       |
| `/cancel`  | cancels what is open                                       | the Cancel button            |

Not offered because the feature does not exist yet: `/history` (transaction history) and `/status` (payment status lookup).
Commands are parsed by the adapter (syntax only) and resolved in `ChannelMessageService` to the same channel-neutral actions as the
buttons, so another adapter reuses them.

## Funding flow

"Fund wallet" (button, `/fund`, or "how do I add money?" typed in words) shows the real, currently supported way: a transfer from
another wallet or an exchange on Celo. The message is fixed wording over trusted state (the wallet address, the network, the
tokens Kaada recognises); no model writes any of it:

```
Sure 👍 You can fund your Kaada wallet from another wallet.

Network: Celo
Wallet: 0x…
Supported assets: USDT, USDC, …

Only send supported assets on the Celo network to this address. Funds sent on another network, or unsupported assets, may not
appear in Kaada and may be difficult or impossible to recover.
```

Telegram shows the address as monospace and with a native **Copy address** button (`copy_text`, Bot API 7.11+); an adapter that
cannot copy shows only the text. A menu appears only when there are two or more real choices (today there is one), and "Fund with
local currency" stays hidden until a real provider flow exists. If a payment is open (for example it was short on funds), the message
also offers **Continue**, which re-prices the same payment once the funds have arrived.

## Balance outcomes

A successful read of an empty wallet answers "Your wallet is empty right now. Want to add some funds?" with **Fund wallet**; asking
for one token the wallet lacks says "You don't have any USDT in your Kaada wallet yet." A payment that cannot proceed for want of
funds says "You're short on USDT for this payment. Want to fund your wallet and come back to it?" with **Fund wallet** and
**Cancel**, and the payment stays open. A failed read is logged with its reason (`WALLET_NOT_READY`, `ASSET_UNSUPPORTED` with the
token symbol, `RPC_UNAVAILABLE`, `BALANCE_UNAVAILABLE`); the person only sees "I couldn't read your balance right now."

## Perceived latency

What a person sees while Kaada works, without ever faking progress:

0. **Classify first** (`core/channels/latency.ts`). Before anything is shown, an interaction is classed by what Kaada is doing:
   `INSTANT_DETERMINISTIC` (commands other than /balance, button presses answered from stored state, onboarding replies, wallet
   address, validation errors), `FAST_CONVERSATIONAL` / `MODEL_GENERATED` (casual chat), `PROVIDER_LOOKUP` (rates, balance),
   `ROUTING_OR_FINANCIAL_COMPUTATION` (preparing a payment), `PAYMENT_EXECUTION` and `BACKGROUND_STATUS`. Classification only
   chooses whether to show anything and which words; the answer itself always comes from the Agent Core's typed response. When
   unsure a message is conversational (typing only), never a loader. A pressed button is instant until it is resolved; the kinds
   that start real work (Continue, a payment option, Balance) refine it.
1. **Typing for anything that is not instant.** As soon as an inbound message is claimed (a duplicate never gets this far), the
   channel's activity signal starts (Telegram `sendChatAction: typing`) and is renewed every ~4 s, whatever the model or provider
   is doing. Instant interactions (/start, /cancel, buttons, onboarding, wallet address) show nothing: they reply at once.
   /start never waits on a model (`instant` presentation uses the fixed wording); /cancel needs none.
2. **A status only for real work, only if slow, and it names the work.** After `statusAfterMs` (default 1.5 s, configurable) with
   no answer, ONE temporary status is shown: "Let me check that rate for you 👀" (rate), "Checking your wallet…" (balance),
   "Let me find them." (recipient), "Got you. Let me work that out." (preparing a payment), "Let me work out the best route."
   (continuing one). Casual chat never gets a status: there is nothing to "work on". There is no generic loader anywhere
   (a test scans the source). The status is removed BEFORE the answer is shown, and also on failure, so none is left behind.
   The operations are channel-neutral (`ActivityChannel`: `setActivity`, `showTransientStatus`, `clearTransientStatus`) and a
   no-op on a channel that cannot do them.
3. **Live drafts for conversational wording only.** Channels may implement the optional `ChannelAdapter.openDraft(target)`
   (Telegram: `sendMessageDraft`, one `draft_id` per reply, so updates animate one bubble; the final `sendMessage` replaces it).
   Channels without it (e.g. a future WhatsApp adapter) simply return nothing and the reply appears whole.
   - Only `STREAMABLE_STATES` stream (greetings, casual chat, capability questions, general finance questions, out-of-scope, and
     "which currency/amount/recipient" clarifications) and only in `MODEL_FULL` mode. Rates, balances, summaries, payment progress
     and results are never streamed: they are shown once the application has them.
   - Groq strict `json_schema` output cannot stream (it arrives as one chunk), so streaming uses a separate plain-text prompt.
     Quick-reply suggestions come from server policy, not from the stream.
   - Every chunk is screened by the same checks as a final reply (markup, secrets, outcome claims, numbers the application did not
     supply, unbuilt features, emoji cap) before it is shown. A refused chunk stops the stream and the fixed wording is used.
   - Drafts are throttled locally (default ≥250 ms apart, ≤24 updates) and stop quietly on any error such as a flood-wait.
4. **Payments are not streamed.** Execution progress stays the persistent, edited status message ("Processing your payment…",
   then "Confirming your payment…", then the completed message) and success is only announced after confirmation. It comes only
   from stored state, never from a model.

## Balances, networks and deposit detection

### Which network a balance is read on

`WALLET_NETWORK` (`celo-mainnet` by default, `celo-sepolia` for development; a test network is refused in production) selects the
network on which a person's balance, the funding instructions and deposit detection are read. A wallet's address is the same on
every network, so the SAME address is read on the selected one. Payments, quotes and everything else stay on Celo mainnet.

A token is identified by **chain id + contract address**, never by symbol. Mainnet's supported tokens are the active assets of the
asset registry (unchanged). A test network's supported tokens are public, reviewed data in code
(`packages/config/src/networks.ts`, verified on the network), NOT rows in the shared registry: a second `cNGN` there would make the
symbol ambiguous for every payment request. Their ids are derived from chain id + address, so the test cNGN and the mainnet cNGN
can never be mistaken for each other, and the balance reader refuses to read a token on a chain other than its own.

Only registry tokens are ever read. Arbitrary ERC-20 holdings are never scanned or shown; zero balances are left out of the
answer, and an empty wallet says so and offers to fund it.

### Deposit detection

```
poll (every 30 s) -> WalletFundingWatcher -> checkpoint compare-and-set + WalletFundingEvent (one transaction)
                  -> FundingAnnouncer claims events -> ChannelMessageService.announceFunding -> every linked chat
```

- **Application-level polling.** One pass for all watched wallets (active embedded wallets of people with a linked chat); each
  wallet is one batched chain call covering all of its tokens. Nothing polls per conversation, and nothing lives in the Telegram
  adapter: a future WhatsApp adapter receives the same events.
- **Checkpoints.** `WalletBalanceCheckpoint` stores the last balances (smallest units, by asset id) and a `version`. A change is
  committed only if the version still matches what the observer read, in the same transaction that inserts the
  `WalletFundingEvent`. So two instances, a restart, a retried read or the same block seen twice yield at most one event; a
  balance that did not change writes nothing; a failed read changes nothing.
- **What counts.** A rise of at least a hundredth of a token (dust is recorded silently); falls update the checkpoint silently, and
  the next rise counts from the lower balance. Tokens that rise in the same pass are one event and one message. A wallet with no
  checkpoint that is more than 24 hours old is only baselined, so switching the feature on never announces money that was already
  there; a freshly made wallet is compared against zero, so its first deposit is news.
- **Delivery** reuses the outbox pattern of the onboarding notifications (claim, deliver, mark delivered or release for retry).
- **Wording** is fixed, built from the stored event: "Nice, your wallet just received 1,000 cNGN 💰 / You're ready to use it."
  with at most Send money and Balance buttons.
- **An open payment.** If a payment in that chat was last active within the progress window (1 hour), its amount is fixed in a
  token the wallet pays with, and this deposit is what makes it affordable (it was not before), the message offers
  Continue / Cancel for that payment instead. Nothing is executed or authorized by a deposit; Continue re-checks the payment from
  stored state and the person authorizes normally. A payment older than the window is not brought back. The underlying payment
  records are never touched. (On a test network the payment's registry token and the held test token are tied by symbol, and only
  there.)
