#!/usr/bin/env bash
# Runs the whole stack locally, without Docker.
#
#   scripts/dev.sh up        start everything (idempotent — safe to re-run)
#   scripts/dev.sh down      stop everything
#   scripts/dev.sh status    health-check each service
#   scripts/dev.sh logs      tail the service logs
#   scripts/dev.sh reset     drop the dev database and start fresh
#
# Docker is the supported way to deploy; this is for working on the code. Everything it
# creates lives in .devdata/ inside the repo, which is gitignored — deliberately NOT in
# /tmp, because macOS reaps /tmp after a few days and silently corrupts a Postgres cluster
# left there.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV="$ROOT/.devdata"
PGDATA="$DEV/pg"
LOGS="$DEV/logs"
PGPORT="${PGPORT:-55432}"
PGSOCK=/tmp/cfpg               # short path: the socket name has a 103-byte limit
API_PORT="${API_PORT:-4000}"
OCR_PORT="${OCR_PORT:-8000}"
ADMIN_PORT="${ADMIN_PORT:-3000}"
DB_NAME=chevella_stall
DB_USER=cf

# Homebrew's Postgres aborts at startup with "postmaster became multithreaded" unless the
# locale is pinned.
export LC_ALL=C LANG=C

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

find_pg() {
  for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin \
           /usr/local/opt/postgresql@17/bin /usr/lib/postgresql/17/bin; do
    [ -x "$d/pg_ctl" ] && { echo "$d"; return; }
  done
  command -v pg_ctl >/dev/null && { dirname "$(command -v pg_ctl)"; return; }
  die "PostgreSQL not found. Install it with: brew install postgresql@17"
}

# onnxruntime has no wheels for very new Pythons, so pick a version that is known to work
# rather than whatever `python3` happens to be.
find_python() {
  for p in python3.12 python3.11 python3.13 \
           /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12; do
    command -v "$p" >/dev/null 2>&1 && { command -v "$p"; return; }
    [ -x "$p" ] && { echo "$p"; return; }
  done
  die "Need Python 3.11-3.13 for the OCR service (onnxruntime has no wheels for 3.14+)."
}

PGBIN="$(find_pg)"
export PATH="$PGBIN:$PATH"

# ------------------------------------------------------------------ postgres

pg_running() {
  pg_ctl -D "$PGDATA" status >/dev/null 2>&1
}

start_pg() {
  mkdir -p "$PGSOCK" "$LOGS"

  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    # A half-reaped directory is worse than no directory.
    [ -d "$PGDATA" ] && rm -rf "$PGDATA"
    mkdir -p "$PGDATA"
    initdb -U "$DB_USER" --auth=trust -E UTF8 --locale=C "$PGDATA" >"$LOGS/initdb.log" 2>&1 \
      || die "initdb failed — see $LOGS/initdb.log"
    ok "created a fresh Postgres cluster in .devdata/pg"
  fi

  if pg_running; then
    ok "postgres already running on :$PGPORT"
  else
    pg_ctl -D "$PGDATA" \
      -o "-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1" \
      -l "$LOGS/postgres.log" start >/dev/null 2>&1 \
      || die "postgres failed to start — see $LOGS/postgres.log"
    sleep 2
    ok "postgres started on :$PGPORT"
  fi

  for _ in $(seq 1 20); do
    psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres -c 'select 1' >/dev/null 2>&1 && break
    sleep 1
  done

  if ! psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    createdb -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" "$DB_NAME"
    ok "created database $DB_NAME"
  fi
}

# ------------------------------------------------------------------ env

ensure_env() {
  if [ -f cf-api/.env ]; then
    ok "cf-api/.env present"
  else
    cat > cf-api/.env <<ENVEOF
# Local development only. Never deploy with these values.
NODE_ENV=development
PORT=$API_PORT
DATABASE_URL=postgres://$DB_USER@127.0.0.1:$PGPORT/$DB_NAME
JWT_SECRET=dev-only-insecure-jwt-secret-change-for-production
DEVICE_API_KEY=dev-device-key-local
IP_HASH_SALT=dev-salt
PUBLIC_BASE_URL=http://localhost:$ADMIN_PORT
API_PUBLIC_URL=http://localhost:$ADMIN_PORT
CORS_ORIGINS=http://localhost:$ADMIN_PORT
OCR_URL=http://127.0.0.1:$OCR_PORT
SEED_ADMIN_NAME=Chevella Admin
SEED_ADMIN_EMAIL=admin@chevellafarms.com
SEED_ADMIN_PASSWORD=LocalDevPassword123
ENVEOF
    ok "wrote cf-api/.env (admin: admin@chevellafarms.com / LocalDevPassword123)"
  fi

  if [ ! -f cf-admin/.env.local ]; then
    echo "API_INTERNAL_URL=http://127.0.0.1:$API_PORT" > cf-admin/.env.local
    ok "wrote cf-admin/.env.local"
  fi
}

# ------------------------------------------------------------------ services

