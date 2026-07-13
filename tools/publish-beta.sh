#!/bin/bash
# Publish a branch to the beta channel (momentum-beta repo -> GitHub Pages).
# Creates a throwaway worktree, patches the app identity to "Momentum beta"
# so the two home-screen icons are distinguishable, gives the service worker
# a per-publish cache name, and force-pushes to the beta remote's main.
# The feature branch itself is never modified.
#
# Usage: tools/publish-beta.sh <branch>
set -euo pipefail

BRANCH="${1:?usage: tools/publish-beta.sh <branch>}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short "$BRANCH")"
TMP="$(mktemp -d)"

cleanup() { git -C "$REPO_ROOT" worktree remove --force "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

git -C "$REPO_ROOT" worktree add --detach "$TMP" "$BRANCH" >/dev/null

sed -i '' 's|<title>Momentum</title>|<title>Momentum β</title>|' "$TMP/index.html"
sed -i '' 's|name="apple-mobile-web-app-title" content="Momentum"|name="apple-mobile-web-app-title" content="Momentum β"|' "$TMP/index.html"
sed -i '' 's|"name": "Momentum"|"name": "Momentum β"|; s|"short_name": "Momentum"|"short_name": "Momentum β"|' "$TMP/manifest.webmanifest"
sed -i '' "s|const CACHE = '[^']*'|const CACHE = 'beta-${BRANCH//\//-}-${SHA}'|" "$TMP/sw.js"
sed -i '' "s|</body>|<div style=\"position:fixed;bottom:2px;right:8px;font-size:9px;color:#5b6672;z-index:99;pointer-events:none\">beta ${BRANCH} @ ${SHA}</div></body>|" "$TMP/index.html"

git -C "$TMP" add -A
git -C "$TMP" commit -q -m "beta: ${BRANCH} @ ${SHA}"
git -C "$TMP" push -f beta HEAD:refs/heads/main

echo "published ${BRANCH} (${SHA}) -> https://grantdever.github.io/momentum-beta/"
