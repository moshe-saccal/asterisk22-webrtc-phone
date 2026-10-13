#!/usr/bin/env bash
#
# Creates a local certificate authority (certs/ca.crt) and a server
# certificate signed by it (certs/server.crt, certs/server.key) that is valid
# for localhost, this machine's name and the given IP addresses / hostnames.
#
# Import certs/ca.crt into your OS/browser trust store once and every device
# will trust the web phone without warnings.
#
#   scripts/gen-certs.sh [ip-or-hostname ...]
#
set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR=certs
mkdir -p "$CERT_DIR"

san="DNS:localhost,DNS:asterisk,DNS:web,IP:127.0.0.1"
host_name="$(hostname 2>/dev/null || true)"
[ -n "$host_name" ] && san="$san,DNS:$host_name"
for name in "$@"; do
  [ -z "$name" ] && continue
  if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then san="$san,IP:$name"; else san="$san,DNS:$name"; fi
done

if [ ! -f "$CERT_DIR/ca.key" ] || [ ! -f "$CERT_DIR/ca.crt" ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/O=Asterisk WebRTC Lab/CN=Asterisk WebRTC Lab Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" 2>/dev/null
  echo "Created local CA: $CERT_DIR/ca.crt"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/ext.cnf" <<CNF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
CNF

openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/O=Asterisk WebRTC Lab/CN=${1:-localhost}" \
  -keyout "$CERT_DIR/server.key" -out "$tmp/server.csr" 2>/dev/null
openssl x509 -req -in "$tmp/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -days 825 -sha256 -extfile "$tmp/ext.cnf" -out "$CERT_DIR/server.crt" 2>/dev/null

chmod 600 "$CERT_DIR/server.key" "$CERT_DIR/ca.key"
chmod 644 "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt"
echo "Created server certificate: $CERT_DIR/server.crt ($san)"
