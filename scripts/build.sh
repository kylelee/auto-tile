#!/usr/bin/env bash
#
# Build the AutoTile GNOME Shell extension.
# Produces dist/ (GNOME Shell 45+) and dist_legacy/ (GNOME Shell 42-44).
# With --package, also bundles both builds as release zips in the repo root.
#
# Usage: ./scripts/build.sh             build only
#        ./scripts/build.sh --package   build + package as *.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PACKAGE=0
for arg in "$@"; do
    case "$arg" in
        --package|-p) PACKAGE=1 ;;
        *)
            echo "❌ Unknown option: $arg" >&2
            echo "Usage: ./scripts/build.sh [--package]" >&2
            exit 1
            ;;
    esac
done

# the npm build drives glib-compile-schemas and glib-compile-resources
REQUIRED_TOOLS=(npm glib-compile-schemas glib-compile-resources)
if [ "$PACKAGE" -eq 1 ]; then
    REQUIRED_TOOLS+=(zip)
fi
for tool in "${REQUIRED_TOOLS[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "❌ '$tool' not found in PATH" >&2
        exit 1
    }
done

if [ ! -d node_modules ]; then
    echo "📦 node_modules not found, installing dependencies..."
    npm install
fi

if [ "$PACKAGE" -eq 1 ]; then
    echo "🏗️  Building AutoTile and packaging as zip..."
    npm run build:package
else
    echo "🏗️  Building AutoTile..."
    npm run build
fi

echo
echo "✅ Build complete:"
echo "   📁 dist/         → GNOME Shell 45+"
echo "   📁 dist_legacy/  → GNOME Shell 42-44"
if [ "$PACKAGE" -eq 1 ]; then
    echo "   📦 autotile@kylelee.github.io.zip              → GNOME Shell 45+"
    echo "   📦 GNOME.42-44.autotile@kylelee.github.io.zip  → GNOME Shell 42-44"
fi
