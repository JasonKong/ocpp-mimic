#!/usr/bin/env bash
# Installs a packed ocpp-mimic tarball into a temporary prefix and checks what
# a new user does first: the version, the samples, an example scenario, the
# built-in CSMS and the engine with its Web UI, a station charging through
# the API, the demo (valet and a site's load management), and a short load
# plan.
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

echo "== demo"
demo_port=17400
demo_csms_port=19200
"$bin" demo --port "$demo_port" --csms-port "$demo_csms_port" > "$work/demo.log" 2>&1 &
pids+=($!)
demo="http://127.0.0.1:$demo_port"
for _ in $(seq 1 100); do grep -q "Demo page:  $demo/#/demo" "$work/demo.log" && break; sleep 0.2; done
grep -q "Demo page:  $demo/#/demo" "$work/demo.log"
curl -sf "$demo/" | grep -q '<div id="app"'
curl -sf -X POST "$demo/api/stations" -H 'content-type: application/json' \
  -d "{\"id\":\"DEMO-SMOKE\",\"persona\":\"generic-dual-1.6\",\"csmsUrl\":\"ws://127.0.0.1:$demo_csms_port/ocpp\"}" > /dev/null
for _ in $(seq 1 50); do
  curl -sf "$demo/api/stations/DEMO-SMOKE" | grep -q '"csms":"builtin"' && break
  sleep 0.2
done
# Valet: the CSMS starts a session on each plug-in, and shares the site's 8 kW between them.
curl -sf -X POST "$demo/api/stations/DEMO-SMOKE/auto-start" -H 'content-type: application/json' \
  -d '{"idToken":{"idToken":"VALET"}}' | grep -q '"VALET"'
curl -sf -X PUT "$demo/api/sites/smoke" -H 'content-type: application/json' \
  -d '{"capacityW":8000,"stations":["DEMO-SMOKE"]}' | grep -q '"capacityW":8000'
for c in 1 2; do
  curl -sf -X POST "$demo/api/stations/DEMO-SMOKE/connectors/$c/plug" -H 'content-type: application/json' \
    -d '{"ev":"compact-40kwh"}' > /dev/null
done
for _ in $(seq 1 50); do
  curl -sf "$demo/api/sites/smoke" | grep -q '"allocatedW":8000' && break
  sleep 0.2
done
curl -sf "$demo/api/sites/smoke" | grep -q '"allocatedW":8000'
# Payments: a card is held when the CSMS authorizes it and captured at the end; a declined
# card does not start.
curl -sf -X POST "$demo/api/stations" -H 'content-type: application/json' \
  -d "{\"id\":\"DEMO-PAY\",\"persona\":\"generic-dual-1.6\",\"csmsUrl\":\"ws://127.0.0.1:$demo_csms_port/ocpp\"}" > /dev/null
for _ in $(seq 1 50); do
  curl -sf "$demo/api/stations/DEMO-PAY" | grep -q '"csms":"builtin"' && break
  sleep 0.2
done
curl -sf -X PUT "$demo/api/sites/smoke-pay/payments" -H 'content-type: application/json' \
  -d '{"stations":["DEMO-PAY"]}' | grep -q '"holdAmount":50'
curl -sf -X PUT "$demo/api/accounts/CARD-NO" -H 'content-type: application/json' \
  -d '{"site":"smoke-pay","outcome":"decline"}' | grep -q '"decline"'
for c in 1 2; do
  curl -sf -X POST "$demo/api/stations/DEMO-PAY/connectors/$c/plug" -H 'content-type: application/json' \
    -d '{"ev":"compact-40kwh"}' > /dev/null
done
curl -sf -X POST "$demo/api/stations/DEMO-PAY/connectors/1/id-tag" -H 'content-type: application/json' \
  -d '{"idTag":"CARD-OK"}' | grep -q '"result":"authorized"'
curl -sf -X POST "$demo/api/stations/DEMO-PAY/connectors/2/id-tag" -H 'content-type: application/json' \
  -d '{"idTag":"CARD-NO"}' | grep -q '"result":"rejected"'
for _ in $(seq 1 50); do
  curl -sf "$demo/api/sites/smoke-pay/payments" | grep -q '"state":"held"' && break
  sleep 0.2
done
curl -sf "$demo/api/sites/smoke-pay/payments" | grep -q '"kind":"decline"'
curl -sf -X POST "$demo/api/stations/DEMO-PAY/connectors/1/id-tag" -H 'content-type: application/json' \
  -d '{"idTag":"CARD-OK"}' > /dev/null
for _ in $(seq 1 50); do
  curl -sf "$demo/api/sites/smoke-pay/payments" | grep -q '"state":"captured"' && break
  sleep 0.2
done
curl -sf "$demo/api/sites/smoke-pay/payments" | grep -q '"state":"captured"'

echo "== load"
"$bin" load samples/load/smoke-100.yaml --personas samples/personas \
  --csms "ws://127.0.0.1:$csms_port/ocpp" --duration "${SMOKE_LOAD_DURATION:-30s}" > "$work/load.log" 2>&1 || {
  cat "$work/load.log"
  exit 1
}
grep -E "^(PASSED|FAILED)" "$work/load.log"

echo "ok: ocpp-mimic $version from $(basename "$tarball")"
