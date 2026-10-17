# syntax=docker/dockerfile:1.7
#
# Kaada API (apps/api, @kaada/api). Two deployable targets built from one build stage:
#
#   docker build --target api      -t kaada-api .       the NestJS API, production dependencies only
#   docker build --target migrator -t kaada-migrator .  `prisma migrate deploy` (and `db seed`), nothing else
#
# Multi-platform (linux/amd64, linux/arm64) on a glibc base: @node-rs/argon2 ships prebuilt glibc binaries for both, and
# Prisma's schema engine is downloaded for the platform being built. apps/web is not part of this image.
#
# Nothing secret is baked in. All configuration arrives as environment variables at run time (see deploy/.env.example).

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.15.1

# ─────────────────────────────────────────────────────────────────────────────
# base: Node, the OS packages every target needs, and pnpm (activated at BUILD time).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION

# openssl: Prisma's schema engine needs libssl 3 (not in the slim image). ca-certificates: outbound HTTPS (RPC, Groq, Textile).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The runtime user is the image's built-in unprivileged `node` user (uid 1000). It owns every directory it writes to, so
# nothing at build time or at run time ever needs root.
ENV COREPACK_HOME=/home/node/.corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/home/node/.local/share/pnpm \
    PATH=/home/node/.local/share/pnpm:$PATH
RUN mkdir -p /home/node/.corepack /home/node/.local/share/pnpm /repo /app \
 && chown -R node:node /home/node /repo /app \
 && corepack enable

USER node
# pnpm is fetched once, here, and cached under COREPACK_HOME. Nothing downloads a package manager when a container starts.
RUN corepack prepare pnpm@${PNPM_VERSION} --activate

# ─────────────────────────────────────────────────────────────────────────────
# builder: FULL install (devDependencies included: the Prisma CLI, tsx, solc for contracts#generate, turbo, typescript),
# then prisma generate and every workspace package the API imports, then the API.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS builder
# CI=true keeps pnpm non-interactive. It is set here (and so inherited by the migrator), never in the runtime image.
ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /repo

# Dependency layer: only manifests, so source edits do not invalidate the install. Every workspace package.json that exists
# in the build context must be listed (apps/web is deliberately absent; see .dockerignore).
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node packages/attestation/package.json packages/attestation/package.json
COPY --chown=node:node packages/blockchain/package.json packages/blockchain/package.json
COPY --chown=node:node packages/config/package.json packages/config/package.json
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/database/package.json packages/database/package.json
COPY --chown=node:node packages/domain/package.json packages/domain/package.json
COPY --chown=node:node packages/eslint-config/package.json packages/eslint-config/package.json
COPY --chown=node:node packages/logger/package.json packages/logger/package.json
COPY --chown=node:node packages/providers/package.json packages/providers/package.json
COPY --chown=node:node packages/schemas/package.json packages/schemas/package.json
COPY --chown=node:node packages/tsconfig/package.json packages/tsconfig/package.json
COPY --chown=node:node packages/utils/package.json packages/utils/package.json

RUN --mount=type=cache,id=kaada-pnpm-store,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile --store-dir /home/node/.local/share/pnpm/store

# Source. `turbo run build --filter=@kaada/api...` builds the API and everything it depends on, in order, running the
# `generate` tasks first (prisma generate for @kaada/database; solc compile for @kaada/contracts). No database is needed.
COPY --chown=node:node . .
RUN pnpm exec turbo run build --filter=@kaada/api...

# ─────────────────────────────────────────────────────────────────────────────
# migrator: the full build tree plus the Prisma CLI, running `prisma migrate deploy` in packages/database.
#
# The entrypoint is the Prisma binary baked into node_modules. There is no pnpm run, no corepack, and no install at run time.
# NODE_ENV is deliberately NOT set here (CI=true is inherited from the builder). Override the command to seed once on a new database:
#   docker run --rm --network alpha --env-file .env <migrator image> db seed
# ─────────────────────────────────────────────────────────────────────────────
FROM builder AS migrator
WORKDIR /repo/packages/database
# `prisma db seed` runs `tsx prisma/seed.ts`; both binaries are resolved from node_modules, never from the network.
ENV PATH=/repo/packages/database/node_modules/.bin:/repo/node_modules/.bin:$PATH
USER node
ENTRYPOINT ["/repo/packages/database/node_modules/.bin/prisma"]
CMD ["migrate", "deploy"]

# ─────────────────────────────────────────────────────────────────────────────
# prod-tree: the API's production dependencies only, with every built workspace package copied in (their `files` is `dist`,
# which holds the compiled Prisma client under dist/generated/prisma). Dropped: devDependencies, solc, TypeScript, the Prisma
# CLI, tests and sources. A separate stage so the migrator image does not carry a second copy of node_modules.
# ─────────────────────────────────────────────────────────────────────────────
FROM builder AS prod-tree
RUN pnpm --filter @kaada/api deploy --legacy --prod /home/node/out \
 && rm -rf /home/node/out/src /home/node/out/test /home/node/out/scripts /home/node/out/tsconfig.json /home/node/out/tsconfig.build.json /home/node/out/eslint.config.js /home/node/out/nest-cli.json

# ─────────────────────────────────────────────────────────────────────────────
# api: the lean runtime image. Built last, so a plain `docker build .` produces the API.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production \
    PORT=3005 \
    API_HOST=0.0.0.0
WORKDIR /app
COPY --from=prod-tree --chown=node:node /home/node/out/package.json ./package.json
COPY --from=prod-tree --chown=node:node /home/node/out/node_modules ./node_modules
COPY --from=prod-tree --chown=node:node /home/node/out/dist ./dist

USER node
EXPOSE 3005
# Liveness only (never the database): a flapping database must not make Docker mark the API unhealthy. The deploy script
# checks readiness (/api/health/ready) itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3005)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
