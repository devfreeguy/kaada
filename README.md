# Kaada

Kaada is an agentic cross-border payment router built on Celo. It turns a payment intent
(from an agent or a chat channel) into a quoted, policy-checked route across FX and fiat
on/off-ramp providers, and executes it on-chain.

This repository currently contains only the monorepo foundation: tooling, package boundaries,
and a minimal API and web app. There is no business logic or database schema yet.

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

- Node.js 24 (`.nvmrc`)
- pnpm 11 (`corepack enable` picks up the pinned version)

## Installation

```sh
pnpm install
cp .env.example .env
```

## Development

```sh
pnpm dev          # api on :4000, web on :3000, packages in watch mode
pnpm build        # build everything via Turborepo
pnpm lint         # ESLint (type-aware)
pnpm typecheck    # tsc --noEmit in every package
pnpm format       # Prettier write
pnpm format:check # Prettier check
```

Health check: `GET http://localhost:4000/api/health`.

Workspace packages are consumed from their built `dist/`. Turbo builds dependencies before
`dev`, `lint`, and `typecheck`, and each package's `dev` task rebuilds on change. The API restarts
when its own source changes; after editing a workspace package, restart `pnpm dev` if the
change isn't picked up.

## Environment

Configuration is validated at startup by `@kaada/config`; the API exits with a list of every
invalid value. The API loads `.env` from the repository root if present. Real environment
variables take precedence.

| Variable       | Default                 | Notes                                  |
| -------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`     | `development`           | `development`, `test`, or `production` |
| `PORT`         | `4000`                  | API port                               |
| `API_HOST`     | `0.0.0.0`               | API bind address                       |
| `WEB_URL`      | `http://localhost:3000` | Public URL of the web app              |
| `CORS_ORIGINS` | `WEB_URL`               | Comma-separated allowed origins        |
| `LOG_LEVEL`    | `info`                  | `fatal` … `trace`, or `silent`         |

Logs are pretty-printed in `development` and JSON otherwise. Authorization headers, cookies,
and common secret fields (`password`, `token`, `apiKey`, ...) are redacted.
