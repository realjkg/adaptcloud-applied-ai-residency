#!/usr/bin/env bash
set -euo pipefail

app_log=$(mktemp)
collector_log=$(mktemp)
app_pid=""

cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" >/dev/null 2>&1 || true; fi
  docker compose -f compose.otel.yaml down --volumes >/dev/null 2>&1 || true
  rm -f "$app_log" "$collector_log"
}
trap cleanup EXIT

docker compose -f compose.otel.yaml up -d collector
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:13133/ >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:13133/ >/dev/null

PORT=3103 \
APP_ENV=development \
TELEMETRY_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=student-residency-integration \
node dist/src/bootstrap.js >"$app_log" 2>&1 &
app_pid=$!

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3103/health/live >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3103/health/live >/dev/null
curl -fsS -X POST http://127.0.0.1:3103/api/assess -H 'content-type: application/json' --data-binary @examples/client-intake.json >/dev/null
kill -TERM "$app_pid"
wait "$app_pid"
app_pid=""
sleep 3
docker compose -f compose.otel.yaml logs --no-color collector >"$collector_log"

grep -q 'http.request' "$collector_log"
grep -q 'student-residency-integration' "$collector_log"
grep -q '"type":"request.completed"' "$app_log"
! grep -q 'Summarize maintenance reports' "$collector_log" "$app_log"
! grep -Eiq 'x-api-key|authorization|x-authenticated-subject' "$collector_log" "$app_log"

printf '%s\n' 'OpenTelemetry integration acceptance passed.'
