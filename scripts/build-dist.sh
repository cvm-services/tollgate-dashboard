#!/usr/bin/env bash
# Assemble the publishable site into dist/.
#
# The repo contains things that must never be published: the test suites, the
# Playwright config, node_modules. An nsite is a public blob store, so the
# deploy input is built explicitly rather than "deploy the repo and hope".
#
# What ships: index.html, app.js, style.css, lib/*.js, vendor/nostr.mjs.
# Nothing else. `dist/` is the whole site.

set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist/lib dist/vendor

cp index.html dist/
cp app.js dist/
cp style.css dist/
cp lib/*.js dist/lib/
cp vendor/nostr.mjs dist/vendor/

# A tiny manifest of what was published, so a later audit can diff the site
# against the repo without guessing.
{
  echo "# files published by scripts/build-dist.sh"
  (cd dist && find . -type f | sed 's|^\./||' | sort)
} > dist/FILES.txt

echo "built dist/ ($(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1))"
