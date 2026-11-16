#!/usr/bin/env bash
# Runs every example scenario and the 100-station smoke plan with an
# ocpp-mimic image, from the samples the image itself ships.
# Usage: tools/accept-image.sh <image>
# SMOKE_LOAD_DURATION (default 2m, the plan's own) sets how long the plan runs.
set -euo pipefail
image=$1
duration=${SMOKE_LOAD_DURATION:-2m}
name=ocpp-mimic-accept-$$
work=$(mktemp -d)
# The image runs as the node user, which must be able to write here.
chmod 777 "$work"
cleanup() {
  docker rm -f "$name-csms" > /dev/null 2>&1 || true
  rm -rf "$work" 2> /dev/null || true
}
trap cleanup EXIT
run() { docker run --rm -v "$work:/work" -w /work "$@"; }

echo "== samples and every example scenario"
run "$image" samples scenarios > /dev/null
run "$image" run scenarios/examples --personas scenarios/personas

echo "== the smoke plan against the CSMS, in one network namespace"
docker run -d --name "$name-csms" "$image" csms --host 127.0.0.1 --port 9102 --status 0 > /dev/null
run --network "container:$name-csms" "$image" \
  load scenarios/load/smoke-100.yaml --personas scenarios/personas --duration "$duration" \
  | tee "$work/load.log" | grep -E "^(PASSED|FAILED)|^  (PASS|FAIL) "
grep -q '^PASSED' "$work/load.log"
echo "ok: $image"
