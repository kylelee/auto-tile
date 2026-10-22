#!/usr/bin/env bash
#
# Publish the packaged extension zips as a Release on GitHub or Gitea.
# Meant to run in CI (GitHub Actions / Gitea Actions): both runners provide
# GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_REF and GITHUB_SHA; the workflow
# passes GITHUB_TOKEN explicitly. No jq needed — node does the JSON parsing.
#
# Set RELEASE_DRY_RUN=1 to print the publish decisions without any network
# access (for local verification).
#
# Usage: ./scripts/ci-release.sh   (after ./scripts/build.sh --package)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

die() {
    echo "❌ $1" >&2
    exit 1
}

DRY_RUN="${RELEASE_DRY_RUN:-0}"

: "${GITHUB_API_URL:?GITHUB_API_URL is required (GitHub: https://api.github.com, Gitea: <instance>/api/v1)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/name)}"
if [ "$DRY_RUN" != "1" ]; then
    : "${GITHUB_TOKEN:?GITHUB_TOKEN is required (CI passes secrets.GITHUB_TOKEN)}"
fi

API="$GITHUB_API_URL"
REPO="$GITHUB_REPOSITORY"

# the two platforms only differ where noted below; everything else is shared
IS_GITHUB=0
if [[ "$API" == *api.github.com* ]]; then
    IS_GITHUB=1
fi

# GNOME 45+ build vs legacy 42-44 build (see scripts/build.sh)
ZIPS=("autotile@kylelee.github.io.zip" "GNOME.42-44.autotile@kylelee.github.io.zip")

# --- version, tag, release body ----------------------------------------------

# node is guaranteed by the build; jq is not available on every Gitea runner
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("resources/metadata.json","utf8"))["version-name"]')"

TAG="v$VERSION"
if [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
    TAG="${GITHUB_REF#refs/tags/}"
fi

COMMIT="${GITHUB_SHA:-}"
[ -n "$COMMIT" ] || COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

BODY="AutoTile ${TAG} — automatic tiling window management for GNOME Shell.

Commit: ${COMMIT}

Supports GNOME Shell 42 through 50.
- autotile@kylelee.github.io.zip: GNOME Shell 45 and newer.
- GNOME.42-44.autotile@kylelee.github.io.zip: GNOME Shell 42-44."

echo "🏷️  Version: $VERSION"
echo "🏷️  Tag / release name: $TAG"
echo "📦 Artifacts: ${ZIPS[*]}"

# fail fast on missing artifacts — in dry-run too, so it doubles as a
# release-readiness probe
for zip_name in "${ZIPS[@]}"; do
    [ -f "$zip_name" ] || die "missing build artifact: $zip_name (run ./scripts/build.sh --package first)"
done

if [ "$DRY_RUN" = "1" ]; then
    echo "🏃 RELEASE_DRY_RUN=1 — decisions only, no network requests:"
    echo "   → GET $API/repos/$REPO/releases/tags/$TAG"
    echo "   → if absent: create release '$TAG' (target commit $COMMIT)"
    echo "   → if present: replace same-name assets, then upload:"
    for zip_name in "${ZIPS[@]}"; do
        echo "     • $zip_name"
    done
    exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# curl wrapper: response body goes to $1, HTTP status code to stdout
api_call() {
    local out_file="$1"
    shift
    curl -sS -o "$out_file" -w '%{http_code}' \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/json" \
        "$@"
}

json_field() {
    # json_field <file> <js-expression-on-parsed-doc>; "" when absent/invalid
    node -e '
const doc = (() => { try { return JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { return null; } })();
if (doc === null) { process.stdout.write(""); } else { process.stdout.write(String(eval(process.argv[2]) ?? "")); }
' "$1" "$2"
}

# --- look up an existing release for the tag ----------------------------------

STATUS="$(api_call "$TMP_DIR/release.json" "$API/repos/$REPO/releases/tags/$TAG")"

RELEASE_ID=""
UPLOAD_URL=""
MODE=""

if [ "$STATUS" = "200" ]; then
    MODE="update"
    RELEASE_ID="$(json_field "$TMP_DIR/release.json" 'doc.id')"
    UPLOAD_URL="$(json_field "$TMP_DIR/release.json" 'doc.upload_url')"
    [ -n "$RELEASE_ID" ] || die "existing release response has no id (HTTP $STATUS): $(head -c 200 "$TMP_DIR/release.json")"
    echo "🔍 Release '$TAG' already exists — updating it."
elif [ "$STATUS" = "404" ]; then
    MODE="create"
    echo "✨ No release for '$TAG' yet — creating it."
else
    die "looking up release by tag failed (HTTP $STATUS): $(head -c 200 "$TMP_DIR/release.json")"
fi

# --- create the release when absent -------------------------------------------

if [ "$MODE" = "create" ]; then
    # build the payload with node so the body survives JSON quoting intact
    PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({tag_name: process.argv[1], target_commitish: process.argv[2], name: process.argv[1], body: process.argv[3]}))' "$TAG" "$COMMIT" "$BODY")"
    STATUS="$(api_call "$TMP_DIR/release.json" \
        -X POST -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$API/repos/$REPO/releases")"
    case "$STATUS" in
        200 | 201) ;;
        409 | 422)
            # lost a create race against a concurrent run (branch push and tag
            # push use different concurrency groups): adopt the winner's
            # release and continue with the update path below
            echo "⚠️  release '$TAG' was created concurrently (HTTP $STATUS) — switching to update"
            STATUS="$(api_call "$TMP_DIR/release.json" "$API/repos/$REPO/releases/tags/$TAG")"
            [ "$STATUS" = "200" ] || die "re-fetching release '$TAG' after create race failed (HTTP $STATUS): $(head -c 200 "$TMP_DIR/release.json")"
            MODE="update"
            ;;
        *) die "creating release '$TAG' failed (HTTP $STATUS): $(head -c 200 "$TMP_DIR/release.json")" ;;
    esac
    # release.json holds the create response, or the re-fetched release after
    # a create race; both carry id and upload_url
    RELEASE_ID="$(json_field "$TMP_DIR/release.json" 'doc.id')"
    UPLOAD_URL="$(json_field "$TMP_DIR/release.json" 'doc.upload_url')"
    [ -n "$RELEASE_ID" ] || die "release response has no id (HTTP $STATUS): $(head -c 200 "$TMP_DIR/release.json")"
