#!/usr/bin/env bash
# Rebuilds dist/akella-search.zip (the file Foundry downloads). Run after changing the code,
# bump "version" in module.json, then commit both.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/akella-search.zip
zip -qr dist/akella-search.zip module.json README.md scripts templates styles lang vendor
echo "dist/akella-search.zip built"
