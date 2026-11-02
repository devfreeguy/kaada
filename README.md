# Kaada

Kaada is an agentic cross-border payment router built on Celo. It turns a payment intent
(from an agent or a chat channel) into a quoted, policy-checked route across FX and fiat
on/off-ramp providers, and executes it on-chain.

This repository currently contains the monorepo foundation and the persistence layer (Prisma schema,
migrations, seed). There is no business logic yet.

## Architecture

```
apps  →  shared packages  →  domain
```

- `domain` is pure TypeScript and depends on nothing in the workspace.
- Infrastructure packages (`database`, `providers`, `blockchain`) implement ports defined by the
  domain; Prisma, provider SDKs, and chain SDKs stay inside their own package.
- Apps compose packages. Packages never import from apps, and there are no circular dependencies.
- All packages are ESM (NestJS 12 is ESM-only) and compile to `dist/` with `tsc`. Consumers
  import them by name, e.g. `@kaada/config`.
- Entity IDs are UUIDv4 from `node:crypto` (`randomUUID`); no UUID library.

## Layout

| Path                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `apps/api`               | NestJS + Fastify API, global `/api` prefix, Pino logging   |
| `apps/web`               | Next.js 16 (App Router) + Tailwind CSS                     |
| `packages/domain`        | Pure domain model boundaries (money, quotes, routing, ...) |
| `packages/schemas`       | Zod schemas shared across API, agent, and channels         |
| `packages/database`      | Persistence layer (Prisma lands here in Build 2)           |
| `packages/providers`     | FX, ramp, and LLM provider adapters                        |
| `packages/blockchain`    | Celo, wallet, and RPC access                               |
| `packages/config`        | Typed, Zod-validated environment configuration             |
| `packages/logger`        | Shared Pino options with sensitive-field redaction         |
| `packages/utils`         | Intentionally minimal shared primitives                    |
| `packages/eslint-config` | Shared ESLint flat configs (`base`, `nest`, `next`)        |
| `packages/tsconfig`      | Shared strict TS configs (`node`, `nest`, `next`)          |

## Prerequisites

- **Node.js 24** (`.nvmrc`; `engines` asks for `>=24`, and the Docker image and CI use 24)
- **pnpm 11.15.1** (the `packageManager` pin in `package.json`). `corepack enable` picks it up. Any other pnpm 11 also runs: it prints a
  warning and carries on (`pmOnFail: warn` in `pnpm-workspace.yaml`) and never tries to download the pinned version.

## How to run

From a fresh clone, with the versions above:

```sh
pnpm install --frozen-lockfile   # the only step that needs the network (public npm registry, no tokens)
pnpm build
pnpm typecheck
pnpm test
```

