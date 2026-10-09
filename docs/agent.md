# Agent core

`apps/api/src/core/` is the channel-independent conversation engine. It has no Nest, Prisma, HTTP or
provider imports (a test enforces this); Nest only wires it at the edge (`apps/api/src/agent/`).

```
core/
  agent/          AgentService, IntentInterpreter port, MockIntentInterpreter, dev fixtures, ports
  conversations/  ConversationContext loader
  intents/        assessIntent (resolution + readiness), intent state building
  assets/         AssetResolver (over the AssetRegistry)
  recipients/     RecipientResolver (database-only)
  responses/      AgentResponse model, clarification wording, payment stages
```

## Principle

The interpreter (a mock now, an LLM later) only proposes a structured reading of a message. The
application decides everything else, deterministically: merging with the open intent, resolving
assets and recipients, what is missing, what to ask, and when an intent is ready. The interpreter
never touches the database, resolves entities, or chooses routes.

## One turn (`AgentService.handleMessage`)

1. **Accept** (short transaction): find or create the conversation for the channel chat, lock it,
   store the user message. A redelivered message (same `externalMessageId`) that was already answered
   returns the original answer (`duplicate: true`) and changes nothing.
2. **Interpret** (no transaction open): load context, call the `IntentInterpreter`, validate the
   result with `interpretationSchema`. An invalid result is treated as UNKNOWN; an interpreter
   failure returns a "try again" message and stores nothing, so a redelivery is retried.
3. **Apply** (short transaction): lock the conversation again, re-load the open intent, merge,
   assess, save the intent, store the assistant message with the structured response.

No transaction is held while waiting for the interpreter.

## State

Postgres is the source of truth; nothing is replayed from chat history. A turn's context is the
conversation, recent messages, the **active intent**, and the **pending clarification** (the first
missing field of an intent in `AWAITING_DETAILS`).

**Active intent** = the most recent intent in the conversation with status DRAFT, AWAITING_DETAILS,
RESOLVED, QUOTING or AWAITING_CONFIRMATION. COMPLETED, CANCELLED, FAILED, EXPIRED (and in-flight
EXECUTING) are never active. **MVP limitation:** one active operation per conversation; no parallel
intents. Starting a different operation cancels the open one.

## Merging

`mergeAgentIntent` (domain, pure) folds a new reading into the active one:

- same operation: values the user states now replace earlier ones, everything else is kept
  ("Send $50" + "Daniel" keeps the amount; "Actually make that $40" keeps the recipient);
- a new amount keeps the earlier mode only if it is in the same currency;
- a different operation (SEND, CONVERT, QUOTE) starts a fresh intent and retires the old one; nothing
  carries over;
- HELP, BALANCE, TRANSACTION_STATUS and UNKNOWN never change the active intent.

`CANCEL_ACTIVE_INTENT` and `START_OVER` are conversation commands, not financial intents. They mark
the active intent CANCELLED (history is kept).

## Resolution and readiness (`assessIntent`)

- **Amount asset**: the amount's own label decides the asset it is denominated in. `USD` resolves to
  the fiat dollar, never to USDC/USDT. An asset named for the other side ("pay from USDT") is
  validated and kept in the parsed intent as a routing preference; it never replaces the amount's
  currency.
- **Mode**: an explicit `EXACT_INPUT` / `EXACT_OUTPUT` wins. Otherwise the amount fixes the receiving
  side when it is in the destination's currency (declared, or the country's local currency from a
  small replaceable directory), and the sending side in every other case. The canonical amount is
  stored against the source asset for EXACT_INPUT and the destination asset for EXACT_OUTPUT.
- **Missing fields**: SEND needs an amount and a recipient; CONVERT/QUOTE need an amount plus the
  side the amount does not name. A SEND also needs a destination unless the recipient implies one
  (a Kaada user, a wallet address, or a saved contact with a country or preferred asset).
- **Assets**: resolved only from the registry (`RESOLVED` / `AMBIGUOUS` / `NOT_FOUND`); unknown
  assets are never invented.
- **Recipients**: database only. Kaada usernames, saved contacts (own contacts first for a generic
  name), Telegram identities that already exist, and wallet addresses. Phone numbers and external
  payment addresses are not looked up yet.
- **Questions**: deterministic wording, most blocking problem first (unsupported/ambiguous/invalid
  before merely missing), then amount, recipient, source, destination.

A ready intent becomes `RESOLVED` with a `ROUTING_REQUIRED` response (`purpose: PAYMENT` or
`QUOTE`). Nothing is quoted, routed, authorized or executed. Any later change returns the intent to
`RESOLVED` / `AWAITING_DETAILS`, so a price computed for older details is never current.

## Responses

`AgentResponse` is a union: `MESSAGE`, `CLARIFICATION_REQUIRED` (with `field`, `reason` and optional
`options` for buttons), `ROUTING_REQUIRED`, `CANCELLED`, and the placeholder
`AUTHORIZATION_REQUIRED` (no producer yet). Channels render these; they must not parse `text`.

Future payment path, with no stage skippable (`PAYMENT_STAGES`):
`ROUTING_REQUIRED -> PAYMENT_READY -> AUTHORIZATION_REQUIRED -> AUTHORIZED -> EXECUTING`.
A route that is ready is not cleared to execute; payment-specific authorization (PIN, delegated
signing) comes first. Quote-only intents never leave `ROUTING_REQUIRED`.

## Concurrency and duplicates

Each conversation is serialised with a row lock (`SELECT ... FOR UPDATE` on the Conversation row,
taken inside the transaction; no schema change, no Redis). Both the accept and apply steps lock, and
the apply step re-reads the open intent under the lock, so two near-simultaneous messages are applied
one after the other against fresh state (a "to Daniel" that arrives before "Send $20" still ends up
merged). A concurrent redelivery is detected under the lock, so only one answer is stored.

The interpreter may see a slightly stale active intent if another message commits while it runs;
the merge itself always uses the fresh one.

## Trying it by hand

Set `AGENT_INTERPRETER=mock` (never allowed in production), start the API, and post messages:

```sh
curl -s -X POST localhost:4000/api/v1/agent/messages -H 'content-type: application/json' \
  -d '{"content":"Send $20"}'
# reuse the returned userId and conversationId to continue the conversation
```

The mock is an exact-phrase lookup table (`core/agent/dev-fixtures.ts`), not language
understanding. Phrases (case and spacing ignored): `send $20`, `send $50`, `send $20 to daniel`,
`daniel`, `actually make that $40`, `send joao r$500 in brazil`, `convert 100 usd to ngn`,
`convert 100 usdc to cngn` (shows the not-supported path: tokens are not seeded yet),
`how much would 50 usd give me in brazil`, `cancel that`, `start over`, `help`,
`what is my balance`, `where is my payment`. Anything else is UNKNOWN.

To make a recipient resolvable, create a user whose username is `daniel` (or a saved contact).

The endpoint is internal: it does not exist in production, returns 503 until an interpreter is
configured, and accepts only the typed text. A caller cannot supply an interpreted intent.

## Tests

`pnpm test` runs the behaviour tests with in-memory repositories. `pnpm --filter @kaada/api
test:integration` runs the agent against the real database with committed transactions (so the row
lock is truly exercised), using uniquely named test users that are deleted afterwards.
