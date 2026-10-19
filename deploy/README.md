# Deploying the Kaada API

The API (`apps/api`) runs as a container on the OCI ARM64 VM (Ubuntu 24.04), behind Caddy at `https://api.kaada.xyz`. The web
app is not deployed from here. Every push to `main` runs `.github/workflows/deploy-production.yml`:

```
verify (typecheck + test) -> build both images, amd64 + arm64 -> check both manifests -> sync files -> deploy.sh
```

| Piece            | Where                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Images           | `ghcr.io/devfreeguy/kaada-api:<tag>` and `ghcr.io/devfreeguy/kaada-migrator:<tag>` (the tag is the first 12 characters of the commit) |
| Server directory | `/opt/apps/kaada/`                                                                                                                    |
| Compose file     | `/opt/apps/kaada/compose.yml` (synced by CI from `deploy/compose.yml`)                                                                |
| Deploy script    | `/opt/apps/kaada/scripts/deploy.sh` (synced by CI)                                                                                    |
| App settings     | `/opt/apps/kaada/.env` (**never** synced; you create it)                                                                              |
| Current version  | `/opt/apps/kaada/image.env` (written by `deploy.sh` after a healthy deploy)                                                           |
| Service          | `kaada.service` (systemd), after `infra.service`                                                                                      |
| Container        | `kaada-api`, bound to `127.0.0.1:3005`                                                                                                |
| Database / Redis | the shared `postgres` and `redis` containers on the external `alpha` network                                                          |

## First-time server setup

Run once, on the VM. `deploy` below stands for the user CI logs in as (`SERVER_USER`).

```bash
# 1. Directory, owned by the deploy user
sudo mkdir -p /opt/apps/kaada/scripts
sudo chown -R deploy:deploy /opt/apps/kaada
sudo chmod 750 /opt/apps/kaada

# 2. The network must already exist (the shared infra stack creates it)
docker network inspect alpha >/dev/null

# 3. Application settings. Copy deploy/.env.example from the repository and fill in every REPLACE.
nano /opt/apps/kaada/.env
chmod 600 /opt/apps/kaada/.env
```

Fill `.env` from [`.env.example`](./.env.example). The rules that matter: no quotes, no inline comments, no `$` in values.
`DATABASE_URL` and `DATABASE_DIRECT_URL` are the same `postgres:5432/kaada_db` connection (there is no pooler).
Generate the secrets on the server:

```bash
openssl rand -hex 32      # PIN_PEPPER, TELEGRAM_WEBHOOK_SECRET
openssl rand -base64 32   # EXECUTION_SECRET_KEY, RECOVERY_CHALLENGE_SECRET, RECOVERY_TOTP_SECRET_KEY (three different values)
```

### Platform / agent wallet key (required in production)

Kaada's one platform wallet is a dedicated EOA: its public identity on Celo and the future recipient of service fees. It is not a user
wallet and user payments never use it. Host file `/opt/apps/kaada/secrets/platform-agent.key` (**must start with `0x`, then exactly 64 hex
characters: one 32-byte private key and nothing else**; owner 1000:1000, mode 400; never commit it), mounted read-only by `compose.yml`
as `/run/secrets/platform-agent.key` (`PLATFORM_WALLET_KEY_FILE`). Print its public address (and nothing else) with
`deploy/scripts/platform-address.mjs` (usage in the file header), put that in `PLATFORM_WALLET_ADDRESS`, and the API will refuse to start if
the key ever derives to a different address.

### Recovery relayer key (only when recovery is enabled)

The recovery relayer is a hot operational key: it submits recovery initiation and pays that gas. It does not have anyone's Recovery Code,
cannot forge or cancel a recovery and controls no user funds. It is a file, never an environment variable and never part of an image:

```bash
# host:  /opt/apps/kaada/secrets/recovery-relayer.key  (directory 1000:1000 mode 500, file 1000:1000 mode 400)
# exactly one 32-byte private key: "0x" followed by 64 hex characters (the 0x is required), one line; never commit it
```

