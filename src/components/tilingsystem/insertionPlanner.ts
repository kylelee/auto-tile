import type { Meta, Mtk } from '../../gi/ext';
import type Tile from '../layout/Tile';
import type ExtendedWindow from './extendedWindow';

/**
 * Pure planner for the insert-after-focused auto-tiling behavior.
 *
 * Everything shell-related is injected: layouts, work areas, window lists
 * and the tile-to-pixel rect conversion all arrive through ChainInputs /
 * PlanInsertionOptions. This module has ZERO runtime imports (types only)
 * and performs no side effects: it never touches windows or workspaces,
 * it only computes where things should go. The executor living in the
 * tiling manager is the single place allowed to apply a plan, and
 * plan.moves[i].target.tile is its only tile truth source.
 */

/** One slot of a workspace's global tiling chain. */
export interface ChainSlot {
    /** Slot position within its workspace chain (0..N-1, global order). */
    slotIndex: number;
    /** Monitor the slot's tile belongs to. */
    monitorIndex: number;
    /** Layout tile in normalized coordinates. */
    tile: Tile;
    /** Pixel rect of the tile within its monitor's work area. */
    tileRect: Mtk.Rectangle;
}

/** External data and geometry access, injected by the caller. */
export interface ChainInputs {
    /** Monitor indices ordered top-to-bottom, then left-to-right. */
    monitorsInRowOrder: number[];
    getWorkAreaForMonitor: (m: number) => Mtk.Rectangle;
    getTilesForMonitor: (m: number, wsIndex: number) => Tile[];
    /** Window list of a workspace in MRU order. */
    getWindows: (ws: Meta.Workspace) => Meta.Window[];
    /** Normalized tile to pixel rect within the given container. */
    rectFromTile: (tile: Tile, container: Mtk.Rectangle) => Mtk.Rectangle;
}

/** A window and the contiguous slot range it occupies on a chain. */
export interface WindowSlotAssignment {
    window: Meta.Window;
    startSlot: number;
    endSlot: number;
}

/**
 * The shared tile order (top-to-bottom, then left-to-right), mirroring the
 * tiling manager's vacancy-search sort.
 */
function compareTilesInRowOrder(a: Tile, b: Tile): number {
    return a.y - b.y || a.x - b.x;
}

/**
 * Builds the global slot chain of a workspace: each monitor's tiles sorted
 * top-to-bottom then left-to-right, flattened in monitor row order into
 * slots 0..N-1.
 */
export function buildWorkspaceChain(
    wsIndex: number,
    inputs: ChainInputs
): ChainSlot[] {
    const chain: ChainSlot[] = [];
    for (const monitorIndex of inputs.monitorsInRowOrder) {
        const workArea = inputs.getWorkAreaForMonitor(monitorIndex);
        // copy before sorting: getTilesForMonitor may return the live layout
        // array and a pure planner must not permute injected state
        const tiles = [...inputs.getTilesForMonitor(monitorIndex, wsIndex)];
        tiles.sort(compareTilesInRowOrder);
        for (const tile of tiles) {
            chain.push({
                slotIndex: chain.length,
                monitorIndex,
                tile,
                tileRect: inputs.rectFromTile(tile, workArea),
            });
        }
    }
    return chain;
}

/**
 * Occupancy truth, condition-by-condition identical to the tiling manager's
 * tiled-window-rects query: assigned tile set, not minimized, not
 * maximized. Sticky tiled windows are INCLUDED (the MRU window list
 * contains them, and that is exactly the occupancy truth).
 */
function isTiledOccupant(w: Meta.Window): boolean {
    return (
        !!w &&
        !!(w as ExtendedWindow).assignedTile &&
        !w.minimized &&
        !w.maximizedVertically &&
        !w.maximizedHorizontally
    );
}

/**
 * Maps the workspace's tiled windows onto the chain slots they occupy.
 * Only slots on the window's own monitor are overlap-tested: a frame rect
 * never crosses into another monitor's work area, so this scoping is an
 * intentional, safe difference from the raw occupancy-rect query (do not
 * "fix" it in either direction). Windows matching no slot are skipped
 * (drifted state).
 */