Build, typecheck and tests need **no secrets, no `.env` and no database**. The network is needed only to install packages from the public npm
registry (and for Prisma's engine download during install). The `test:integration` scripts do need a database and are not part of `pnpm test`.
The API and the web app need the settings in `.env.example` only when you start them.

## Installation

```sh
pnpm install
cp .env.example .env   # then set DATABASE_URL (and DATABASE_DIRECT_URL) in .env
```

The API requires a PostgreSQL database (Neon): `DATABASE_URL` is mandatory at startup.

## Development

```sh
pnpm dev          # api on :4000, web on :3000, packages in watch mode
pnpm build        # build everything via Turborepo
pnpm lint         # ESLint (type-aware)
pnpm typecheck    # tsc --noEmit in every package
pnpm format       # Prettier write
pnpm format:check # Prettier check
pnpm test         # unit tests (domain, schemas, config, database)
```

Settlement assets and provider capabilities: see [docs/settlement.md](docs/settlement.md).
Wallet architecture and the passkey/smart-account foundation: see [docs/wallet-architecture.md](docs/wallet-architecture.md). Route planning: see [docs/routing.md](docs/routing.md). Textile RFQ adapter: see [docs/textile.md](docs/textile.md). Firm quotes and the pre-signing plan: [docs/execution-planning.md](docs/execution-planning.md). Onchain execution, Textile submit and settlement (off by default, `EXECUTION_ENABLED`; **never run live**): [docs/execution.md](docs/execution.md).

Database (see [docs/database.md](docs/database.md)):

```sh
pnpm db:generate        # generate the Prisma client
pnpm db:migrate         # create/apply migrations in development
pnpm db:migrate:deploy  # apply committed migrations (Neon / CI)
pnpm db:seed            # idempotent foundation seed
pnpm db:studio
pnpm --filter @kaada/database test:integration   # repository round trips (rolled back)
pnpm --filter @kaada/api test:integration        # agent core on the real database
pnpm --filter @kaada/api smoke:groq              # live Groq check (needs GROQ_API_KEY; not CI)
```

Health: `GET /api/health` (liveness) and `GET /api/health/ready` (readiness, checks the database;
503 when it is unreachable).

Workspace packages are consumed from their built `dist/`. Turbo builds dependencies before
`dev`, `lint`, and `typecheck`, and each package's `dev` task rebuilds on change. The API restarts
when its own source changes; after editing a workspace package, restart `pnpm dev` if the
change isn't picked up.

## Environment

Configuration is validated at startup by `@kaada/config`; the API exits with a list of every
invalid value. The API loads `.env` from the repository root if present. Real environment
variables take precedence.

| Variable              | Default                 | Notes                                                                                  |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development`           | `development`, `test`, or `production`                                                 |
| `PORT`                | `4000`                  | API port                                                                               |
| `API_HOST`            | `0.0.0.0`               | API bind address                                                                       |
| `WEB_URL`             | `http://localhost:3000` | Public URL of the web app                                                              |
| `CORS_ORIGINS`        | `WEB_URL`               | Comma-separated allowed origins                                                        |
| `LOG_LEVEL`           | `info`                  | `fatal` … `trace`, or `silent`                                                         |
| `DATABASE_URL`        | required                | Postgres URL; the Neon pooled connection                                               |
| `DATABASE_DIRECT_URL` | `DATABASE_URL`          | Prisma CLI migrations only (Neon direct connection)                                    |
| `AGENT_INTERPRETER`   | `none`                  | `none`, `mock` (development only) or `groq`; see docs/agent.md                         |
| `FX_PROVIDER`         | `none`                  | `none`, `mock` (made-up prices, never in production) or `textile`; see docs/textile.md |
| `GROQ_API_KEY`        | none                    | Required when `AGENT_INTERPRETER=groq`                                                 |

Everything that is not a secret or a per-deployment fact (pool sizes, timeouts, TTLs, models, the recovery delay) is fixed in
`packages/config/src/settings.ts`; per-network contract addresses are in `deployments.ts`. `.env.example` lists every variable.

Logs are pretty-printed in `development` and JSON otherwise. Authorization headers, cookies,
and common secret fields (`password`, `token`, `apiKey`, ...) are redacted.

## Deployed contracts and sample transactions

Everything below is on Celo mainnet (chain 42220). Addresses come from `packages/config/src/deployments.ts`.

### Contracts

| Contract                           | Address                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Recovery validator                 | [`0xd60997aeaD07583D4325C8dB4c0dc4092F376058`](https://celoscan.io/address/0xd60997aeaD07583D4325C8dB4c0dc4092F376058) |
| Recovery relayer                   | [`0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4`](https://celoscan.io/address/0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4) |
| Passkey validator clone factory    | [`0x959234caAeBA2bbF300B85548C86544A748d7Ee5`](https://celoscan.io/address/0x959234caAeBA2bbF300B85548C86544A748d7Ee5) |
| Device-key validator clone factory | [`0x317eAa61c11D660AFaa61451C2fae0e22686766D`](https://celoscan.io/address/0x317eAa61c11D660AFaa61451C2fae0e22686766D) |

### Agent identity (ERC-8004)

Kaada's platform wallet, [`0x92fd470fC469585749a3CedA736A1e426F7D85D5`](https://celoscan.io/address/0x92fd470fC469585749a3CedA736A1e426F7D85D5), owns agent ID **10022** in the ERC-8004 Identity Registry
[`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432).

- Identity (NFT page): <https://celoscan.io/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/10022>
- Registration file: <https://www.kaada.xyz/.well-known/agent-registration.json> (source: `apps/web/public/.well-known/agent-registration.json`)

### Sample transactions

All succeeded on chain. The attribution tag is `celo_51c4a2ae2240` (ERC-8021).

| Transaction                                                                                                    | What it is                                                      |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`0xf7437d94…c285`](https://celoscan.io/tx/0xf7437d94a87b6f578bd3072ffff2c69afe2a608461047ff4977c3e3a2c76c285) | Registration of agent ID 10022, sent from the platform wallet   |
| [`0xef4e70aa…19a6`](https://celoscan.io/tx/0xef4e70aa1e3c14381f95360614d07aabdca365177036dd20b878426039b119a6) | Tagged transaction from the platform wallet to itself (value 0) |
| [`0x3bdb5353…02de`](https://celoscan.io/tx/0x3bdb5353e69b58d96c9e44b89358a44eedcb97bd6b0cd55b84d918b4010602de) | Wallet transfer of CELO                                         |
| [`0xf7ffd190…e8b2`](https://celoscan.io/tx/0xf7ffd19070474add79ff9574ad1311d942ae3348eaf9cadbfc277398f30ce8b2) | Wallet transfer of CELO                                         |
| [`0xdf12d30b…5117`](https://celoscan.io/tx/0xdf12d30ba83ecbbd44723577e44316c409ce080882f6ee37efd06d3deebd5117) | Wallet transfer of cNGN                                         |
| [`0x3904eb8d…aa8e`](https://celoscan.io/tx/0x3904eb8ddec30f628a39f01c7386c361adaa60f8f3587b340a462261be99aa8e) | Account setup and permission install (not a payment)            |

The three transfers are between two of the team's own test accounts.

Where the tag is, and why it differs:

- **Platform wallet transactions** (the registration and the tagged self-transfer) are ordinary transactions. The tag is at the very end of the transaction input, where ERC-8021 indexers look.
- **User wallet transactions** (the transfers and the account setup) are ERC-4337 UserOperations. They reach the chain through the EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (`handleOps`), and the tag is at the end of each UserOperation's inner `callData`, not at the end of the outer transaction input.

### Verify a transaction

`packages/blockchain/verify-attribution.ts` is read-only: no keys, no database. It fetches each transaction over Celo RPC and prints whether it succeeded, whether the tag is present anywhere in the input, whether it is at the very end of the input, whether the inner `callData` of each UserOperation ends with it, and the `to` address.

```sh
pnpm install
cd packages/blockchain
pnpm exec tsx verify-attribution.ts 0xef4e70aa1e3c14381f95360614d07aabdca365177036dd20b878426039b119a6 \
  0x3bdb5353e69b58d96c9e44b89358a44eedcb97bd6b0cd55b84d918b4010602de
```

`CELO_RPC_URL` overrides the default public endpoint (`https://forno.celo.org`).
