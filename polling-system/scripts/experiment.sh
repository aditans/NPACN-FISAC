#!/usr/bin/env bash
# Simple experiment harness for the polling system
# Usage: ./experiment.sh <count> <delayMs> <uniqueClients:true|false> <noDelay:true|false> <keepAlive:true|false>

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
COUNT=${1:-50}
DELAY_MS=${2:-10}
UNIQUE=${3:-true}
NODELAY=${4:-true}
KEEPALIVE=${5:-false}
BASE_URL=${BRIDGE_API_URL:-http://localhost:3002}
POLL_ID=${POLL_ID:-poll-1}
CHOICE_ID=${CHOICE_ID:-c}

TS=$(date +%s)
OUT=/tmp/polling-experiment-$TS.json

echo "Experiment: count=$COUNT delayMs=$DELAY_MS unique=$UNIQUE noDelay=$NODELAY keepAlive=$KEEPALIVE"

# build socketOptions object
SOCK_OPTS="{\"noDelay\":${NODELAY},\"keepAlive\":${KEEPALIVE},\"keepAliveDelay\":1000}"

# run
START=$(date +%s%3N)
RESPONSE=$(curl -sS -X POST ${BASE_URL}/simulate/burst -H 'Content-Type: application/json' -d "{\"clientId\":\"exp-${TS}\",\"pollId\":\"${POLL_ID}\",\"choiceId\":\"${CHOICE_ID}\",\"count\":${COUNT},\"delayMs\":${DELAY_MS},\"uniqueClients\":${UNIQUE},\"socketOptions\":${SOCK_OPTS}}") || true
END=$(date +%s%3N)
DUR=$((END-START))

# collect some server-side log snippets (best-effort)
BRIDGE_LOG=/home/kali/Documents/NPACN-FISAC/polling-system/logs/bridge.log
SERVER_LOG=/home/kali/Documents/NPACN-FISAC/polling-system/logs/polling_server.log
BRIDGE_SNIPPET=$(tail -n 200 "$BRIDGE_LOG" 2>/dev/null || true)
SERVER_SNIPPET=$(tail -n 200 "$SERVER_LOG" 2>/dev/null || true)

cat > "$OUT" <<EOF
{
  "timestamp": "$TS",
  "count": $COUNT,
  "delayMs": $DELAY_MS,
  "uniqueClients": $UNIQUE,
  "socketOptions": { "noDelay": $NODELAY, "keepAlive": $KEEPALIVE },
  "durationMs": $DUR,
  "response": $RESPONSE,
  "bridgeLogTail": "$(echo "$BRIDGE_SNIPPET" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')",
  "serverLogTail": "$(echo "$SERVER_SNIPPET" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')"
}
EOF

echo "Wrote results to $OUT (duration ${DUR}ms)"

# show summary
jq -r '. | {durationMs, attempted: .response.attempted, okCount: ([.response.results[] | select(.result.ok==true)] | length), failures: ([.response.results[] | select(.result.ok==false)] | length)}' "$OUT" 2>/dev/null || cat "$OUT"

echo "Done"

# Also copy result to experiments/ if folder exists
EXP_DIR="$SCRIPT_DIR/../experiments"
if [ -d "$EXP_DIR" ]; then
  cp -f "$OUT" "$EXP_DIR/$(basename "$OUT")"
fi
