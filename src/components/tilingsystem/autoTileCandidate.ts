/**
 * Pure, GI-free auto-tile candidacy gate (ghost-window immunity).
 *
 * The executor (tilingManager) reads the GI properties of a Meta.Window
 * and passes them here; this module decides, so the rule stays testable
 * under plain node with zero imports.
 *
 * Diagnostic basis (measured 2026-09-05, GNOME 50 Wayland): the
 * wl-clipboard ghost window maps 0x0 at birth and 1x1 at first-frame,
 * with a ~12.6ms lifetime. Meta.Window.get_wm_class() returns null at
 * window-created time, so the blacklist can only ever fire at the
 * first-frame recheck — never at the entry guard.
 */

export interface AutoTileCandidateInfo {
    wmClass: string | null;
    frameWidth: number;
    frameHeight: number;
}

export const AUTO_TILE_WM_CLASS_BLACKLIST: ReadonlySet<string> = new Set([
    'io.github.bugaevc.wl-clipboard',
]);

export function shouldAutoTileWindow(info: AutoTileCandidateInfo): boolean {
    return (
        !(info.frameWidth <= 1 || info.frameHeight <= 1) &&
        !(
            info.wmClass !== null &&
            AUTO_TILE_WM_CLASS_BLACKLIST.has(info.wmClass)
        )
    );
}
