#!/usr/bin/env bash
#
# End-to-end test run for the AutoTile GNOME Shell extension.
# Lints the sources, builds both extension targets (dist/ and dist_legacy/),
# then bundles and runs every self-asserting test under tests/.
#
# Usage: ./scripts/test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# the npm build drives glib-compile-schemas and glib-compile-resources
for tool in node npm glib-compile-schemas glib-compile-resources; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "❌ '$tool' not found in PATH" >&2
        exit 1
    }
done

if [ ! -d node_modules ]; then
    echo "📦 node_modules not found, installing dependencies..."
    npm install
fi

echo "🧹 Linting src/..."
npm run lint

echo
echo "🏗️  Building AutoTile (dist/ + dist_legacy/)..."
npm run build

echo
echo "🧪 Running tests..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

shopt -s nullglob
TEST_FILES=(tests/*.test.ts)
shopt -u nullglob

TOTAL=${#TEST_FILES[@]}
if [ "$TOTAL" -eq 0 ]; then
    echo "❌ no test files found under tests/" >&2
    exit 1
fi

FAILED=0
for test_file in "${TEST_FILES[@]}"; do
    name="$(basename "$test_file" .test.ts)"
    bundle="$TMP_DIR/$name.cjs"
    if ! npx esbuild "$test_file" \
        --bundle --platform=node --format=cjs \
        --outfile="$bundle" --log-level=error; then
        echo "❌ $name: bundling failed"
        FAILED=$((FAILED + 1))
        continue
    fi
    if node "$bundle"; then
        echo "✅ $name"
    else
        echo "❌ $name: assertions failed"
        FAILED=$((FAILED + 1))
    fi
    echo
done

echo "==============================="
if [ "$FAILED" -eq 0 ]; then
    echo "✅ E2E PASS: lint + build + $TOTAL/$TOTAL test files"
else
    echo "❌ E2E FAIL: $FAILED/$TOTAL test files failed"
    exit 1
fi
