#!/usr/bin/env bash
# Consolidated experiment runner for NPACN-FISAC polling system
# - Restarts the stack (start_all.sh)
# - Waits for bridge and polling_server to be ready
# - Runs a small / medium / large set of experiments using experiment.sh
# - Collects JSON outputs into experiments/ and produces a CSV summary

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
EXPERIMENTS_DIR="$ROOT_DIR/experiments"
mkdir -p "$EXPERIMENTS_DIR"

# Configuration (override via env)
BRIDGE_API_URL=${BRIDGE_API_URL:-http://localhost:3002}
FRONTEND_PORT=${FRONTEND_PORT:-5173}
BRIDGE_WS_PORT=${BRIDGE_WS_PORT:-3001}
BRIDGE_API_PORT=${BRIDGE_API_PORT:-3002}
C_SERVER_HOST=${C_SERVER_HOST:-127.0.0.1}
C_SERVER_PORT=${C_SERVER_PORT:-8080}
# COSMOS envs: if needed export them before running this script.

# internal helpers
log() { echo "[run_experiments] $*"; }
wait_for_http() {
  local url=$1
  local attempts=${2:-30}
  local delay=${3:-1}
  for i in $(seq 1 $attempts); do
    if curl -sS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep $delay
  done
  return 1
}

# 1) Restart the stack
log "Restarting stack using start_all.sh (this may take a few seconds)..."
cd "$ROOT_DIR"
# Note: start_all.sh expects environment variables; we reuse local ones
# call the start script relative to the polling-system folder (we are already in polling-system)
C_SERVER_HOST="$C_SERVER_HOST" C_SERVER_PORT="$C_SERVER_PORT" \
BRIDGE_WS_PORT="$BRIDGE_WS_PORT" BRIDGE_API_PORT="$BRIDGE_API_PORT" \
FRONTEND_PORT="$FRONTEND_PORT" ./scripts/start_all.sh &
START_PID=$!
log "start_all.sh launched (PID=$START_PID)"

# 2) Wait for bridge API to be available
log "Waiting for bridge API at $BRIDGE_API_URL ..."
if ! wait_for_http "$BRIDGE_API_URL/server/status" 60 2; then
  log "ERROR: Bridge API did not become ready in time. Check logs: polling-system/logs/bridge.log"
  exit 2
fi
log "Bridge API ready"

# 3) Prepare experiment parameters (small/medium/large)
SCENARIOS=("small:20:10:true:true:false" "medium:200:10:true:true:false" "large:1000:5:true:true:false")
# Format: name:count:delayMs:unique:noDelay:keepAlive

RESULTS_JSON=()

# 4) Run scenarios sequentially and collect outputs
for scenario in "${SCENARIOS[@]}"; do
  IFS=":" read -r name count delayMs unique noDelay keepAlive <<< "$scenario"
  timestamp=$(date +%s)
  out=/tmp/polling-experiment-${name}-${timestamp}.json
  log "Running scenario $name: count=$count delayMs=$delayMs unique=$unique noDelay=$noDelay keepAlive=$keepAlive"
  # call existing experiment.sh
  "$SCRIPT_DIR/experiment.sh" "$count" "$delayMs" "$unique" "$noDelay" "$keepAlive"
  # experiment.sh writes to /tmp/polling-experiment-<ts>.json; move the latest file matching exp-${timestamp}
  # find the most recent /tmp file
  recent=$(ls -t /tmp/polling-experiment-*.json 2>/dev/null | head -n1 || true)
  if [ -n "$recent" ]; then
    dest="$EXPERIMENTS_DIR/$(basename "$recent" | sed 's/^polling-//')"
    mv "$recent" "$dest" || cp -f "$recent" "$dest"
    RESULTS_JSON+=("$dest")
    log "Saved result to $dest"
  else
    log "Warning: no result file generated for $name"
  fi
  # short cooldown between runs
  sleep 2
done

# 5) Produce a CSV summary from JSON results (if jq available)
CSV="$EXPERIMENTS_DIR/summary.csv"
if command -v jq >/dev/null 2>&1; then
  echo "file,durationMs,attempted,okCount,failures" > "$CSV"
  for f in "${RESULTS_JSON[@]}"; do
    duration=$(jq -r '.durationMs // -1' "$f" 2>/dev/null || echo -1)
    attempted=$(jq -r '.response.attempted // -1' "$f" 2>/dev/null || echo -1)
    okCount=$(jq -r '([.response.results[] | select(.result.ok==true)] | length) // 0' "$f" 2>/dev/null || echo 0)
    failures=$(jq -r '([.response.results[] | select(.result.ok==false)] | length) // 0' "$f" 2>/dev/null || echo 0)
    echo "$(basename "$f"),$duration,$attempted,$okCount,$failures" >> "$CSV"
  done
  log "Wrote CSV summary to $CSV"
else
  log "jq not available; skipping CSV summary. Results in $EXPERIMENTS_DIR"
fi

log "Done. Results stored in $EXPERIMENTS_DIR"
log "You can inspect JSON files and the CSV summary (if created)."

exit 0
