#!/usr/bin/env bash
# Publish the dashboard as an nsite.
#
# An nsite has no backend: this uploads dist/ to Blossom servers and publishes
# a manifest event. Anyone with the npub can then read the site from any nsite
# gateway. That npub IS the dashboard's identity — it is NOT a maintainer's
# npub and NOT the router's key.
#
# ONE NSEC PER SITE (see the nsyte-deployment skill): do not reuse the identity
# of another nsite, or the sites become correlatable and a compromise of one
# takes the other with it.
#
# Usage:
#   NSITE_NSEC_FILE=~/.hermes/state/tollgate-dashboard-nsec.key scripts/deploy-nsite.sh
#   NSITE_NSEC=nsec1... scripts/deploy-nsite.sh
#
# The key is read from a file or the environment; it is never written into this
# repo and never passed on the command line in the examples below (argv leaks
# to other processes). nsyte itself takes --sec, so it does end up in argv for
# that one process — keep the deploy on a machine you trust.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${NSITE_NSEC:-}" ]]; then
  key_file="${NSITE_NSEC_FILE:-$HOME/.hermes/state/tollgate-dashboard-nsec.key}"
  if [[ -f "$key_file" ]]; then
    NSITE_NSEC="$(cat "$key_file")"
  else
    echo "no nsec: set NSITE_NSEC or NSITE_NSEC_FILE (looked for $key_file)" >&2
    exit 1
  fi
fi

export PATH="$HOME/.deno/bin:$PATH"
command -v nsyte >/dev/null || { echo "nsyte not on PATH — see the nsyte-deployment skill" >&2; exit 1; }

bash scripts/build-dist.sh

# Relays: the dashboard's own defaults are the ContextVM ones, but the MANIFEST
# wants widely-reachable relays. nos.lol requires PoW for some kinds; the four
# below are the ones that have worked.
RELAYS="wss://relay.primal.net,wss://nostr.mom,wss://offchain.pub,wss://relay.damus.io"
SERVERS="https://blossom.primal.net,https://cdn.hzrd149.com,https://cdn.sovbit.host,https://cdn.nostrcheck.me,https://nostr.download"

nsyte init --sec "$NSITE_NSEC" --relays "$RELAYS" --servers "$SERVERS" --site root --non-interactive
nsyte deploy dist --sec "$NSITE_NSEC" --force --skip-secrets-scan --non-interactive

echo
echo "deployed. gateway URLs (substitute the npub of the key you just used):"
echo "  https://<npub>.nsite.lol/"
echo "  https://<npub>.nsite.run/"
echo "verify with: curl -sI https://<npub>.nsite.lol/ | head -1"
