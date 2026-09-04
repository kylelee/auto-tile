#!/usr/bin/env bash
#
# Pre-upload validation for https://extensions.gnome.org/upload/
#
# extensions.gnome.org runs the experimental "Shexli" static analyzer
# (https://pypi.org/project/shexli/) on every uploaded zip and shows the
# findings to the reviewers. This script runs the same analyzer locally so
# problems surface before the upload.
#
# Usage: ./scripts/check_extension.sh                 # build + check both release zips
#        ./scripts/check_extension.sh --no-build      # check existing zips only
#        ./scripts/check_extension.sh --dist          # check dist/ + dist_legacy/ (fast, no zip)
#        ./scripts/check_extension.sh --strict        # warnings are blocking too
#        ./scripts/check_extension.sh --install-tools # only provision the shexli venv
#
# Environment:
#   SHEXLI           use this shexli executable instead of auto-detection
#   SHEXLI_VERSION   version to install when auto-provisioning (default: 0.2.1)
#
# Exit codes:
#   0  no blocking findings (warnings pass unless --strict)
#   1  analyzer found errors (or warnings, with --strict)
#   2  setup problem (missing tools, missing build, unparsable output)
#   3  analyzer crashed (known shexli 0.2.1 segfault — see the note it prints)
#
# Known quirks this script works around (shexli 0.2.1):
#   - relative package paths crash it with a ValueError traceback → always
#     pass absolute paths;
#   - its exit code is 0 even when errors are found → the summary line
#     "shexli: <status> (N findings, N errors, N warnings)" is parsed instead;
#   - it can segfault (exit 139) on large bundles: deterministic heap
#     corruption in its tree-sitter usage, NOT an extension defect. Reported
#     upstream and also seen at baxyz/gnome-extensions. If it happens, treat
#     the result as "could not analyze" and rely on the EGO review page.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

UUID="autotile@kylelee.github.io"
ZIP_MAIN="$ROOT_DIR/$UUID.zip"
ZIP_LEGACY="$ROOT_DIR/GNOME.42-44.$UUID.zip"
SHEXLI_VERSION="${SHEXLI_VERSION:-0.2.1}"
VENV_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/autotile/shexli-venv"

MODE="zip"
DO_BUILD=1
STRICT=0

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dist) MODE="dist"; shift ;;
        --no-build) DO_BUILD=0; shift ;;
        --strict) STRICT=1; shift ;;
        --install-tools) MODE="install"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "❌ unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Resolve a shexli executable: $SHEXLI → PATH → cached venv → provision it.
# ---------------------------------------------------------------------------
SHEXLI_CMD=""

try_shexli() {  # $1: candidate command; prints it if it can analyze
    local candidate="$1"
    command -v "$candidate" >/dev/null 2>&1 || return 1
    "$candidate" --help >/dev/null 2>&1 || return 1
    SHEXLI_CMD="$candidate"
}

install_tools() {
    command -v python3 >/dev/null 2>&1 || {
        echo "❌ 'python3' not found in PATH" >&2
        exit 2
    }
    echo "🔧 Provisioning shexli==$SHEXLI_VERSION into isolated venv: $VENV_DIR"
    rm -rf "$VENV_DIR"
    python3 -m venv "$VENV_DIR" || {
        echo "❌ could not create the venv (on Debian/Ubuntu: sudo apt install python3-venv)" >&2
        exit 2
    }
    "$VENV_DIR/bin/pip" install --quiet "shexli==$SHEXLI_VERSION" || {
        echo "❌ pip install failed (network?). Try: $VENV_DIR/bin/pip install shexli==$SHEXLI_VERSION" >&2
        exit 2
    }
    echo "✅ Installed: $("$VENV_DIR/bin/shexli" --help >/dev/null 2>&1 && echo ok)"
}

resolve_shexli() {
    if [ -n "${SHEXLI:-}" ]; then
        try_shexli "$SHEXLI" || { echo "❌ SHEXLI=$SHEXLI is not a working executable" >&2; exit 2; }
    elif ! try_shexli shexli && ! try_shexli "$VENV_DIR/bin/shexli"; then
        install_tools
        try_shexli "$VENV_DIR/bin/shexli" || { echo "❌ provisioned venv has no working shexli" >&2; exit 2; }
    fi
    echo "🔎 Using analyzer: $SHEXLI_CMD"
}

if [ "$MODE" = "install" ]; then
    install_tools
    exit 0
fi

resolve_shexli

# ---------------------------------------------------------------------------
# Gather the packages to check.
# ---------------------------------------------------------------------------
PACKAGES=()