`compose.yml` mounts exactly that one file read-only as `/run/secrets/recovery-relayer.key`, and `.env` points
`RECOVERY_RELAYER_KEY_FILE` at it. At startup the API derives the key's address and refuses to start unless it equals the relayer recorded
for `RECOVERY_NETWORK` in `packages/config/src/deployments.ts` (the validator only accepts `initiate` from the address it was deployed with).
Fund that address with a little CELO and watch its balance: if it is empty or the key is lost, nobody can start a recovery.
No server key can approve a recovery. The mainnet contracts are deployed (addresses in `deployments.ts`, details in `docs/recovery-contracts.md`); the
relayer there is `0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4`. `RECOVERY_ENABLED=true` and `DEVICE_KEY_ROOTS_ENABLED=true` also need `RECOVERY_CHALLENGE_SECRET` and
`RECOVERY_TOTP_SECRET_KEY`, and the relayer also pays for device-key setup, so keep it funded.

### Recovery email (SMTP)

Use the discrete settings; there is no URL, so a password with `# $ & ^ { } @ : / %` needs no encoding:

```ini
RECOVERY_SMTP_HOST=smtp.example.com
RECOVERY_SMTP_PORT=587
RECOVERY_SMTP_USER=...
RECOVERY_SMTP_PASSWORD_FILE=/run/secrets/recovery-smtp-password
RECOVERY_SMTP_SECURITY=starttls
RECOVERY_EMAIL_FROM=Kaada Security <security@kaada.xyz>
```

- **The password file is preferred over putting the password in `.env`.** Host file `/opt/apps/kaada/secrets/recovery-smtp-password`
  (owner 1000:1000, mode 400), mounted read-only by `compose.yml`. The whole file is the password; only the trailing newline is removed.
  Create it with `printf '%s' 'the-password' > ...` (or an editor: a trailing newline is fine). It must exist before `docker compose up`,
  or Docker creates a directory at that path.
  `RECOVERY_SMTP_PASSWORD` is the alternative; set exactly one of the two.
- `starttls` (default, port 587) makes the connection upgrade to TLS and **fails the send if the server will not**. `tls` (usually
  port 465) is implicit TLS. There is no plaintext mode.
- `RECOVERY_EMAIL_FROM` must be **unquoted** in `.env`: Docker's `env_file` keeps quotes as part of the value.
- `RECOVERY_SMTP_URL` still works but is **deprecated**; it is mutually exclusive with the settings above (both together stop startup).
- Only the three secret files above are mounted into the container, each individually and read-only. The host `secrets` directory is
  never mounted as a whole.

> **Do not rotate `PIN_PEPPER` or `EXECUTION_SECRET_KEY` casually.** Changing `PIN_PEPPER` makes every existing PIN unverifiable.
> Changing `EXECUTION_SECRET_KEY` makes everything already encrypted with it unreadable. To rotate the key, raise
> `EXECUTION_SECRET_KEY_VERSION` and move the old key to `EXECUTION_SECRET_KEY_PREVIOUS`.

```bash
# 4. The version file. The first deploy replaces it; this makes a reboot before then a no-op instead of an error.
printf 'IMAGE_OWNER=devfreeguy\nREPO_NAME=kaada\nIMAGE_TAG=none\n' > /opt/apps/kaada/image.env
chmod 600 /opt/apps/kaada/image.env
```

```ini
# 5. /etc/systemd/system/kaada.service
[Unit]
Description=Kaada API
Requires=infra.service
After=infra.service docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=deploy
WorkingDirectory=/opt/apps/kaada
EnvironmentFile=/opt/apps/kaada/image.env
ExecStart=/usr/bin/docker compose -f /opt/apps/kaada/compose.yml --env-file /dev/null up -d --no-deps kaada-api
ExecStop=/usr/bin/docker compose -f /opt/apps/kaada/compose.yml --env-file /dev/null stop kaada-api

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable kaada.service     # do not start it yet: there is no image until the first deploy
```