fi

# --- replace same-name assets on an existing release ---------------------------

if [ "$MODE" = "update" ]; then
    # release JSON carries "assets" on both GitHub and Gitea; "attachments" is kept as a legacy fallback
    ASSET_IDS="$(node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const names = new Set(process.argv.slice(2));
for (const asset of doc.assets || doc.attachments || []) {
    if (names.has(asset.name)) console.log(asset.id);
}
' "$TMP_DIR/release.json" "${ZIPS[@]}")"
    for asset_id in $ASSET_IDS; do
        if [ "$IS_GITHUB" -eq 1 ]; then
            ASSET_URL="$API/repos/$REPO/releases/assets/$asset_id"
        else
            ASSET_URL="$API/repos/$REPO/releases/$RELEASE_ID/assets/$asset_id"
        fi
        STATUS="$(api_call "$TMP_DIR/delete.json" -X DELETE "$ASSET_URL")"
        case "$STATUS" in
            200 | 204) echo "🗑️  removed old asset $asset_id (HTTP $STATUS)" ;;
            *) die "deleting old asset $asset_id failed (HTTP $STATUS): $(head -c 200 "$TMP_DIR/delete.json")" ;;
        esac
    done
fi

# --- upload both zips ----------------------------------------------------------

# upload_url may carry a "{?name,label}" template and/or a query; strip both,
# then add the target file name
UPLOAD_URL="${UPLOAD_URL%\{*}"
UPLOAD_URL="${UPLOAD_URL%%\?*}"
[ -n "$UPLOAD_URL" ] || die "release response has no upload_url"

for zip_name in "${ZIPS[@]}"; do
    if [ "$IS_GITHUB" -eq 1 ]; then
        # GitHub takes the raw bytes
        STATUS="$(api_call "$TMP_DIR/upload.json" \
            -X POST -H "Content-Type: application/zip" \
            --data-binary "@$zip_name" \
            "$UPLOAD_URL?name=$zip_name")"
    else
        # Gitea takes a multipart upload
        STATUS="$(api_call "$TMP_DIR/upload.json" \
            -X POST \
            -F "attachment=@$zip_name;type=application/zip" \
            "$UPLOAD_URL?name=$zip_name")"
    fi
    case "$STATUS" in
        200 | 201) echo "⬆️  uploaded $zip_name (HTTP $STATUS)" ;;
        *) die "uploading $zip_name failed (HTTP $STATUS): $(head -c 200 "$TMP_DIR/upload.json")" ;;
    esac
done

echo "✅ Release '$TAG' published: $API/repos/$REPO/releases/tags/$TAG"
