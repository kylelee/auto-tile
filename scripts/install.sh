#!/usr/bin/env bash
#
# Install the AutoTile GNOME Shell extension into the local user extensions
# directory. Run ./scripts/build.sh first.
#
# Usage: ./scripts/install.sh
#        EXTENSIONS_DIR=/path/to/dir ./scripts/install.sh   (custom destination)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v gnome-shell >/dev/null 2>&1; then
    echo "❌ 'gnome-shell' not found: cannot detect the GNOME Shell version" >&2
    exit 1
fi

# dist_legacy covers GNOME Shell 42-44, dist covers 45+
SHELL_MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)
if [ "$SHELL_MAJOR" -le 44 ]; then
    DIST_DIR="$ROOT_DIR/dist_legacy"
else
    DIST_DIR="$ROOT_DIR/dist"
fi

if [ ! -f "$DIST_DIR/metadata.json" ]; then
    echo "❌ $DIST_DIR/metadata.json not found. Run ./scripts/build.sh first." >&2
    exit 1
fi

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' "$DIST_DIR/metadata.json")
DEST_DIR="${EXTENSIONS_DIR:-$HOME/.local/share/gnome-shell/extensions}/$UUID"

mkdir -p "$DEST_DIR"
cp -r "$DIST_DIR"/* "$DEST_DIR"/

echo "✅ Installed AutoTile (GNOME Shell $SHELL_MAJOR → ${DIST_DIR#$ROOT_DIR/}) into:"
echo "   $DEST_DIR"
echo

if gnome-extensions enable "$UUID"; then
    echo "✅ Enabled $UUID"
else
    echo "⚠️  Could not enable $UUID yet (the running GNOME Shell may not know about it)."
    echo "   Reload GNOME Shell (log out/in, or Alt-F2 'r' on X11 only), then enable it:"
    echo "   gnome-extensions enable $UUID"
fi
