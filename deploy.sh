#!/usr/bin/env bash
# s-maker deploy script.
#
# Usage:   ./deploy.sh [branch]        (default branch: main)
#
# What it does:
#   1. clones the repo (first run) or fetches the requested branch
#   2. checks <deploy root>/.env (creates it from .env.example on first run)
#   3. builds a new Docker image tagged with the commit hash (old app keeps running meanwhile)
#   4. stops the old container and backs up the data volume
#   5. starts the new container and waits for /health
#   6. on failure: restores the backup and brings the previous container back
#   7. removes old images and backups
#
# Settings (environment variables, optional):
#   SMAKER_DEPLOY_ROOT  where repo, .env and backups live   (default: $HOME/s-maker)
#   SMAKER_REPO_URL     git URL                              (default: the public GitHub repo)
#
# Layout of the deploy root:
#   repo/      git checkout used for builds (do not edit by hand, it is reset on every deploy)
#   .env       configuration and secrets (chmod 600)
#   backups/   data volume backups, one tar.gz per deploy
#
# The whole script lives inside main() so bash reads it completely before running:
# updating the repo (which contains this file) cannot corrupt a running deploy.

main() {
  set -Eeuo pipefail

  local REPO_URL="${SMAKER_REPO_URL:-https://github.com/data2048/s-maker.git}"
  local DEPLOY_ROOT="${SMAKER_DEPLOY_ROOT:-$HOME/s-maker}"
  local BRANCH="${1:-main}"

  local CONTAINER=s-maker
  local PREV_CONTAINER=s-maker-prev
  local IMAGE_REPO=s-maker
  local VOLUME=s-maker-data
  local PORT=44566
  local KEEP_IMAGES=3
  local KEEP_BACKUPS=14
  local HEALTH_TIMEOUT=90

  local REPO_DIR="$DEPLOY_ROOT/repo"
  local ENV_FILE="$DEPLOY_ROOT/.env"
  local BACKUP_DIR="$DEPLOY_ROOT/backups"

  # Variables required in .env. New PRs append to this list.
  local REQUIRED_VARS=(PUBLIC_URL ADMIN_USERNAME)

  # ---- helpers ----
  log() { printf '\033[1;35m[deploy]\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m[deploy] WARNING:\033[0m %s\n' "$*" >&2; }
  die() {
    printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2
    exit 1
  }
  env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
  container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

  # ---- 0. preflight ----
  local t
  for t in git docker curl; do
    command -v "$t" >/dev/null 2>&1 || die "'$t' is not installed"
  done
  docker info >/dev/null 2>&1 || die "cannot talk to Docker (is the daemon running and is your user in the 'docker' group?)"
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid branch name: $BRANCH"
  mkdir -p "$DEPLOY_ROOT" "$BACKUP_DIR"

  # ---- 1. code ----
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    log "cloning $REPO_URL"
    git clone --quiet "$REPO_URL" "$REPO_DIR"
  fi
  log "fetching branch '$BRANCH'"
  git -C "$REPO_DIR" fetch --quiet --prune origin
  git -C "$REPO_DIR" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null || die "branch '$BRANCH' not found on origin"
  git -C "$REPO_DIR" checkout --quiet -B deploy "origin/$BRANCH"
  git -C "$REPO_DIR" reset --quiet --hard "origin/$BRANCH"
  local COMMIT
  COMMIT="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
  log "commit $COMMIT: $(git -C "$REPO_DIR" log -1 --format=%s)"

  # If the branch has a newer deploy.sh than the one running, continue with that one.
  if [[ "${SMAKER_DEPLOY_REEXEC:-}" != 1 ]] && ! cmp -s "${BASH_SOURCE[0]}" "$REPO_DIR/deploy.sh"; then
    log "deploy.sh differs in the repo, re-running with the repo version"
    SMAKER_DEPLOY_REEXEC=1 exec bash "$REPO_DIR/deploy.sh" "$@"
  fi

  # ---- 2. configuration ----
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    die "created $ENV_FILE from the template: fill it in and run deploy.sh again"
  fi
  if [[ "$(stat -c '%a' "$ENV_FILE")" != 600 ]]; then
    warn "$ENV_FILE is readable by other users, fixing permissions to 600"
    chmod 600 "$ENV_FILE"
  fi
  local missing=() v
  for v in "${REQUIRED_VARS[@]}"; do
    [[ -n "$(env_value "$v")" ]] || missing+=("$v")
  done
  # Variables added to .env.example after the first deploy.
  local new_vars
  new_vars="$(grep -oE '^[A-Z0-9_]+=' "$REPO_DIR/.env.example" | tr -d '=' | while read -r k; do
    grep -qE "^$k=" "$ENV_FILE" || echo "$k"
  done)"
  if [[ -n "$new_vars" ]]; then
    warn "these settings exist in .env.example but not in your .env (defaults will be used):"
    printf '           %s\n' $new_vars >&2
  fi
  ((${#missing[@]} == 0)) || die "missing values in $ENV_FILE: ${missing[*]}"
  if grep -qE '^[A-Z0-9_]+=["'"'"']' "$ENV_FILE"; then
    die "$ENV_FILE contains quoted values; remove the quotes (docker --env-file keeps them literally)"
  fi

  local BIND
  BIND="$(env_value BIND_ADDRESS)"
  BIND="${BIND:-127.0.0.1}"
  local HEALTH_HOST="$BIND"
  [[ "$HEALTH_HOST" == 0.0.0.0 ]] && HEALTH_HOST=127.0.0.1

  # ---- 3. build (the old container keeps serving meanwhile) ----
  local IMAGE="$IMAGE_REPO:$COMMIT"
  log "building $IMAGE"
  docker build --pull --quiet --build-arg "APP_VERSION=$COMMIT" -t "$IMAGE" -t "$IMAGE_REPO:latest" "$REPO_DIR" >/dev/null

  # ---- 4. stop old container, back up data ----
  local had_previous=0 BACKUP_FILE=""

  # From here on any failure puts the previous version back.
  rollback() {
    trap - ERR
    set +e
    warn "deploy failed, rolling back"
    docker logs --tail 60 "$CONTAINER" 2>&1 | sed 's/^/           | /' >&2 || true
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [[ -n "$BACKUP_FILE" ]]; then
      log "restoring data from backups/$BACKUP_FILE"
      docker run --rm --user 0 --entrypoint sh \
        -v "$VOLUME:/data" -v "$BACKUP_DIR:/backup:ro" -e "FILE=$BACKUP_FILE" \
        "$IMAGE" -c 'find /data -mindepth 1 -delete && tar -C /data -xzf "/backup/$FILE" && chown -R node:node /data'
    fi
    if ((had_previous)); then
      docker rename "$PREV_CONTAINER" "$CONTAINER"
      docker start "$CONTAINER" >/dev/null
      log "previous version is running again"
    fi
    die "new version did not become healthy; see the logs above"
  }

  if container_exists "$PREV_CONTAINER"; then docker rm -f "$PREV_CONTAINER" >/dev/null; fi
  if container_exists "$CONTAINER"; then
    log "stopping current container"
    docker stop -t 30 "$CONTAINER" >/dev/null
    docker rename "$CONTAINER" "$PREV_CONTAINER"
    had_previous=1
  fi
  trap rollback ERR

  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    BACKUP_FILE="smaker-$(date -u +%Y%m%dT%H%M%SZ)-$COMMIT.tar.gz"
    log "backing up data volume to backups/$BACKUP_FILE"
    docker run --rm --user 0 --entrypoint sh \
      -v "$VOLUME:/data:ro" -v "$BACKUP_DIR:/backup" \
      -e "OWNER=$(id -u):$(id -g)" -e "FILE=$BACKUP_FILE" \
      "$IMAGE" -c 'tar -C /data -czf "/backup/$FILE" . && chown "$OWNER" "/backup/$FILE"'
  fi

  # ---- 5. start new container ----
  log "starting $IMAGE on $BIND:$PORT"
  if ! docker run -d --name "$CONTAINER" \
    --env-file "$ENV_FILE" \
    -e "APP_VERSION=$COMMIT" \
    -p "$BIND:$PORT:$PORT" \
    -v "$VOLUME:/data" \
    --read-only --tmpfs /tmp:rw,size=64m \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 1g --pids-limit 256 \
    --log-opt max-size=10m --log-opt max-file=5 \
    --restart unless-stopped \
    "$IMAGE" >/dev/null; then
    rollback
  fi

  # ---- 6. health check ----
  log "waiting for http://$HEALTH_HOST:$PORT/health"
  local waited=0
  until curl -fsS --max-time 3 "http://$HEALTH_HOST:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]] || ((waited >= HEALTH_TIMEOUT)); then
      rollback
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "healthy after ${waited}s"
  trap - ERR

  # ---- 7. clean up ----
  if container_exists "$PREV_CONTAINER"; then docker rm "$PREV_CONTAINER" >/dev/null; fi
  local old
  old="$(docker image ls "$IMAGE_REPO" --format '{{.Tag}}' | grep -vE '^(latest|<none>)$' | grep -vx "$COMMIT" | tail -n +"$KEEP_IMAGES" || true)"
  for t in $old; do docker rmi "$IMAGE_REPO:$t" >/dev/null 2>&1 || true; done
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/smaker-*.tar.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
  docker image prune -f >/dev/null 2>&1 || true

  log "deployed $COMMIT ($BRANCH)"

  # First start: show the admin setup link printed by the app.
  local setup
  setup="$(docker logs "$CONTAINER" 2>&1 | grep -o 'ADMIN SETUP LINK: [^"]*' | tail -n 1 || true)"
  [[ -n "$setup" ]] && log "$setup"
  return 0
}

main "$@"
exit $?
