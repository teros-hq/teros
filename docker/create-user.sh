#!/bin/bash
set -e

cd "$(dirname "$0")/.."

DIM='\033[2m'
RESET='\033[0m'
YELLOW='\033[1;33m'

prompt() {
  local var_name=$1
  local label=$2
  local secret=$3

  echo -ne "  ${DIM}$label${RESET}: "

  if [ "$secret" = "true" ]; then
    read -rs value </dev/tty
    echo ""
  else
    read -r value </dev/tty
  fi

  printf -v "$var_name" '%s' "$value"
}

if [ "$#" -ge 2 ]; then
  # Non-interactive: pass args directly
  docker compose exec -T backend npx tsx src/scripts/create-user.ts "$@"
else
  # Interactive
  echo ""
  prompt EMAIL    "Email"
  prompt PASSWORD "Password (min 8 chars)" "true"

  while [ ${#PASSWORD} -lt 8 ]; do
    echo -e "  ${YELLOW}!${RESET}  Password must be at least 8 characters. Try again."
    prompt PASSWORD "Password (min 8 chars)" "true"
  done

  prompt NAME "Full name"

  echo ""
  echo -ne "  ${DIM}Role [user/admin/super] (default: user)${RESET}: "
  read -r ROLE </dev/tty
  ROLE="${ROLE:-user}"
  echo ""

  docker compose exec -T backend npx tsx src/scripts/create-user.ts "$EMAIL" "$PASSWORD" "$NAME" --role "$ROLE"
fi