```
# 6. Caddy: add to the Caddyfile, then `sudo systemctl reload caddy`
api.kaada.xyz {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3005
}
```

DNS: an `A` record for `api.kaada.xyz` pointing at `129.213.16.57`.

### GitHub

Repository secrets used by the workflow: `SERVER_HOST`, `SERVER_USER`, `SERVER_KEY` (the SSH private key for `SERVER_USER`).
Recommended: also add `SERVER_KNOWN_HOSTS` (the output of `ssh-keyscan -H 129.213.16.57`) so the host key is pinned; without it
the workflow trusts the key it sees on each run. The workflow pushes images with the built-in `GITHUB_TOKEN`; after the first push,
make sure the two packages allow this repository to write (Package settings -> Manage Actions access). The VM pulls with the
same short-lived token, passed to `deploy.sh` for that run only.

### First deploy: seed the reference data once

The migrations create the tables but not the reference rows (assets, providers, provider capabilities). On a new database, run
the seed once after the first successful deploy. It is idempotent and, with `NODE_ENV=production` from `.env`, never adds the
development mock provider:

```bash
docker run --rm --network alpha --env-file /opt/apps/kaada/.env \
  ghcr.io/devfreeguy/kaada-migrator:<tag> db seed
```

### Telegram webhook

The API does not register its own webhook. From a machine with the repository, set `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` (the same values as the server) and
`TELEGRAM_WEBHOOK_URL=https://api.kaada.xyz/api/v1/channels/telegram/webhook`, then run
`pnpm --filter @kaada/api telegram:webhook set`.

## Deploying

Push to `main` (or run the workflow by hand). `deploy.sh` then:

1. logs in to GHCR, pulls **both** images, logs out (any failed pull stops here, nothing changed);
2. runs the migrator against the database (a failed migration stops here, the running API is untouched);
3. recreates `kaada-api` from the new image;
4. waits for `GET /api/health/ready` (the database answers; up to two minutes);
5. only after that, rewrites `image.env` atomically with the new tag;
6. prunes dangling images.

If the new API never becomes ready, the script prints its last log lines and exits non-zero **without** touching `image.env`.
Liveness is `GET /api/health`; the container also carries a Docker health check on it.

Useful commands on the VM:

```bash
docker logs -f kaada-api
docker ps --filter name=kaada-api
curl -s http://localhost:3005/api/health/ready
```

## Rollback

Redeploy an earlier image. Tags are commit prefixes, so pick one from the workflow history (or `docker images`), then either
re-run an earlier workflow run, or on the VM:

```bash
export IMAGE_OWNER=devfreeguy REPO_NAME=kaada IMAGE_TAG=<an earlier tag>
export GHCR_USER=<github user> GHCR_TOKEN=<a token with read:packages>
bash /opt/apps/kaada/scripts/deploy.sh
```

> **`prisma migrate deploy` never reverses a migration.** Rolling the API back does not roll the database back. The migrator of the
> older tag finds nothing to apply and the older API then runs against the newer schema. That is safe only if the newer
> migrations were backward compatible (additive). Before shipping a destructive migration (a dropped or renamed column or table),
> take a database backup and plan the rollback separately; undoing one means restoring the backup or writing a new forward
> migration.

## What is in the images

- `api`: Node 24 on Debian (glibc), non-root `node` user, production dependencies only (no TypeScript, no Prisma CLI, no solc), the
  built workspace packages and the generated Prisma client. Listens on `PORT` (3005).
- `migrator`: the full build tree with the Prisma CLI. Its entrypoint is the baked-in `prisma` binary in `packages/database`
  (no pnpm, no corepack, no install at run time); the default command is `migrate deploy`.
- Neither image contains a secret. Everything comes from `/opt/apps/kaada/.env` at run time.