start_ocr() {
  local venv="$ROOT/cf-ocr/.venv"
  if [ ! -x "$venv/bin/python" ]; then
    local py; py="$(find_python)"
    warn "creating the OCR virtualenv with $py (first run downloads ~100 MB)"
    "$py" -m venv "$venv"
  fi

  if ! "$venv/bin/python" -c 'import rapidocr, cv2, fastapi' >/dev/null 2>&1; then
    warn "installing OCR dependencies — this takes a few minutes the first time"
    "$venv/bin/pip" install -q --disable-pip-version-check -r cf-ocr/requirements.txt \
      || die "pip install failed for cf-ocr"
  fi

  if curl -fsS --max-time 3 "http://127.0.0.1:$OCR_PORT/health" >/dev/null 2>&1; then
    ok "cf-ocr already running on :$OCR_PORT"
    return
  fi

  ( cd cf-ocr && nohup "$venv/bin/uvicorn" src.main:app \
      --host 127.0.0.1 --port "$OCR_PORT" >"$LOGS/ocr.log" 2>&1 & )

  # The models load at boot, so the first start is genuinely slow.
  for _ in $(seq 1 60); do
    curl -fsS --max-time 2 "http://127.0.0.1:$OCR_PORT/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS --max-time 2 "http://127.0.0.1:$OCR_PORT/health" >/dev/null 2>&1 \
    && ok "cf-ocr started on :$OCR_PORT" \
    || warn "cf-ocr did not answer in time — see .devdata/logs/ocr.log (leads still save without it)"
}

start_api() {
  [ -d cf-api/node_modules ] || { warn "installing cf-api dependencies"; (cd cf-api && npm install --no-audit --no-fund >/dev/null); }

  (cd cf-api && npm run migrate >"$LOGS/migrate.log" 2>&1) \
    || { tail -20 "$LOGS/migrate.log"; die "migrations failed"; }
  ok "migrations applied"

  if curl -fsS --max-time 3 "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    ok "cf-api already running on :$API_PORT"
    return
  fi

  ( cd cf-api && nohup node src/server.js >"$LOGS/api.log" 2>&1 & )
  for _ in $(seq 1 20); do
    curl -fsS --max-time 2 "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --max-time 2 "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
    && ok "cf-api started on :$API_PORT" \
    || die "cf-api failed to start — see .devdata/logs/api.log"
}

start_admin() {
  [ -d cf-admin/node_modules ] || { warn "installing cf-admin dependencies"; (cd cf-admin && npm install --no-audit --no-fund >/dev/null); }

  if curl -fsS --max-time 5 "http://localhost:$ADMIN_PORT/login" >/dev/null 2>&1; then
    ok "cf-admin already running on :$ADMIN_PORT"
    return
  fi

  ( cd cf-admin && nohup npx next dev -p "$ADMIN_PORT" >"$LOGS/admin.log" 2>&1 & )
  for _ in $(seq 1 45); do
    curl -fsS --max-time 2 "http://localhost:$ADMIN_PORT/login" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --max-time 2 "http://localhost:$ADMIN_PORT/login" >/dev/null 2>&1 \
    && ok "cf-admin started on :$ADMIN_PORT" \
    || warn "cf-admin is slow to boot — see .devdata/logs/admin.log"
}

# ------------------------------------------------------------------ commands

cmd_up() {
  mkdir -p "$LOGS"
  bold "Starting the Chevella Farms stall app"
  start_pg
  ensure_env
  start_ocr
  start_api
  start_admin
  echo
  bold "Ready"
  echo "  Admin console   http://localhost:$ADMIN_PORT"
  echo "  Web scanner     http://localhost:$ADMIN_PORT/scan"
  echo "  Sign in         admin@chevellafarms.com / LocalDevPassword123"
  echo
  echo "  Logs:  scripts/dev.sh logs      Stop:  scripts/dev.sh down"
}

cmd_down() {
  bold "Stopping"
  pkill -f "node src/server.js" 2>/dev/null && ok "cf-api stopped" || warn "cf-api was not running"
  pkill -f "uvicorn src.main:app" 2>/dev/null && ok "cf-ocr stopped" || warn "cf-ocr was not running"
  pkill -f "next dev -p $ADMIN_PORT" 2>/dev/null && ok "cf-admin stopped" || warn "cf-admin was not running"
  if pg_running; then
    pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 && ok "postgres stopped"
  else
    warn "postgres was not running"
  fi
}

cmd_status() {
  bold "Status"
  pg_running && ok "postgres   :$PGPORT" || warn "postgres   :$PGPORT  down"
  curl -fsS --max-time 3 "http://127.0.0.1:$OCR_PORT/health" >/dev/null 2>&1 \
    && ok "cf-ocr     :$OCR_PORT" || warn "cf-ocr     :$OCR_PORT  down"
  curl -fsS --max-time 3 "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
    && ok "cf-api     :$API_PORT" || warn "cf-api     :$API_PORT  down"
  curl -fsS --max-time 5 "http://localhost:$ADMIN_PORT/login" >/dev/null 2>&1 \
    && ok "cf-admin   :$ADMIN_PORT" || warn "cf-admin   :$ADMIN_PORT  down"

  echo
  curl -s --max-time 5 "http://localhost:$API_PORT/api/v1/health" 2>/dev/null \
    | python3 -m json.tool 2>/dev/null || true
}

cmd_logs() {
  tail -n 40 -f "$LOGS"/*.log
}

cmd_reset() {
  read -r -p "Drop the local dev database and all its leads? [y/N] " yn
  [ "$yn" = "y" ] || { echo "cancelled"; exit 0; }
  cmd_down
  rm -rf "$PGDATA"
  ok "dev database removed — run 'scripts/dev.sh up' to rebuild it"
}

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  reset)  cmd_reset ;;
  *)      echo "usage: scripts/dev.sh [up|down|status|logs|reset]"; exit 1 ;;
esac