if [ "$MODE" = "zip" ]; then
    if [ "$DO_BUILD" -eq 1 ]; then
        for tool in npm zip glib-compile-schemas glib-compile-resources; do
            command -v "$tool" >/dev/null 2>&1 || {
                echo "❌ '$tool' not found in PATH" >&2
                exit 2
            }
        done
        [ -d node_modules ] || { echo "📦 node_modules missing, installing..."; npm install; }
        echo "🏗️  Building release packages (npm run build:package)..."
        npm run build:package
    fi
    for pkg in "$ZIP_MAIN" "$ZIP_LEGACY"; do
        [ -f "$pkg" ] || {
            echo "❌ $pkg not found. Run ./scripts/check_extension.sh (without --no-build)." >&2
            exit 2
        }
        PACKAGES+=("$pkg")
    done
else
    for pkg in "$ROOT_DIR/dist" "$ROOT_DIR/dist_legacy"; do
        [ -f "$pkg/metadata.json" ] || {
            echo "❌ $pkg/metadata.json not found. Run ./scripts/build.sh first." >&2
            exit 2
        }
        PACKAGES+=("$pkg")
    done
fi

# ---------------------------------------------------------------------------
# Run shexli on one package and record the outcome.
# Globals set per package: STATUS, ERROR_COUNT, WARNING_COUNT
# ---------------------------------------------------------------------------
analyze_package() {
    local pkg="$1" out rc
    STATUS="tool_failure"; ERROR_COUNT=0; WARNING_COUNT=0

    # absolute path is mandatory: shexli 0.2.1 crashes on relative paths
    pkg="$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")"

    set +e
    out="$("$SHEXLI_CMD" --format text "$pkg" 2>&1)"
    rc=$?
    set -e

    echo "$out"
    echo

    if [ "$rc" -ge 128 ]; then
        local sig=$((rc - 128))
        echo "💥 shexli died from signal $sig while analyzing $(basename "$pkg")" >&2
        if [ "$sig" -eq 11 ]; then
            cat >&2 <<'EOF'
   This is the known shexli 0.2.1 segfault (heap corruption in its tree-sitter
   usage; each part of the bundle analyzes cleanly on its own). It is NOT an
   AutoTile defect. Track: extensions-web MR !245 / pypi shexli.
EOF
        fi
        STATUS="crashed"
        return
    fi
    if [ "$rc" -ne 0 ]; then
        echo "❌ shexli exited with $rc on $(basename "$pkg")" >&2
        return
    fi

    # exit code is meaningless for findings — parse the summary line instead
    local summary
    summary="$(grep -Eo 'shexli: [a-z_]+ \([0-9]+ findings, [0-9]+ errors, [0-9]+ warnings\)' <<<"$out" | tail -n1)"
    if [ -z "$summary" ]; then
        echo "⚠️  could not find a shexli summary line — output format changed?" >&2
        return
    fi
    ERROR_COUNT="$(sed -E 's/.* ([0-9]+) errors.*/\1/' <<<"$summary")"
    WARNING_COUNT="$(sed -E 's/.* ([0-9]+) warnings\)/\1/' <<<"$summary")"
    STATUS="analyzed"
}

# ---------------------------------------------------------------------------
# Analyze all packages and summarize.
# ---------------------------------------------------------------------------
RESULTS=()
FAILED=0
CRASHED=0

for pkg in "${PACKAGES[@]}"; do
    name="${pkg#"$ROOT_DIR"/}"
    echo "──────────────────────────────────────────────────────────"
    echo "🔍 $name"
    echo "──────────────────────────────────────────────────────────"
    analyze_package "$pkg"

    case "$STATUS" in
        analyzed)
            if [ "$ERROR_COUNT" -gt 0 ] || { [ "$STRICT" -eq 1 ] && [ "$WARNING_COUNT" -gt 0 ]; }; then
                RESULTS+=("❌ $name — $ERROR_COUNT errors, $WARNING_COUNT warnings")
                FAILED=1
            elif [ "$WARNING_COUNT" -gt 0 ]; then
                RESULTS+=("⚠️  $name — clean of errors, $WARNING_COUNT warnings (reviewers see these)")
            else
                RESULTS+=("✅ $name — clean")
            fi
            ;;
        crashed)
            RESULTS+=("💥 $name — analyzer crashed (known shexli bug, verdict unknown)")
            CRASHED=1
            ;;
        *)
            RESULTS+=("❌ $name — analyzer failed (see output above)")
            FAILED=1
            ;;
    esac
    echo
done

echo "══════════════════════════════════════════════════════════"
echo "Shexli pre-upload check summary (mode: $MODE)"
for r in "${RESULTS[@]}"; do echo "  $r"; done

if [ "$CRASHED" -eq 1 ]; then
    echo
    echo "⚠️  shexli crashed on at least one package — upload-side analysis on"
    echo "   extensions.gnome.org may still succeed (their instance differs),"
    echo "   but you have no local verdict for it."
    exit 3
fi
if [ "$FAILED" -eq 1 ]; then
    echo
    echo "❌ Blocking findings — fix them before uploading to extensions.gnome.org"
    exit 1
fi
echo
echo "✅ No blocking shexli findings — ready for https://extensions.gnome.org/upload/"
