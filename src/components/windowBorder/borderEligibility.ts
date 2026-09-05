/**
 * Pure, GI-free eligibility rule for the focus border.
 *
 * The executor (windowBorderManager) reads the GI properties of the
 * focused Meta.Window and passes them here; this module decides, so the
 * rule stays testable under plain node with zero imports.
 *
 * windowTypeName is compared BY NAME (e.g. 'NORMAL'), never by numeric
 * enum value: the numeric ordering of Meta.WindowType members is NOT
 * stable across GNOME 42-50 (@girs/meta-17 has DIALOG=3 /
 * MODAL_DIALOG=4 while historical mutter ordered them differently), but
 * the member names are.
 */

export interface WindowBorderEligibility {
    wmClass: string | null;
    windowTypeName: string;
    skipTaskbar: boolean;
    showingOnItsWorkspace: boolean;
    frameWidth: number;
    frameHeight: number;
}

const BORDER_ELIGIBLE_WINDOW_TYPES = new Set([
    'NORMAL',
    'DIALOG',
    'MODAL_DIALOG',
]);

export function isWindowEligibleForBorder(w: WindowBorderEligibility): boolean {
    return (
        w.wmClass !== null &&
        w.wmClass !== 'gjs' &&
        BORDER_ELIGIBLE_WINDOW_TYPES.has(w.windowTypeName) &&
        !w.skipTaskbar &&
        w.showingOnItsWorkspace &&
        // >= 2px: sub-2px frames are ghost windows (e.g. wl-clipboard's
        // 1x1 clipboard helper that lives ~12ms) — never draw or track a
        // focus border on them; real windows are never 1px.
        w.frameWidth >= 2 &&
        w.frameHeight >= 2
    );
}
