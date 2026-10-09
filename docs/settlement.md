# Settlement assets and provider capabilities

Build 7 lets Kaada answer, deterministically and from data: what does a human currency mean on Celo,
which assets can settle it, which providers can do what with which pair, and which candidates may be
handed to routing. It chooses no route, fetches no quote, and assumes no balance.

## Human currency is not a token

| Human intent   | Means           | Never means                   |
| -------------- | --------------- | ----------------------------- |
| `$20`, `USD`   | the fiat dollar | USDT, USDC (or any USD token) |
| `R$500`, `BRL` | the fiat real   | wBRL                          |
| `NGN`          | the fiat naira  | cNGN                          |

Fiat currencies are `Asset` rows of kind `FIAT`. A token that _represents_ a currency says so in its own
metadata (`fiatCode` on a non-FIAT asset, e.g. a BRL stablecoin carries `fiatCode = BRL`). Nothing is
inferred from symbols. `AssetRegistry.findByFiatCode` returns only the FIAT asset;
`findByDenomination(code, { chainId })` returns the tokens that represent it. `Asset` already had every
field needed (kind, chain, contract, decimals, country, fiatCode, active), so there is no `Asset` schema
change and no provider-specific column on it.

## `SettlementAssetResolver` (`@kaada/domain`)

- `resolveCurrency({ chainId, fiatCode })`: `RESOLVED` (exactly one active token on the chain marked as
  that currency), `AMBIGUOUS` (several: all returned, none chosen) or `UNSUPPORTED`
  (`NO_SETTLEMENT_ASSET`).
- `resolveAsset({ chainId, assetId })`: a fiat asset resolves like its currency; a token resolves to
  itself if active and on the chain. Otherwise `UNKNOWN_ASSET`, `ASSET_INACTIVE` or `WRONG_CHAIN`.

"Eligible" says nothing about providers or ownership. `CELO_CHAIN_ID = 42220`.

## `ProviderCapabilityRegistry` (`@kaada/domain`)

Reads `ProviderCapability` rows through `ProviderRepository`; no Prisma shapes leak. A pair is supported
only when a row says so for exactly that chain, input and output, in that direction.

- `getCapabilitiesForPair`, `getProvidersForPair({ capability, alsoRequire })`, `supportsPair`
- `getCapabilitiesForProvider(slug)`, `getSettlementCapabilities({ chainId, assetId?, countryCode?, capability? })`

Capability types stay distinct: `QUOTE`, `SWAP`, `EXACT_INPUT`, `EXACT_OUTPUT`, `ON_RAMP`, `OFF_RAMP`,
`BANK_PAYOUT`, `CONDITIONAL_EXECUTION`. No type implies another. Disabled providers and disabled rows
never appear.

**Cache**: one process-local snapshot of the active capabilities, TTL 60 s, shared in-flight refresh, a
failed refresh is not cached, `invalidate()` forces a re-read. The database stays authoritative. Quotes
are never cached.

## `RoutingCandidateResolver` and `RoutingCandidateSet`

`resolve(RoutingRequest)` returns `READY` with a `RoutingCandidateSet`, or `UNSUPPORTED`:

```
{ intentId, intentRevision, userId, chainId, operation, purpose,
  amount: { denomination, assetId, mode, humanValue, money },
  requiredCapabilities,                 // PAYMENT: QUOTE+SWAP+mode; QUOTE: QUOTE+mode
  source / destination: { denomination, origin, candidates: [{ assetId, symbol, kind, providers }] },
  pairs: [{ sourceAssetId, destinationAssetId, kind: DIRECT | CONVERSION, providers: [{ slug, capabilities }] }],
  explicitSourceAssetId, recipient?, destinationCountry? }
```

It holds no rate, converted amount, fee, quote, route or balance. Source candidates come from the
explicit asset, the explicit "use USDT" preference (which must be a settlement asset of the amount's
currency), or, with neither, the supported USD settlement assets (`DEFAULT_FUNDING`): a statement of what
Kaada supports, not what the user owns. The set is valid only for `intentRevision`
(`isCandidateSetCurrent`). The agent wires the single `onIntentRevised` hook (it logs
`agent.intent.revised`); candidates are recomputed on demand, so nothing is persisted yet.

Outcomes (`UNSUPPORTED`, with safe text and details): `NO_SETTLEMENT_ASSET`, `SOURCE_ASSET_UNSUPPORTED`,
`DESTINATION_ASSET_UNSUPPORTED`, `AMBIGUOUS_SETTLEMENT_ASSET` (several non-USD tokens still serve a
side; several USD stablecoins are interchangeable and are all returned), `NO_PROVIDER_FOR_PAIR`,
`PROVIDER_CAPABILITY_UNAVAILABLE` (a provider serves the pair but lacks a needed type).

## Seeded data and provenance

`pnpm db:seed` also runs `seedCeloAssets` and `seedProviderCapabilities` (idempotent).

| Asset | Address (Celo 42220)                         | Decimals | Source                                                                                                      |
| ----- | -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| USDT  | `0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e` | 6        | Celo announcement "Tether Token (USDT) Is Now Available on Celo"; on-chain name `Tether USD`, symbol `USD₮` |
| USDC  | `0xceba9300f2b948710d2653dd7b07f33a8b32118c` | 6        | Circle developer docs, USDC contract addresses (Celo mainnet); on-chain name/symbol `USDC`                  |

Both were also confirmed on chain on 2026-10-09 (eth_call to `https://forno.celo.org`: chain id, contract
code, `name()`, `symbol()`, `decimals()`), and both carry `fiatCode = USD`. "USDT" is Kaada's canonical
label; the on-chain symbol is the Tether sign.

**Not seeded (blocker: no authoritative address or decimals found; none may be guessed)**: wBRL, wARS,
wMXN, wCOP, wPEN, wCLP, cNGN, IDRX, USA₮. **No provider capability is seeded**: the Textile corridors and
their directions and exact modes, and Ripio's on/off-ramp and payout coverage, could not be confirmed
from the providers' own documentation or API. `verifiedCapabilities` in `seed/capabilities.ts` is empty
until each entry can be cited; a capability whose assets are missing is skipped, never invented. As a
consequence, every real send currently resolves to `NO_SETTLEMENT_ASSET` / `NO_PROVIDER_FOR_PAIR`.

Capability uniqueness: migration `20261011000000_provider_capability_uniqueness` adds a NULL-safe unique
expression index over provider, type, chain, input, output and country, so duplicates are impossible
even under concurrent seeding; seeding itself is find-or-create and never overrides a disabled row.
