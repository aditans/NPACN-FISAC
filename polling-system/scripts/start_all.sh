#!/usr/bin/env zsh
# Start the full stack for the polling demo (C server, Node bridge, frontend)
# Usage:
#   BRIDGE_WS_PORT=3001 BRIDGE_API_PORT=3002 C_SERVER_HOST=127.0.0.1 C_SERVER_PORT=8080 \
#     COSMOS_ENDPOINT="..." COSMOS_KEY="..." COSMOS_DB_ID=npacn \
#     ./start_all.sh

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOGDIR="$ROOT/logs"
mkdir -p "$LOGDIR"

# Defaults (can be overridden via env)
: ${C_SERVER_HOST:=127.0.0.1}
: ${C_SERVER_PORT:=8080}
: ${BRIDGE_WS_PORT:=3001}
: ${BRIDGE_API_PORT:=3002}
: ${FRONTEND_PORT:=5173}
: ${RUN_TESTS:=0}

# COSMOS defaults (can be provided via env or CLI args)
: ${COSMOS_ENDPOINT:=""}
: ${COSMOS_KEY:=""}
: ${COSMOS_DB_ID:=""}

# Simple CLI parsing to allow passing COSMOS values and override defaults
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cosmos-endpoint)
      COSMOS_ENDPOINT="$2"; shift 2;;
    --cosmos-key)
      COSMOS_KEY="$2"; shift 2;;
    --cosmos-db)
      COSMOS_DB_ID="$2"; shift 2;;
    --c-server-host)
      C_SERVER_HOST="$2"; shift 2;;
    --c-server-port)
      C_SERVER_PORT="$2"; shift 2;;
    --bridge-ws-port)
      BRIDGE_WS_PORT="$2"; shift 2;;
    --bridge-api-port)
      BRIDGE_API_PORT="$2"; shift 2;;
    --help)
      echo "Usage: $0 [--cosmos-endpoint URL] [--cosmos-key KEY] [--cosmos-db ID]"; exit 0;;
    *)
      echo "Unknown arg: $1"; shift;;
  esac
done

echo "[start_all] root=$ROOT"
echo "[start_all] Target C server: $C_SERVER_HOST:$C_SERVER_PORT"
if [ -n "$COSMOS_ENDPOINT" ]; then
  echo "[start_all] Cosmos endpoint: $COSMOS_ENDPOINT (db=$COSMOS_DB_ID)"
else
  echo "[start_all] Cosmos endpoint: (not set)"
fi
echo "[start_all] Bridge WS port: $BRIDGE_WS_PORT API port: $BRIDGE_API_PORT"

stop_if_running() {
  local name="$1"
  local pid_file="$LOGDIR/${name}.pid"
  if [ ! -f "$pid_file" ]; then
    return
  fi

  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "[start_all] Stopping existing $name process ($pid)"
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  else
    echo "[start_all] Removing stale $name pid file ($pid)"
  fi

  rm -f "$pid_file"
}

echo "[start_all] Cleaning up previously started services (if any)"
stop_if_running polling_server
stop_if_running bridge
stop_if_running frontend

cd "$ROOT/polling-system"

echo "[start_all] Building C server (make)"
make || { echo "make failed"; exit 1; }

if [ "$RUN_TESTS" -ne 0 ]; then
  echo "[start_all] Running tests"
  ./test_polling || echo "tests failed (continuing)"
fi

# Start the polling server (background)
if [ -x ./polling_server ]; then
  echo "[start_all] Starting polling_server (background)"
  # Export COSMOS env if provided in caller environment
  ( nohup env COSMOS_ENDPOINT="${COSMOS_ENDPOINT:-}" COSMOS_KEY="${COSMOS_KEY:-}" COSMOS_DB_ID="${COSMOS_DB_ID:-}" ./polling_server > "$LOGDIR/polling_server.log" 2>&1 & echo $! > "$LOGDIR/polling_server.pid" )
  sleep 1
else
  echo "[start_all] polling_server binary not found at $PWD/polling_server"
fi

cd "$ROOT/polling-system/frontend"

echo "[start_all] Ensuring frontend dependencies (npm install)"
if [ ! -d node_modules ]; then
  npm install
fi

echo "[start_all] Starting Node bridge (background)"
env C_SERVER_HOST="$C_SERVER_HOST" C_SERVER_PORT="$C_SERVER_PORT" BRIDGE_WS_PORT="$BRIDGE_WS_PORT" BRIDGE_API_PORT="$BRIDGE_API_PORT" NODE_PATH="$PWD/node_modules" nohup node ../bridge.js > "$LOGDIR/bridge.log" 2>&1 &
echo $! > "$LOGDIR/bridge.pid"

sleep 1

echo "[start_all] Starting frontend dev server (background)"
# Start Vite dev server in background; can also run in foreground by removing &
nohup npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" > "$LOGDIR/frontend.log" 2>&1 &
echo $! > "$LOGDIR/frontend.pid"

sleep 1

echo "[start_all] Started components. PIDs:"
for f in polling_server bridge frontend; do
  if [ -f "$LOGDIR/${f}.pid" ]; then
    echo -n "$f: "; cat "$LOGDIR/${f}.pid"; echo
  fi
done

echo "[start_all] Bridge API status (may take a second to become available):"
if command -v curl >/dev/null 2>&1; then
  sleep 1
  curl -sS "http://localhost:${BRIDGE_API_PORT}/server/status" || echo "(status endpoint not reachable yet)"
else
  echo "curl not installed; check logs in $LOGDIR"
fi

echo "[start_all] Logs:"
echo " - polling server: $LOGDIR/polling_server.log"
echo " - bridge:          $LOGDIR/bridge.log"
echo " - frontend:        $LOGDIR/frontend.log"

echo "[start_all] To stop everything, kill the pids in $LOGDIR/*.pid"

exit 0
