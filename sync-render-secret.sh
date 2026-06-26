#!/bin/bash
# sync-render-secret.sh — every 5 min (via launchd), re-seed the info-kierowca
# session from the live Chrome cookies and push it to the Render secret file,
# so Render always has a FRESH seed to fall back on when it (re)starts.
#
# NOTE: updating the secret file does NOT change the already-running Render
# container — Render reads the secret only at container start. So this keeps
# the *cold-start* seed fresh; pass --deploy to also trigger a redeploy (which
# restarts the watcher, so it actually re-logs-in with the fresh session).
set -uo pipefail

DIR="/Users/mateuszwojczal/Desktop/localhost/exam-watcher"
cd "$DIR" || exit 1
mkdir -p "$DIR/.run"
LOG="$DIR/.run/render-sync.log"
SID="srv-d8uce1jtqb8s73b3fdc0"
KEY="$(cat "$DIR/.render-key" 2>/dev/null)"
ts() { date "+%Y-%m-%dT%H:%M:%S"; }

if [ -z "$KEY" ]; then echo "$(ts) no .render-key — abort" >>"$LOG"; exit 1; fi

# 1. Re-seed from Chrome. Exits non-zero if not logged in (no __Secure-PUDOJT).
if ! python3 seed-storagestate.py >>"$LOG" 2>&1; then
  echo "$(ts) seed failed — Chrome session not available, skipping" >>"$LOG"
  exit 0
fi

# 2. Push the fresh seed to the Render secret file.
python3 -c "import json; print(json.dumps({'content': open('storageState.json').read()}))" > /tmp/ik_sf.json
code=$(curl -s -X PUT "https://api.render.com/v1/services/$SID/secret-files/storageState.json" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/ik_sf.json -o /dev/null -w "%{http_code}")
rm -f /tmp/ik_sf.json
echo "$(ts) secret update HTTP $code" >>"$LOG"

# 3. Optional redeploy so the running watcher picks up the fresh session now.
if [ "${1:-}" = "--deploy" ]; then
  /opt/homebrew/bin/render deploys create "$SID" --confirm -o text >>"$LOG" 2>&1 \
    && echo "$(ts) redeploy triggered" >>"$LOG"
fi
