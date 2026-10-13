#!/bin/sh
set -eu

KEY_DIR=/var/lib/asterisk/keys
CERT_DIR="${CERT_DIR:-/certs}"

log() { echo "[entrypoint] $*"; }

mkdir -p "$KEY_DIR" /var/lib/asterisk/generated /var/run/asterisk /var/log/asterisk /var/spool/asterisk

# TLS certificate for WSS (8089) and SIP-TLS (5061): use the one shared with
# the web server when available, otherwise create a self-signed one.
if [ -f "$CERT_DIR/server.crt" ] && [ -f "$CERT_DIR/server.key" ]; then
  cp "$CERT_DIR/server.crt" "$KEY_DIR/asterisk.crt"
  cp "$CERT_DIR/server.key" "$KEY_DIR/asterisk.key"
  log "using TLS certificate from $CERT_DIR"
elif [ ! -s "$KEY_DIR/asterisk.crt" ] || [ ! -s "$KEY_DIR/asterisk.key" ]; then
  san="DNS:localhost,IP:127.0.0.1${EXTERNAL_IP:+,IP:$EXTERNAL_IP}"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -subj "/CN=${EXTERNAL_IP:-localhost}" -addext "subjectAltName=$san" \
    -keyout "$KEY_DIR/asterisk.key" -out "$KEY_DIR/asterisk.crt" 2>/dev/null
  log "generated self-signed TLS certificate ($san)"
fi
chmod 0600 "$KEY_DIR/asterisk.key"

asterisk-gen-config

# Volumes may be created root-owned on first start.
chown asterisk:asterisk /var/lib/asterisk
chown -R asterisk:asterisk "$KEY_DIR" /var/lib/asterisk/generated /var/run/asterisk /var/log/asterisk /var/spool/asterisk

exec "$@"
