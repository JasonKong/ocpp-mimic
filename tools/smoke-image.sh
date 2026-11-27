#!/usr/bin/env bash
# Runs an ocpp-mimic image the way docs/examples/docker-compose.yml does (the
# engine, and the built-in CSMS in the engine's network namespace) and checks
# the version, the Web UI, the API token and a station charging through the API,
# then `demo` in one container, reached from outside with the token.
# Usage: tools/smoke-image.sh <image> [expected version]
set -euo pipefail
image=$1
expected=${2:-}
name=ocpp-mimic-smoke-$$
token=smoke-$RANDOM-$RANDOM
port=${SMOKE_PORT:-17301}
cleanup() { docker rm -f "$name-engine" "$name-csms" "$name-demo" > /dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== version"
version=$(docker run --rm "$image" --version)
echo "$version"
if [ -n "$expected" ]; then test "$version" = "$expected"; fi

echo "== engine and CSMS"
docker run -d --name "$name-engine" -p "127.0.0.1:$port:7300" \
  -e OCPP_MIMIC_API_TOKEN="$token" "$image" > /dev/null
docker run -d --name "$name-csms" --network "container:$name-engine" \
  "$image" csms --port 9100 --status 0 > /dev/null
api="http://127.0.0.1:$port"
auth="authorization: Bearer $token"
for _ in $(seq 1 100); do curl -sf "$api/api/health" > /dev/null && break; sleep 0.2; done
curl -sf "$api/api/health" | grep -q "\"version\":\"$version\""
curl -sf "$api/" | grep -q '<div id="app"'
test "$(curl -s -o /dev/null -w '%{http_code}' "$api/api/stations")" = 401

echo "== a session"
curl -sf -X POST "$api/api/stations" -H "$auth" -H 'content-type: application/json' \
  -d '{"id":"IMG-1","persona":"generic-2.1","csmsUrl":"ws://127.0.0.1:9100/ocpp"}' > /dev/null
for _ in $(seq 1 50); do
  curl -sf -H "$auth" "$api/api/stations/IMG-1" | grep -q '"registration":"Accepted"' && break
  sleep 0.2
done
curl -sf -H "$auth" "$api/api/stations/IMG-1" | grep -q '"registration":"Accepted"'
curl -sf -X POST "$api/api/stations/IMG-1/connectors/1/plug" -H "$auth" \
  -H 'content-type: application/json' -d '{"ev":"compact-40kwh"}' > /dev/null
curl -sf -X POST "$api/api/stations/IMG-1/remote-start" -H "$auth" \
  -H 'content-type: application/json' -d '{"idToken":{"idToken":"TAG-001"}}' | grep -q '"status":"Accepted"'
for _ in $(seq 1 50); do
  curl -sf -H "$auth" "$api/api/stations/IMG-1/sessions" | grep -q '"state":"running"' && break
  sleep 0.2
done
curl -sf -H "$auth" "$api/api/stations/IMG-1/sessions" | grep -q '"state":"running"'

echo "== stations survive a restart (the store in /data)"
docker restart "$name-engine" > /dev/null
for _ in $(seq 1 100); do curl -sf "$api/api/health" > /dev/null && break; sleep 0.2; done
curl -sf -H "$auth" "$api/api/stations/IMG-1" | grep -q '"id":"IMG-1"'

echo "== demo in a container"
demo_port=${SMOKE_DEMO_PORT:-17401}
docker run -d --name "$name-demo" -p "127.0.0.1:$demo_port:7300" \
  -e OCPP_MIMIC_API_TOKEN="$token" "$image" demo --host 0.0.0.0 > /dev/null
demo="http://127.0.0.1:$demo_port"
for _ in $(seq 1 100); do curl -sf "$demo/api/health" > /dev/null && break; sleep 0.2; done
curl -sf "$demo/" | grep -q '<div id="app"'
test "$(curl -s -o /dev/null -w '%{http_code}' "$demo/api/stations")" = 401
curl -sf -X POST "$demo/api/stations" -H "$auth" -H 'content-type: application/json' \
  -d '{"id":"DEMO-IMG","persona":"generic-dual-2.1","csmsUrl":"ws://127.0.0.1:9100/ocpp"}' > /dev/null
for _ in $(seq 1 50); do
  curl -sf -H "$auth" "$demo/api/stations/DEMO-IMG" | grep -q '"csms":"builtin"' && break
  sleep 0.2
done
curl -sf -X POST "$demo/api/stations/DEMO-IMG/auto-start" -H "$auth" \
  -H 'content-type: application/json' -d '{"idToken":{"idToken":"VALET"}}' | grep -q '"VALET"'
curl -sf -X POST "$demo/api/stations/DEMO-IMG/connectors/1/plug" -H "$auth" \
  -H 'content-type: application/json' -d '{"ev":"compact-40kwh"}' > /dev/null
for _ in $(seq 1 50); do
  curl -sf -H "$auth" "$demo/api/stations/DEMO-IMG/sessions" | grep -q '"state":"running"' && break
  sleep 0.2
done
curl -sf -H "$auth" "$demo/api/stations/DEMO-IMG/sessions" | grep -q '"state":"running"'

echo "ok: $image ($version)"