export function mapWindowsToSlots(
    chain: ChainSlot[],
    ws: Meta.Workspace,
    inputs: ChainInputs
): WindowSlotAssignment[] {
    const assignments: WindowSlotAssignment[] = [];
    const tiledWindows = inputs.getWindows(ws).filter(isTiledOccupant);
    for (const window of tiledWindows) {
        const monitorIndex = window.get_monitor();
        const frameRect = window.get_frame_rect();
        let startSlot = -1;
        let endSlot = -1;
        for (let s = 0; s < chain.length; s++) {
            const slot = chain[s];
            if (slot.monitorIndex !== monitorIndex) continue;
            if (!slot.tileRect.overlap(frameRect)) continue;
            if (startSlot === -1) startSlot = s;
            endSlot = s;
        }
        if (startSlot === -1) continue;
        assignments.push({ window, startSlot, endSlot });
    }
    return assignments;
}

/**
 * Whether the given slot's tile rect overlaps any occupancy rect of the
 * workspace (the same truth as mapWindowsToSlots; not monitor-scoped,
 * matching the raw occupancy-rect query it mirrors).
 */
export function isSlotOccupied(
    chain: ChainSlot[],
    slotIndex: number,
    ws: Meta.Workspace,
    inputs: ChainInputs
): boolean {
    const slot = chain[slotIndex];
    return inputs
        .getWindows(ws)
        .some(
            w => isTiledOccupant(w) && slot.tileRect.overlap(w.get_frame_rect())
        );
}

/**
 * Strict reading-order first-vacancy search for the untiled-new-window
 * path: the first free slot of the fromWs chain starting at slot 0, then -
 * only when allowed - strictly forward through the later workspaces
 * (never wrapping back to earlier ones), and finally slot 0 of the
 * workspace to be appended when both flags allow it. Occupancy truth and
 * chain semantics are exactly planInsertion's.
 */
export function findFirstVacancy(opts: {
    fromWs: number;
    nWorkspaces: number;
    allowCrossWorkspace: boolean;
    allowAppend: boolean;
    getChain: (wsIndex: number) => ChainSlot[];
    inputs: ChainInputs;
    getWorkspaceByIndex: (i: number) => Meta.Workspace | null;
}): { wsIndex: number; slot: ChainSlot; appendWorkspace: boolean } | null {
    const lastWsIndex = opts.allowCrossWorkspace
        ? opts.nWorkspaces - 1
        : opts.fromWs;
    for (let wsIndex = opts.fromWs; wsIndex <= lastWsIndex; wsIndex++) {
        const ws = opts.getWorkspaceByIndex(wsIndex);
        if (!ws) continue; // uninspectable workspace: never a vacancy
        const chain = opts.getChain(wsIndex);
        for (let slotIndex = 0; slotIndex < chain.length; slotIndex++) {
            if (!isSlotOccupied(chain, slotIndex, ws, opts.inputs)) {
                return {
                    wsIndex,
                    slot: chain[slotIndex],
                    appendWorkspace: false,
                };
            }
        }
    }
    if (opts.allowCrossWorkspace && opts.allowAppend) {
        const appendChain = opts.getChain(opts.nWorkspaces);
        // a tile-less appended workspace holds no vacancy either, mirroring
        // planInsertion's absorb-slot guard
        if (appendChain.length > 0) {
            return {
                wsIndex: opts.nWorkspaces,
                slot: appendChain[0],
                appendWorkspace: true,
            };
        }
    }
    return null;
}

/** Where a shifted window must land. */
export interface InsertionMoveTarget {
    wsIndex: number;
    slot: ChainSlot;
    /**
     * The ONLY tile truth the executor may use: the target slot's tile for
     * single-slot windows, the bounding-box tile of the covered consecutive
     * target-chain slots for span windows. The executor must never build or
     * translate tiles itself.
     */
    tile: Tile;
}

/** One existing window shifted one slot forward along the global order. */
export interface InsertionMove {
    window: Meta.Window;
    target: InsertionMoveTarget;
}

/** Complete insertion plan for the executor. */
export interface InsertionPlan {
    newWindowTarget: { wsIndex: number; slot: ChainSlot };
    /** Pre-sorted by target key descending (wsIndex, then slotIndex). */
    moves: InsertionMove[];
    /** True when the new window lands outside the anchor's workspace. */
    switchView: boolean;
    /**
     * Present (true) when the absorb slot sits on a workspace that does not
     * exist yet; the executor must create it before applying the plan.
     */
    appendWorkspace?: boolean;
}

