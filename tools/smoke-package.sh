#!/usr/bin/env bash
# Installs a packed ocpp-mimic tarball into a temporary prefix and checks what
# a new user does first: the version, the samples, an example scenario, the
# built-in CSMS and the engine with its Web UI, a station charging through
# the API, and a short load plan.
# Usage: tools/smoke-package.sh <ocpp-mimic-x.y.z.tgz>
# SMOKE_LOAD_DURATION (default 30s) sets how long the load plan runs; the
# plan's own duration is 2m. SMOKE_EXAMPLES=all runs every example scenario.
set -euo pipefail
tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

npm install --global --prefix "$work/prefix" --no-audit --no-fund "$tarball" > /dev/null
bin="$work/prefix/bin/ocpp-mimic"
version=$(tar -xOzf "$tarball" package/package.json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)')

echo "== version"
test "$("$bin" --version)" = "$version"

echo "== samples and an example scenario"
cd "$work"
"$bin" samples samples > /dev/null
if [ "${SMOKE_EXAMPLES:-one}" = all ]; then
  "$bin" run samples/examples --personas samples/personas
else
  "$bin" run samples/examples/local-card-session.yaml --personas samples/personas
fi

echo "== csms and serve"
csms_port=19100
engine_port=17300
"$bin" csms --port "$csms_port" --status 0 > "$work/csms.log" 2>&1 &
pids+=($!)
"$bin" serve --port "$engine_port" --personas samples/personas > "$work/engine.log" 2>&1 &
pids+=($!)
api="http://127.0.0.1:$engine_port"
for _ in $(seq 1 100); do curl -sf "$api/api/health" > /dev/null && break; sleep 0.2; done
curl -sf "$api/api/health" | grep -q "\"version\":\"$version\""
curl -sf "http://127.0.0.1:$csms_port/api/health" | grep -q '"service":"ocpp-mimic-csms"'
curl -sf "$api/" | grep -q '<div id="app"'
curl -sf -X POST "$api/api/stations" -H 'content-type: application/json' \
  -d "{\"id\":\"SMOKE-1\",\"persona\":\"generic-2.1\",\"csmsUrl\":\"ws://127.0.0.1:$csms_port/ocpp\"}" > /dev/null
for _ in $(seq 1 50); do
  curl -sf "$api/api/stations/SMOKE-1" | grep -q '"registration":"Accepted"' && break
  sleep 0.2
done
curl -sf "$api/api/stations/SMOKE-1" | grep -q '"registration":"Accepted"'
curl -sf -X POST "$api/api/stations/SMOKE-1/connectors/1/plug" -H 'content-type: application/json' \
  -d '{"ev":"compact-40kwh"}' > /dev/null
curl -sf -X POST "$api/api/stations/SMOKE-1/connectors/1/id-tag" -H 'content-type: application/json' \
  -d '{"idTag":"TAG-001"}' | grep -q '"result":"authorized"'
for _ in $(seq 1 50); do
  curl -sf "$api/api/stations/SMOKE-1/sessions" | grep -q '"state":"running"' && break
  sleep 0.2
done
curl -sf "$api/api/stations/SMOKE-1/sessions" | grep -q '"state":"running"'

echo "== load"
"$bin" load samples/load/smoke-100.yaml --personas samples/personas \
  --csms "ws://127.0.0.1:$csms_port/ocpp" --duration "${SMOKE_LOAD_DURATION:-30s}" > "$work/load.log" 2>&1 || {
  cat "$work/load.log"
  exit 1
}
grep -E "^(PASSED|FAILED)" "$work/load.log"

echo "ok: ocpp-mimic $version from $(basename "$tarball")"
