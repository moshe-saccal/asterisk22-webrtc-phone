#!/usr/bin/env bash
#
# One-time setup: creates .env (with this machine's IP), users.json (with
# random passwords) and the TLS certificates. Safe to run again: existing
# files are kept.
#
set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

detect_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then   # macOS
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  fi
  echo "${ip:-127.0.0.1}"
}

random_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true
}

# --- .env --------------------------------------------------------------------
if [ ! -f .env ]; then
  external_ip="${EXTERNAL_IP:-$(detect_ip)}"
  sed "s/^EXTERNAL_IP=.*/EXTERNAL_IP=${external_ip}/" .env.example > .env
  echo "Created .env (EXTERNAL_IP=${external_ip})"
fi
external_ip="$(grep -E '^EXTERNAL_IP=' .env | cut -d= -f2-)"
https_port="$(grep -E '^HTTPS_PORT=' .env | cut -d= -f2-)"

# --- users.json --------------------------------------------------------------
if [ ! -f users.json ]; then
  while IFS= read -r line; do
    while [[ "$line" == *__RANDOM__* ]]; do line="${line/__RANDOM__/$(random_password)}"; done
    printf '%s\n' "$line"
  done < users.example.json > users.json
  chmod 600 users.json
  echo "Created users.json with random passwords"
fi

# --- certificates ------------------------------------------------------------
if [ ! -f certs/server.crt ] || [ ! -f certs/server.key ]; then
  scripts/gen-certs.sh "$external_ip"
fi

echo
bold "Web phone:  https://${external_ip}:${https_port:-8443}   (or https://localhost:${https_port:-8443})"
bold "Accounts (users.json):"
sed -n 's/.*"extension": *"\([^"]*\)", *"name": *"\([^"]*\)", *"type": *"\([^"]*\)", *"password": *"\([^"]*\)".*/  \1  \4  (\3)  \2/p' users.json
