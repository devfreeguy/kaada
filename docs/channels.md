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
