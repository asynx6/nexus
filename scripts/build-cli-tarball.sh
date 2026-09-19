#!/bin/bash
# Run from nexus repo root
set -e
cd "$(dirname "$0")/.."

# Build tarball
npx pkg extract apps/cli/package.json --output dist/ 2>/dev/null || true
tar -czf dist/@asynx6-nexus-cli-0.1.3.tgz -C apps/cli .

echo "Tarball ready at dist/@asynx6-nexus-cli-0.1.3.tgz"
ls -la dist/