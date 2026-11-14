#!/usr/bin/env bash
# Registers charge points and OCPP tags in the SteVe started by
# docker-compose.yml, so they are accepted. Existing entries are left alone.
# Usage: tools/steve/register.sh --charge-points ID... --tags TAG...
set -euo pipefail
cd "$(dirname "$0")"

charge_points=()
tags=()
target=""
for arg in "$@"; do
  case "$arg" in
    --charge-points) target=charge_points ;;
    --tags) target=tags ;;
    *)
      if [[ ! "$arg" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "unsupported id: $arg" >&2
        exit 2
      fi
      case "$target" in
        charge_points) charge_points+=("$arg") ;;
        tags) tags+=("$arg") ;;
        *) echo "usage: $0 --charge-points ID... --tags TAG..." >&2; exit 2 ;;
      esac
      ;;
  esac
done

sql=""
for id in "${charge_points[@]}"; do
  sql+="INSERT IGNORE INTO charge_box (charge_box_id) VALUES ('$id');"
done
for tag in "${tags[@]}"; do
  sql+="INSERT IGNORE INTO ocpp_tag (id_tag) VALUES ('$tag');"
done
[[ -z "$sql" ]] && exit 0

docker compose exec -T db sh -c 'mariadb -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<<"$sql"
echo "registered ${#charge_points[@]} charge point(s) and ${#tags[@]} tag(s)"
