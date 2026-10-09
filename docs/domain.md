# Domain, schemas and persistence mapping

## Dependency direction

```
apps → application code → @kaada/database ─┐
                          @kaada/schemas ──┼→ @kaada/domain  (no dependencies)
                          @kaada/providers ┘
```

- `@kaada/domain` is pure TypeScript with no dependencies. Its only runtime import is
  `node:crypto` (`createId`). No Zod, Prisma, NestJS, SDKs or I/O.
- `@kaada/schemas` (Zod) depends on the domain, never the reverse. Schemas are checked against domain
  types at compile time with `satisfies z.ZodType<DomainType>`.
- `@kaada/database` depends on the domain and schemas. Prisma types never leave it: repositories
  accept and return domain types, and mappers are internal (not exported from the package entry).
- The domain defines ports (repository, provider and channel interfaces). Infrastructure implements
  them.

IDs: `createId()` (UUIDv4 via `node:crypto`) lives in the domain because entities need it and the
domain may not depend on `@kaada/utils`. There is no `uuid` package.

## Money

`Money = { amount: string; assetId: string }`. `amount` is a canonical smallest-unit integer string:
`^(0|[1-9][0-9]*)$`, at most 78 digits (uint256). All arithmetic uses `BigInt`; nothing in
`packages/domain/src/money` uses `Number`, `parseFloat`, `Math.round`, `toFixed` or a decimal
library, and a test scans the source to keep it that way.

- `parseHumanAmount(value, decimals)` converts `"20.50"` to `"2050"` exactly. It never rounds:
  `"20.505"` at 2 decimals is rejected. Trailing zeros that need no rounding are fine (`"20.500"`
  at 2 decimals is `"2050"`). Outer whitespace is trimmed. Rejected: empty, signs, exponents,
  separators, `".5"`, `"1."`, leading zeros (`"01"`, `"00"`), non-ASCII digits. `".5"` is rejected on
  purpose: a missing digit is more likely a typo or a bad LLM output than intent.
- `formatSmallestUnit(amount, decimals)` is exact and keeps all digits (`"1"` at 6 decimals is
  `"0.000001"`).
- `addMoney`, `subtractMoney`, `compareMoney`, `minMoney`, `maxMoney` require the same asset
  (`ASSET_MISMATCH`); subtraction below zero throws `INSUFFICIENT_AMOUNT`.
- `HumanAmount = { value; currencyOrAsset }` is a different type from `Money`: it is what a person
  or LLM said, with an unresolved asset label. Convert with `moneyFromHuman(value, asset)` once the
  asset is known.
- Deliberately not implemented: ratio/percentage helpers. They need an explicit rounding policy
  (ROUND_UP vs ROUND_DOWN) that routing will define.

## Intents

`AgentIntent` is a discriminated union on `type` (SEND, CONVERT, QUOTE, BALANCE,
TRANSACTION_STATUS, HELP, UNKNOWN). Every field except `type` is optional, so `"Send $20."` is a
valid SEND with no recipient and nothing is invented. Amounts are `HumanAmount` plus an optional
`mode`:

- `EXACT_INPUT`: "I spend exactly this."
- `EXACT_OUTPUT`: "The recipient gets exactly this."

`findMissingFields(intent)` is a presence-only check (RECIPIENT, AMOUNT, SOURCE_ASSET,
DESTINATION_ASSET, DESTINATION; WALLET is added by callers).

The stored `Intent` keeps resolved facts in typed fields and the language-stage output in `parsed`
(the `normalizedData` column). `Intent.amount` is `{ money, mode }`; because the table has one
amount column and no asset column, its asset is implied by the mode (`amountAssetIdFor`: source
asset for EXACT_INPUT, destination asset for EXACT_OUTPUT). The mapper enforces that on read and
write.

## Quotes

`QuoteRequest.amount` is the fixed side, selected by `mode`: input asset for EXACT_INPUT, output
asset for EXACT_OUTPUT. `validateQuoteRequest` rejects a mismatched asset or a zero amount, and the
Zod schema reuses it. `FxQuote` is the provider-normalised shape; `Quote` is the stored immutable
snapshot (`provider` slug becomes `providerId`, `metadata` is stored as `rawProviderData`).

## Recipients

`RecipientReference` mirrors the stored `RecipientType` values exactly (`KAADA_USER`, `USERNAME`,
`TELEGRAM_USER`, `PHONE_NUMBER`, `WALLET_ADDRESS`, `SAVED_BENEFICIARY`, `EXTERNAL_PAYMENT_ADDRESS`).
Resolution (reference to `ResolvedRecipient`) is not implemented yet.

## Addresses

`AddressCodec` / `ChainAddressResolver` make normalisation chain-aware. Today every chain is EVM, so
addresses are validated and lowercased. The database also enforces lowercase wallet and contract
addresses, which is correct for EVM only; a case-sensitive chain would need a new codec and a
migration relaxing those CHECKs. No domain code would change.

## Providers and channels

Contracts only (`FxProvider`, `RampProvider`, `LlmProvider`, `ChannelAdapter`); no implementations.
`WalletProvider` is not defined yet because its methods are not understood well enough.

## Persistence mapping (`@kaada/database`)

- Mappers convert Prisma rows to domain objects and domain objects to create/update data. Absent
  optional values are omitted (never `undefined`); money is rebuilt from amount + asset columns and
  validated.
- JSON columns are validated with the Zod schemas when read (`normalizedData`, `constraints`,
  `missingFields`, metadata). Failures raise `DataIntegrityError`. On write, data is round-tripped
  through JSON so dates become ISO strings and `bigint` or non-finite numbers are rejected.
- Repositories are factories over a Prisma client, so the same code runs inside a transaction:
  `withTransaction(database, (repos) => ...)` gives domain repositories bound to one transaction.
  Duplicate webhook messages and repeated execution idempotency keys are absorbed with
  `ON CONFLICT DO NOTHING`, which is safe inside a larger transaction.
- `createDatabaseAssetRegistry(database)` is the domain `AssetRegistry` over the asset repository.
  It answers asset identity only; provider support lives in `ProviderCapability` rows.

## Tests

`pnpm test` runs unit tests (domain, schemas, config, database mappers and schema guard).
`pnpm --filter @kaada/database test:integration` round-trips every repository against the real
database; each test runs in a transaction that is always rolled back, so nothing is written.
