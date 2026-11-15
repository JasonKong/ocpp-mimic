#!/usr/bin/env bash
# Adds idTokens to the CitrineOS test stack's database. CitrineOS answers
# Authorize from its Authorizations and only sends tokens it knows in a
# local list; it has no REST endpoint to create them (its operator UI uses
# GraphQL), so the scenarios' tokens go in with SQL. Test data only.
#
# Usage: tools/citrineos/register.sh TOKEN[:STATUS[:GROUP]] ...
#   TOKEN is an ISO14443 idToken; STATUS defaults to Accepted; GROUP is the
#   idToken (type Central) of its group, created when missing.
set -euo pipefail
cd "$(dirname "$0")"

sql=''
upsert() { # token type status group
  local group_id='NULL'
  if [ -n "$4" ]; then
    group_id="(SELECT id FROM \"Authorizations\" WHERE \"tenantId\" = 1 AND \"idToken\" = '$4' AND \"idTokenType\" = 'Central')"
  fi
  sql+="INSERT INTO \"Authorizations\" (\"idToken\", \"idTokenType\", status, \"tenantId\", \"groupAuthorizationId\", \"createdAt\", \"updatedAt\")
VALUES ('$1', '$2', '$3', 1, $group_id, now(), now())
ON CONFLICT (\"tenantId\", \"idToken\", \"idTokenType\") DO UPDATE
SET status = EXCLUDED.status, \"groupAuthorizationId\" = EXCLUDED.\"groupAuthorizationId\", \"updatedAt\" = now();
"
}
for spec in "$@"; do
  IFS=: read -r token status group <<<"$spec"
  status=${status:-Accepted}
  group=${group:-}
  for value in "$token" "$status" "$group"; do
    if [[ ! "$value" =~ ^[A-Za-z0-9_-]*$ ]]; then
      echo "not a plain token: $value" >&2
      exit 2
    fi
  done
  [ -n "$group" ] && upsert "$group" Central Accepted ''
  upsert "$token" ISO14443 "$status" "$group"
done
[ -z "$sql" ] && { echo "usage: $0 TOKEN[:STATUS[:GROUP]] ..." >&2; exit 2; }
docker compose -f docker-compose.yml exec -T ocpp-db psql -q -v ON_ERROR_STOP=1 -U citrine -d citrine -c "$sql"
