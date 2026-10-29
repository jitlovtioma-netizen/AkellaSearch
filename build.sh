#!/usr/bin/env bash
# Rebuilds dist/akella-search.zip (the file Foundry downloads). Run after changing the code,
# bump "version" in module.json, then commit both.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/akella-search.zip
zip -qr dist/akella-search.zip module.json README.md oauth.html scripts templates styles lang vendor
echo "dist/akella-search.zip built"

# The PC export tool uses the same folder grouping as the module.
cp scripts/grouping.js tools/akella-export/grouping.js
rm -f dist/akella-export.zip
(cd tools && zip -qr ../dist/akella-export.zip akella-export -x 'akella-export/node_modules/*' 'akella-export/akella-export.config.json' 'akella-export/akella-export.state.json*' 'akella-export/akella-export.log')
echo "dist/akella-export.zip built"
