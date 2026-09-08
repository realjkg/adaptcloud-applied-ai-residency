#!/usr/bin/env bash
set -euo pipefail

image_tag=${IMAGE_TAG:?IMAGE_TAG is required}
run_token=${GITHUB_RUN_ID:-local}-$$
open_name="residency-open-${run_token}"
gateway_name="residency-gateway-${run_token}"
open_log=$(mktemp)
gateway_log=$(mktemp)

cleanup() {
  docker rm -f "$open_name" "$gateway_name" >/dev/null 2>&1 || true
  rm -f "$open_log" "$gateway_log"
}
trap cleanup EXIT

uid=$(docker run --rm --entrypoint node "$image_tag" -e 'process.stdout.write(String(process.getuid?.() ?? 0))')
test "$uid" != "0"

docker run -d --name "$open_name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:3101:3000 \
  -e APP_ENV=development -e TELEMETRY_EXPORTER=console \
  "$image_tag" >/dev/null

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3101/health/live >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3101/health/live >/dev/null
curl -fsS http://127.0.0.1:3101/health/ready | grep -q '"status":"ready"'
curl -fsS -X POST http://127.0.0.1:3101/api/assess -H 'content-type: application/json' --data-binary @examples/client-intake.json | grep -q '"mode":"deterministic"'
status=$(head -c 70000 /dev/zero | tr '\0' x | curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3101/api/assess --data-binary @-)
test "$status" = "413"
docker stop --time 10 "$open_name" >/dev/null
docker logs "$open_name" >"$open_log" 2>&1
grep -q '"type":"service.shutdown"' "$open_log"

docker run -d --name "$gateway_name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:3102:3000 \
  -e APP_ENV=sandbox -e AUTH_MODE=gateway -e TELEMETRY_EXPORTER=console \
  "$image_tag" >/dev/null

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3102/health/live >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3102/health/live >/dev/null
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3102/api/assess -H 'content-type: application/json' --data-binary @examples/client-intake.json)
test "$status" = "401"
curl -fsS -X POST http://127.0.0.1:3102/api/assess -H 'content-type: application/json' -H 'x-authenticated-subject: synthetic-student' --data-binary @examples/client-intake.json | grep -q '"mode":"deterministic"'
docker stop --time 10 "$gateway_name" >/dev/null
docker logs "$gateway_name" >"$gateway_log" 2>&1
! grep -q 'Summarize maintenance reports' "$open_log" "$gateway_log"

printf '%s\n' 'Container runtime acceptance passed.'
