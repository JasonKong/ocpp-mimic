#!/usr/bin/env bash
# Registers charge points and OCPP tags in the SteVe started by
# docker-compose.yml, so they are accepted. Existing entries are left alone.
# --charging-profile also adds charging profile 1001 (TxDefaultProfile,
# Relative, 3680 W), which the SteVe scenarios send with SetChargingProfile.
# Usage: tools/steve/register.sh --charge-points ID... --tags TAG... [--charging-profile]
set -euo pipefail
cd "$(dirname "$0")"

charge_points=()
tags=()
profile=0
target=""
for arg in "$@"; do
  case "$arg" in
    --charge-points) target=charge_points ;;
    --tags) target=tags ;;
    --charging-profile) profile=1 ;;
    *)
      if [[ ! "$arg" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "unsupported id: $arg" >&2
        exit 2
      fi
      case "$target" in
        charge_points) charge_points+=("$arg") ;;
        tags) tags+=("$arg") ;;
        *) echo "usage: $0 --charge-points ID... --tags TAG... [--charging-profile]" >&2; exit 2 ;;
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
if [[ $profile == 1 ]]; then
  sql+="INSERT IGNORE INTO charging_profile (charging_profile_pk, stack_level, charging_profile_purpose, charging_profile_kind, charging_rate_unit, description) VALUES (1001, 0, 'TxDefaultProfile', 'Relative', 'W', 'ocpp-mimic scenarios: 3680 W');"
  sql+="INSERT IGNORE INTO charging_schedule_period (charging_profile_pk, start_period_in_seconds, power_limit) VALUES (1001, 0, 3680.0);"
fi
[[ -z "$sql" ]] && exit 0

docker compose exec -T db sh -c 'mariadb -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<<"$sql"
echo "registered ${#charge_points[@]} charge point(s), ${#tags[@]} tag(s)$([[ $profile == 1 ]] && echo ' and charging profile 1001')"
