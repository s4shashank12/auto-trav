#!/usr/bin/env bash
# Claude Code on the web only: its egress proxy re-signs TLS, and Chromium reads trust from the
# NSS database rather than the system bundle. Adds the proxy CA there so Playwright can load
# Travian. Not needed on a normal machine.
set -euo pipefail

BUNDLE=/root/.ccr/ca-bundle.crt
NSSDB="sql:${HOME}/.pki/nssdb"
[ -f "$BUNDLE" ] || { echo "No proxy CA bundle at $BUNDLE; nothing to do."; exit 0; }

command -v certutil >/dev/null || { apt-get update -qq && apt-get install -y -qq libnss3-tools; }
mkdir -p "${HOME}/.pki/nssdb"
[ -f "${HOME}/.pki/nssdb/cert9.db" ] || certutil -d "$NSSDB" -N --empty-password

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
csplit -s -z -f "$tmp/ca-" "$BUNDLE" '/-----BEGIN CERTIFICATE-----/' '{*}'
i=0
for cert in "$tmp"/ca-*; do
  if openssl x509 -in "$cert" -noout -subject 2>/dev/null | grep -q 'O = Anthropic'; then
    i=$((i + 1))
    certutil -d "$NSSDB" -A -t "C,," -n "egress-proxy-ca-$i" -i "$cert"
  fi
done
echo "Trusted $i proxy CA certificate(s) in $NSSDB"
