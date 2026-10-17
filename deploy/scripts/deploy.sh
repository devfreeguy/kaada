#!/usr/bin/env bash
# Deploys one image tag of the Kaada API on the server. Run by CI over SSH (see .github/workflows/deploy-production.yml), or by
# hand to roll forward or back: IMAGE_TAG=<an earlier tag> ... ./deploy.sh
#
# Order, and why:
#   1. log in to GHCR, pull BOTH images, log out. A failed pull aborts before anything running is touched.
#   2. run the migrator (prisma migrate deploy). A failed migration aborts before the running container is touched.
#   3. recreate kaada-api from the new image.
#   4. wait for readiness (/api/health/ready: the database answers). A failure leaves image.env alone.
#   5. only then record the tag in image.env (atomically), so a reboot brings back the last GOOD version.
#   6. prune dangling images.
#
# Required environment: IMAGE_OWNER REPO_NAME IMAGE_TAG GHCR_USER GHCR_TOKEN
set -euo pipefail

APP_DIR=/opt/apps/kaada
cd "$APP_DIR"

: "${IMAGE_OWNER:?IMAGE_OWNER is required}"
: "${REPO_NAME:?REPO_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_TOKEN:?GHCR_TOKEN is required}"

# These end up in image names and in image.env, so refuse anything that is not a plain registry name or tag.
[[ "$IMAGE_OWNER" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || { echo "refusing IMAGE_OWNER: not a plain lowercase name" >&2; exit 1; }
[[ "$REPO_NAME" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || { echo "refusing REPO_NAME: not a plain lowercase name" >&2; exit 1; }
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "refusing IMAGE_TAG: not a plain tag" >&2; exit 1; }

[[ -f "$APP_DIR/.env" ]] || { echo "missing $APP_DIR/.env (create it from deploy/.env.example)" >&2; exit 1; }
[[ -f "$APP_DIR/compose.yml" ]] || { echo "missing $APP_DIR/compose.yml" >&2; exit 1; }

API_IMAGE="ghcr.io/${IMAGE_OWNER}/${REPO_NAME}-api:${IMAGE_TAG}"
MIGRATOR_IMAGE="ghcr.io/${IMAGE_OWNER}/${REPO_NAME}-migrator:${IMAGE_TAG}"
export IMAGE_OWNER REPO_NAME IMAGE_TAG

IMAGE_ENV_TMP=""
cleanup() {
  docker logout ghcr.io >/dev/null 2>&1 || true
  [[ -n "$IMAGE_ENV_TMP" && -f "$IMAGE_ENV_TMP" ]] && rm -f "$IMAGE_ENV_TMP"
  return 0
}
trap cleanup EXIT

echo "==> deploying ${IMAGE_TAG}"

# 1. Registry login and pulls. Credentials only ever go over stdin, and are dropped as soon as the pulls are done.
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
pull_ok=1
docker pull "$API_IMAGE" || pull_ok=0
docker pull "$MIGRATOR_IMAGE" || pull_ok=0
docker logout ghcr.io >/dev/null 2>&1 || true
if [[ "$pull_ok" -ne 1 ]]; then
  echo "!! could not pull both images; nothing was changed" >&2
  exit 1
fi

# 2. Migrations, with the same environment file the API uses (DATABASE_DIRECT_URL, falling back to DATABASE_URL). prisma
# migrate deploy only applies pending migrations; it never reverses one. If it fails, the running API is left untouched.
echo "==> applying database migrations"
if ! docker run --rm --network alpha --env-file "$APP_DIR/.env" "$MIGRATOR_IMAGE"; then
  echo "!! migration failed; the running API was not touched" >&2
  exit 1
fi

# 3. Recreate only the API. `--env-file /dev/null` keeps compose from also reading $APP_DIR/.env for interpolation (the service
# still gets it through env_file); the image variables come from this shell.
echo "==> starting ${API_IMAGE}"
docker compose -f "$APP_DIR/compose.yml" --env-file /dev/null up -d --no-deps --force-recreate --pull never kaada-api

# 4. Readiness. The API validates its configuration and connects to the database on boot, so a bad .env fails here.
echo "==> waiting for /api/health/ready"
healthy=0
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 4 http://localhost:3005/api/health/ready >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" -ne 1 ]]; then
  echo "!! kaada-api did not become ready; last log lines:" >&2
  docker logs --tail 60 kaada-api >&2 || true
  echo "!! image.env was NOT updated (it still names the last good tag). Redeploy a good IMAGE_TAG to recover." >&2
  exit 1
fi
echo "==> ready"

# 5. Record the good tag atomically: temp file in the same directory, owner-only, then rename.
IMAGE_ENV_TMP="$(mktemp "$APP_DIR/.image.env.XXXXXX")"
chmod 600 "$IMAGE_ENV_TMP"
{
  printf 'IMAGE_OWNER=%s\n' "$IMAGE_OWNER"
  printf 'REPO_NAME=%s\n' "$REPO_NAME"
  printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG"
} >"$IMAGE_ENV_TMP"
mv -f "$IMAGE_ENV_TMP" "$APP_DIR/image.env"
IMAGE_ENV_TMP=""

# 6. Housekeeping.
docker image prune -f >/dev/null
echo "==> deployed ${IMAGE_TAG}"
