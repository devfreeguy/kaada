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

`pnpm db:seed` also runs `seedCeloAssets` and `seedProviderCapabilities` (both idempotent and cheap to
re-run). Source: Textile's official address book for its live Celo deployment (chain 42220); every
address and `decimals()` was also read on chain from `https://forno.celo.org` on 2026-10-09.

| Asset | Address                                      | Decimals | fiatCode | Country | Kind             |
| ----- | -------------------------------------------- | -------- | -------- | ------- | ---------------- |
| USDT  | `0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e` | 6        | USD      |         | USD_STABLECOIN   |
| USDC  | `0xceba9300f2b948710d2653dd7b07f33a8b32118c` | 6        | USD      |         | USD_STABLECOIN   |
| cNGN  | `0xf6829d7393dae24509eb1e52ee8e572e2e271a4f` | 6        | NGN      | NG      | LOCAL_STABLECOIN |
| wARS  | `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d` | 18       | ARS      | AR      | LOCAL_STABLECOIN |
| wBRL  | `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0` | 18       | BRL      | BR      | LOCAL_STABLECOIN |
| IDRX  | `0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22` | 2        | IDR      | ID      | LOCAL_STABLECOIN |

Addresses are stored lowercase. "USDT" is Kaada's canonical label; its on-chain symbol is `USD₮`.
**cNGN is the Textile token above.** The separate Mento Nigerian Naira token
(`0xe2702bd97ee33c88c8f6f92da3b733608aa76f71`, on-chain symbol NGNm) is a different asset and is not seeded.

**Textile capabilities (40 rows)**: cNGN, USDC, wARS, wBRL and IDRX each trade against USDT. Both
directions of each corridor are separate rows, each with `QUOTE`, `SWAP`, `EXACT_INPUT` (sellAmount) and
`EXACT_OUTPUT` (buyAmount), from the Textile v2 RFQ documentation: 5 x 2 x 4 = 40. `CONDITIONAL_EXECUTION`
and Textile `ON_RAMP` / `OFF_RAMP` / `BANK_PAYOUT` (the separate Ramp API) are not seeded. Ripio capabilities
are not seeded.

**Documented, not persisted or used** (Celo, Textile): LimitOrderReactor
`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`, fee controller `0x7b005466F905DD882A959888154587fA76cd3Ea7`,
Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, fee 1 bps (`textileCeloContracts` in
`celo-assets.ts`). Nothing executes against them yet.

**Not seeded (unverified)**: wMXN, wCOP, wPEN, wCLP, USA₮. They have no Textile support in Kaada.

With this data: BRL resolves to wBRL, ARS to wARS, NGN to cNGN, IDR to IDRX, and USD to USDT + USDC
(offered, not chosen). A candidate set exists for each of those destinations from USDT; USDC has no
corridor to the local tokens, so it is not offered for them.

Capability uniqueness: migration `20261011000000_provider_capability_uniqueness` adds a NULL-safe unique
expression index over provider, type, chain, input, output and country, so duplicates are impossible
even under concurrent seeding; seeding itself is find-or-create and never overrides a disabled row.
