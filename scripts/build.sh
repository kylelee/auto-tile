#!/usr/bin/env bash
#
# Build the AutoTile GNOME Shell extension.
# Produces dist/ (GNOME Shell 45+) and dist_legacy/ (GNOME Shell 42-44).
#
# Usage: ./scripts/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# the npm build drives glib-compile-schemas and glib-compile-resources
for tool in npm glib-compile-schemas glib-compile-resources; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "❌ '$tool' not found in PATH" >&2
        exit 1
    }
done

if [ ! -d node_modules ]; then
    echo "📦 node_modules not found, installing dependencies..."
    npm install
fi

echo "🏗️  Building AutoTile..."
npm run build

echo
echo "✅ Build complete:"
echo "   📁 dist/         → GNOME Shell 45+"
echo "   📁 dist_legacy/  → GNOME Shell 42-44"