/** Discriminated failure causes, so the executor can log each cause. */
export type InsertionFallback = {
    fallback: 'no-vacancy' | 'immovable-occupant' | 'anchor-unmapped';
};

/** Options for planInsertion; all shell access is injected here. */
export interface PlanInsertionOptions {
    allowCrossWorkspace: boolean;
    allowAppend: boolean;
    /** Chain builder; results are cached per workspace by the planner. */
    getChain: (wsIndex: number) => ChainSlot[];
    nWorkspaces: number;
    inputs: ChainInputs;
    /**
     * Resolves a workspace object by index, mirroring the workspace
     * manager's lookup. Injected like every other dependency: the planner
     * needs exactly this one handle to query the occupancy of workspaces
     * other than the anchor's.
     */
    getWorkspaceByIndex: (wsIndex: number) => Meta.Workspace | null;
}

// Meta.WindowType.NORMAL, the first member of the C enum, i.e. 0. Written
// as a literal (with this note) to keep this module runtime-import-free.
const WINDOW_TYPE_NORMAL = 0;

/**
 * Movability check for shift occupants, mirroring the tiling manager's
 * swap-target candidate filter.
 */
function isMovableOccupant(w: Meta.Window): boolean {
    return (
        w.windowType === WINDOW_TYPE_NORMAL &&
        w.get_transient_for() === null &&
        !w.is_attached_dialog() &&
        !w.is_on_all_workspaces() &&
        w.allows_move() &&
        w.allows_resize() &&
        !w.is_fullscreen() &&
        !w.minimized
    );
}

/**
 * Bounding-box tile of the covered consecutive target-chain slots, in
 * normalized coordinates (the exact region the span will occupy). Returned
 * as a plain object structurally typed as Tile - a data-only class with no
 * instanceof checks anywhere - so the planner stays runtime-import-free.
 * A synthetic span tile joins no resize group.
 */
function buildSpanTile(
    targetChain: ChainSlot[],
    from: number,
    to: number
): Tile {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let s = from; s <= to; s++) {
        const t = targetChain[s].tile;
        left = Math.min(left, t.x);
        top = Math.min(top, t.y);
        right = Math.max(right, t.x + t.width);
        bottom = Math.max(bottom, t.y + t.height);
    }
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        groups: [],
    };
}

/**
 * Target of one occupant's single-slot shift along the global order. A
 * shift past the chain tail lands on the next workspace's chain slot 0.
 * Span windows need their whole consecutive slot region to fit on the
 * target chain and to sit on a single monitor; anything else makes the
 * occupant immovable (never clamp and never split: the absorb math needs
 * exactly one slot of vacancy, and a clamped span would permanently alter
 * its geometry while leaving a stray vacancy behind).
 */
function computeShiftTarget(
    occupant: WindowSlotAssignment,
    fromWsIndex: number,
    fromChain: ChainSlot[],
    getChain: (wsIndex: number) => ChainSlot[]
): InsertionMoveTarget | 'immovable' {
    const spanSlots = occupant.endSlot - occupant.startSlot + 1;
    const shiftedStart = occupant.startSlot + 1;
    let targetWsIndex = fromWsIndex;
    let targetSlotIndex = shiftedStart;
    if (targetSlotIndex >= fromChain.length) {
        targetWsIndex = fromWsIndex + 1;
        targetSlotIndex = 0;
    }
    const targetChain = getChain(targetWsIndex);
    const targetEndSlotIndex = targetSlotIndex + spanSlots - 1;
    if (targetEndSlotIndex >= targetChain.length) {
        // chain-tail overflow
        return 'immovable';
    }
    const targetSlot = targetChain[targetSlotIndex];
    let sameMonitor = true;
    for (let s = targetSlotIndex + 1; s <= targetEndSlotIndex; s++) {
        if (targetChain[s].monitorIndex !== targetSlot.monitorIndex) {
            sameMonitor = false;
            break;
        }
    }
    if (!sameMonitor) {
        // a region across two monitors has no single work area that could
        // realize it as one tile
        return 'immovable';
    }
    return {
        wsIndex: targetWsIndex,
        slot: targetSlot,
        tile:
            spanSlots === 1
                ? targetSlot.tile
                : buildSpanTile(
                      targetChain,
                      targetSlotIndex,
                      targetEndSlotIndex
                  ),
    };
}

