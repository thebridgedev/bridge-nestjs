#!/usr/bin/env bash
# test-install.sh — Verify that @nebulr-group/bridge-nestjs installs cleanly
# against NestJS 10 and NestJS 11.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/bridge-nestjs"

echo "==> Building library..."
cd "$PACKAGE_DIR"
npm run build

echo "==> Packing library..."
npm pack --pack-destination "$ROOT_DIR"
TARBALL=$(ls "$ROOT_DIR"/nebulr-group-bridge-nestjs-*.tgz | sort -V | tail -1)
echo "    Packed: $TARBALL"

for NEST_VERSION in 10 11; do
  echo ""
  echo "==> Testing install with NestJS $NEST_VERSION..."

  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT

  cd "$TMPDIR"
  npm init -y > /dev/null

  echo "    Installing NestJS $NEST_VERSION peer deps..."
  npm install \
    "@nestjs/common@^${NEST_VERSION}.0.0" \
    "@nestjs/core@^${NEST_VERSION}.0.0" \
    "reflect-metadata@^0.2.0" \
    "rxjs@^7.0.0" \
    --save --silent

  echo "    Installing bridge-nestjs from $TARBALL..."
  npm install "$TARBALL" --save --silent

  echo "    Verifying package is importable..."
  node -e "
    require('reflect-metadata');
    const pkg = require('@nebulr-group/bridge-nestjs');
    if (!pkg.BridgeModule) throw new Error('BridgeModule not exported');
    if (!pkg.BridgeAuthGuard) throw new Error('BridgeAuthGuard not exported');
    if (!pkg.BridgeHttpService) throw new Error('BridgeHttpService not exported');
    console.log('    All exports OK for NestJS ${NEST_VERSION}');
  "

  echo "    PASS: NestJS $NEST_VERSION"
  rm -rf "$TMPDIR"
  trap - EXIT
done

echo ""
echo "==> All install tests passed!"
