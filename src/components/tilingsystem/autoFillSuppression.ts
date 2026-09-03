/**
 * Re-entrancy guard for the auto-fill-freed-tiles cascade.
 *
 * Filling freed tiles moves windows across tiles and workspaces; those
 * mutations fire the very workspace/window signals that would start
 * new auto-fill passes. The executor wraps each pass in
 * withAutoFillSuppressed() so re-entered handlers can check
 * isAutoFillSuppressed() and bail out.
 *
 * The guard is nestable (a plain depth counter released in a finally
 * block) and deliberately import-free so it stays loadable in any
 * process, plain node tests included.
 */

let _depth = 0;

export function withAutoFillSuppressed<T>(fn: () => T): T {
    _depth++;
    try {
        return fn();
    } finally {
        _depth--;
    }
}

export function isAutoFillSuppressed(): boolean {
    return _depth > 0;
}