/**
 * Plans the insertion of a new window right after `anchor` in global slot
 * order, shifting every tiled occupant behind it one slot forward - across
 * monitors in row order and, when allowed, across workspaces with strictly
 * increasing indices (never wrapping) - until the first natural vacancy
 * absorbs the shift. Returns either a complete plan or a discriminated
 * fallback cause.
 */
export function planInsertion(
    anchor: Meta.Window,
    opts: PlanInsertionOptions
): InsertionPlan | InsertionFallback {
    const chainCache = new Map<number, ChainSlot[]>();
    const getChain = (wsIndex: number): ChainSlot[] => {
        const cached = chainCache.get(wsIndex);
        if (cached) return cached;
        const chain = opts.getChain(wsIndex);
        chainCache.set(wsIndex, chain);
        return chain;
    };

    // 1. map the anchor onto its own workspace chain
    const anchorWsObject = anchor.get_workspace();
    const anchorWs = anchorWsObject.index();
    const anchorChain = getChain(anchorWs);
    const anchorAssignment = mapWindowsToSlots(
        anchorChain,
        anchorWsObject,
        opts.inputs
    ).find(a => a.window === anchor);
    if (!anchorAssignment) {
        // drifted anchor: it occupies no slot of its chain
        return { fallback: 'anchor-unmapped' };
    }

    // 2. the insertion point sits right after the anchor's last slot
    const insertionIdx = anchorAssignment.endSlot + 1;

    // 3. zero-move fast path: the very next slot is free
    if (
        insertionIdx < anchorChain.length &&
        !isSlotOccupied(anchorChain, insertionIdx, anchorWsObject, opts.inputs)
    ) {
        return {
            newWindowTarget: {
                wsIndex: anchorWs,
                slot: anchorChain[insertionIdx],
            },
            moves: [],
            switchView: false,
        };
    }

    // 4. search the absorbing vacancy E: first inside the anchor chain
    // after the insertion point, then - with strictly increasing workspace
    // indices, never wrapping - from slot 0 of every later workspace
    let absorbWsIndex = -1;
    let absorbSlotIndex = -1;
    for (let probe = insertionIdx; probe < anchorChain.length; probe++) {
        if (!isSlotOccupied(anchorChain, probe, anchorWsObject, opts.inputs)) {
            absorbWsIndex = anchorWs;
            absorbSlotIndex = probe;
            break;
        }
    }
    if (absorbWsIndex === -1 && opts.allowCrossWorkspace) {
        for (
            let wsIndex = anchorWs + 1;
            wsIndex < opts.nWorkspaces;
            wsIndex++
        ) {
            const ws = opts.getWorkspaceByIndex(wsIndex);
            if (!ws) continue; // workspace cannot be inspected: never a vacancy
            const chain = getChain(wsIndex);
            for (let probe = 0; probe < chain.length; probe++) {
                if (!isSlotOccupied(chain, probe, ws, opts.inputs)) {
                    absorbWsIndex = wsIndex;
                    absorbSlotIndex = probe;
                    break;
                }
            }
            if (absorbWsIndex !== -1) break;
        }
    }

    // 5. defensive append branch: with dynamic workspaces an empty trailing
    // workspace nearly always absorbs the shift during the search above, so
    // reaching here is rare; when every workspace is full and appending is
    // allowed, the vacancy is slot 0 of the workspace to be created. The
    // chain of that not-yet-existing workspace is built through the same
    // injected getters (per-monitor layout lookups simply fall back, which
    // is exactly what the created workspace will get).
    let appendWorkspace = false;
    if (absorbWsIndex === -1 && opts.allowCrossWorkspace && opts.allowAppend) {
        absorbWsIndex = opts.nWorkspaces;
        absorbSlotIndex = 0;
        appendWorkspace = true;
    }

    // 6. no vacancy anywhere we are allowed to look
    if (absorbWsIndex === -1) {
        return { fallback: 'no-vacancy' };
    }
    const absorbSlot = getChain(absorbWsIndex)[absorbSlotIndex];
    if (!absorbSlot) {
        return { fallback: 'no-vacancy' };
    }

    // 7. every occupant of the half-open interval [insertion point, E)
    // shifts one slot forward; any immovable occupant voids the whole plan
    const moves: InsertionMove[] = [];
    const lastShiftedWsIndex = appendWorkspace
        ? opts.nWorkspaces - 1
        : absorbWsIndex;
    for (let wsIndex = anchorWs; wsIndex <= lastShiftedWsIndex; wsIndex++) {
        const chain = getChain(wsIndex);
        const wsObject =
            wsIndex === anchorWs
                ? anchorWsObject
                : opts.getWorkspaceByIndex(wsIndex);
        if (!wsObject) {
            // a workspace inside the shift range cannot be inspected;
            // planning on unknown occupancy would stack the new window
            return { fallback: 'no-vacancy' };
        }
        const intervalStart = wsIndex === anchorWs ? insertionIdx : 0;
        const intervalEnd =
            wsIndex === absorbWsIndex && !appendWorkspace
                ? absorbSlotIndex - 1
                : chain.length - 1;
        // the cross-insertion-boundary guard is chain-local: the anchor
        // chain checks against insertionIdx, later chains against the
        // virtual insertion slot 0 (their occupants always start at >= 0,
        // so reusing the anchor's index here would cause false fallbacks)
        const localInsertionIdx = wsIndex === anchorWs ? insertionIdx : 0;
        for (const occupant of mapWindowsToSlots(
            chain,
            wsObject,
            opts.inputs
        )) {
            if (
                occupant.endSlot < intervalStart ||
                occupant.startSlot > intervalEnd
            ) {
                continue; // outside the shift interval
            }
            if (
                occupant.startSlot < localInsertionIdx ||
                !isMovableOccupant(occupant.window)
            ) {
                // a span across the insertion boundary still covers the
                // insertion slot after shifting (the slot is never vacated
                // and the new window would stack on it), and an occupant
                // failing any movability condition cannot be moved at all:
                // never silently skip either one
                return { fallback: 'immovable-occupant' };
            }
            const target = computeShiftTarget(
                occupant,
                wsIndex,
                chain,
                getChain
            );
            if (target === 'immovable') {
                return { fallback: 'immovable-occupant' };
            }
            moves.push({ window: occupant.window, target });
        }
    }

    // canonical order only: all moves run inside one synchronous idle
    // callback with precomputed targets, so the end state does not depend
    // on this order - still, sort by target key descending per contract
    moves.sort(
        (a, b) =>
            b.target.wsIndex - a.target.wsIndex ||
            b.target.slot.slotIndex - a.target.slot.slotIndex
    );

    // 8. the new window takes the INSERTION slot - the slot right after
    // the anchor, vacated by the first shifted occupant - which is NOT
    // the absorb slot: E is where the LAST shifted occupant lands. When
    // the anchor sits on the chain tail (insertionIdx == chain length),
    // the insertion slot is slot 0 of the first following chain that has
    // tiles; a tile-less chain holds neither occupants nor vacancies, so
    // the cascade simply passes through it and conservation still holds.
    let newWindowTarget: InsertionPlan['newWindowTarget'];
    if (insertionIdx < anchorChain.length) {
        newWindowTarget = {
            wsIndex: anchorWs,
            slot: anchorChain[insertionIdx],
        };
    } else {
        // anchor at chain tail: default to slot 0 of the workspace to be
        // appended, which is also E and therefore yields zero moves. When
        // append is NOT on, this default is always overwritten by the loop
        // below: a real cross-workspace E can only be found inside a chain
        // with tiles, and the loop scans that same range, so it always
        // finds at least E's own chain.
        newWindowTarget = { wsIndex: opts.nWorkspaces, slot: absorbSlot };
        for (
            let wsIndex = anchorWs + 1;
            wsIndex < opts.nWorkspaces;
            wsIndex++
        ) {
            const chain = getChain(wsIndex);
            if (chain.length > 0) {
                newWindowTarget = { wsIndex, slot: chain[0] };
                break;
            }
        }
    }
    const plan: InsertionPlan = {
        newWindowTarget,
        moves,
        // the view follows the NEW window's target, never the absorb slot:
        // the new window already holds focus, so leaving it on an invisible
        // workspace would be broken UX
        switchView: newWindowTarget.wsIndex !== anchorWs,
    };
    if (appendWorkspace) {
        plan.appendWorkspace = true;
    }
    return plan;
}
