/**
 * Executor of the "auto-fill freed tiles" cascade.
 *
 * TilingManager signal handlers funnel every freed-tile trigger into
 * scheduleFill(); this class defers the actual pass to a GLib idle (never
 * mutating windows inside a first-frame signal emission), builds the
 * occupancy/movable snapshots of each workspace across EVERY managed
 * monitor, lets the pure freeTileFillPlanner compute the cascade, and
 * applies the resulting moves through the tiling callbacks of the
 * DESTINATION monitor's manager - without switching the workspace view
 * and without stealing focus. A free tile on any monitor can therefore
 * be filled from a window tiled on any other monitor, both within the
 * trigger workspace and from the workspaces to its right. Windows
 * without an assignedTile but otherwise eligible enter the snapshot
 * as last-rank pull candidates, participating in neither compaction
 * nor tile blocking.
 *
 * Geometry space: the planner needs ONE consistent rect space, and
 * per-monitor proportion rects of different monitors would overlap each
 * other. This executor feeds GLOBAL PIXEL rects: window frame rects
 * as-is, and layout tiles scaled through TileUtils.apply_props with
 * their own monitor's work area.
 */

import { GLib, Meta, Mtk } from '../../gi/ext';
import Settings from '../../settings/settings';
import GlobalState from '../../utils/globalState';
import { logger } from '../../utils/logger';
import { getWindows } from '../../utils/ui';
import Tile from '../layout/Tile';
import TileUtils from '../layout/TileUtils';
import ExtendedWindow from './extendedWindow';
import {
    compareTilesInReadingOrder,
    isSeatedOnSingleTile,
    planFillCascade,
    rectMostlyInsideTile,
    type CascadeMove,
    type RectLike,
    type WorkspaceSnapshot,
} from './freeTileFillPlanner';
import {
    isAutoFillSuppressed,
    withAutoFillSuppressed,
} from './autoFillSuppression';

/**
 * Per-monitor callbacks resolving to one managed monitor's TilingManager:
 * tiles are read from that monitor's layout and planned moves are
 * applied through that monitor's manager, so each window lands on its
 * destination monitor with that monitor's work area and gaps.
 */
export interface FreeTileFillerMonitorContext {
    monitorIndex: number;
    getWorkArea: () => Mtk.Rectangle;
    ensureTilingLayout: (ws: Meta.Workspace) => void;
    tileWindow: (tile: Tile, window: Meta.Window) => void;
    isInteracting: () => boolean;
}

export interface FreeTileFillerDependencies {
    /**
     * Live per-pass contexts of every managed monitor: monitors and
     * their managers can come and go between two passes.
     */
    getMonitorContexts: () => FreeTileFillerMonitorContext[];
}

interface PendingTrigger {
    wsIndex: number;
    exclude?: Meta.Window;
}

/** one reading-order seat of a workspace snapshot, across all monitors */
interface SnapshotTile {
    /** global-pixel rect: the planner's tile index space */
    rect: RectLike;
    monitorIndex: number;
    /** proportion-space layout tile of that monitor, for placement */
    layoutTile: Tile;
}

/** per-workspace data kept around for the plan application pass */
interface SnapshotWindows {
    windows: Meta.Window[];
    sortedTiles: SnapshotTile[];
}

interface ResolvedMove {
    move: CascadeMove;
    fromWs: Meta.Workspace;
    toWs: Meta.Workspace;
    window: Meta.Window;
}

// module-level on purpose: a filler pass must never be started while
// another one is still applying, not even from a second FreeTileFiller
let _fillInProgress = false;

/** one cascade move that a fill pass actually applied to a window */
export interface AppliedFillMove {
    windowId: number;
    window: Meta.Window;
    toWsIndex: number;
    destRect: RectLike;
}

// module-level on purpose: every managed monitor owns a FreeTileFiller
// instance and they all share this table, so records survive across
// fillers; FocusOnClose consumes them to focus the successor after the
// cascade has settled
const _appliedFillMoves: AppliedFillMove[] = [];

export function takeAppliedFillMoves(): AppliedFillMove[] {
    return _appliedFillMoves.splice(0);
}

export function clearAppliedFillMoves(): void {
    _appliedFillMoves.length = 0;
}

export default class FreeTileFiller {
    private _deps: FreeTileFillerDependencies;
    private _log = logger('FreeTileFiller');
    private _pendingDuringGrab: PendingTrigger | null = null;
    private _pendingIdleIds: Set<number> = new Set();
    private _snapshotCache: Map<number, SnapshotWindows> = new Map();

    constructor(deps: FreeTileFillerDependencies) {
        this._deps = deps;
    }

    /**
     * Signal-time entry point: cheap checks only, the actual pass runs
     * from a GLib idle. While a grab is in progress on ANY managed
     * monitor the trigger is NOT dropped: it is stashed (newer triggers
     * overwrite older ones) and re-scheduled by flushPending() when the
     * grab ends - the cascade moves windows on every monitor and must
     * never fight an ongoing drag, wherever it started.
     */
    public scheduleFill(wsIndex: number, exclude?: Meta.Window): void {
        if (!Settings.ENABLE_AUTO_FILL_FREED_TILES) {
            this._log('auto-fill of freed tiles disabled: ignoring trigger');
            return;
        }
        if (isAutoFillSuppressed()) {
            this._log('suppressed (own pass applying): ignoring trigger');
            return;
        }
        if (_fillInProgress) {
            this._log('a fill pass is already running: ignoring trigger');
            return;
        }
        if (
            this._deps
                .getMonitorContexts()
                .some(context => context.isInteracting())
        ) {
            this._log(`grab in progress: stashing trigger for ws ${wsIndex}`);
            this._pendingDuringGrab = { wsIndex, exclude };
            return;
        }

        // priority contract: FocusOnCloseManager defers its successor
        // focus search to PRIORITY_LOW so that this pass applies the
        // whole cascade (synchronously, inside the callback) before the
        // that successor search reads the post-merge geometry — keep
        // this idle strictly below PRIORITY_LOW
        this._log(`deferring fill pass from ws ${wsIndex} to idle`);
        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pendingIdleIds.delete(sourceId);
            this._run(wsIndex, exclude);
            return GLib.SOURCE_REMOVE;
        });
        this._pendingIdleIds.add(sourceId);
    }

    /** re-schedule the trigger stashed during a grab (no-op when none) */
    public flushPending(): void {
        if (!this._pendingDuringGrab) return;
        const { wsIndex, exclude } = this._pendingDuringGrab;
        this._pendingDuringGrab = null;
        this._log(`flushing trigger stashed during grab (ws ${wsIndex})`);
        this.scheduleFill(wsIndex, exclude);
    }

    public destroy(): void {
        // an idle firing after teardown would touch destroyed TilingLayouts
        for (const sourceId of this._pendingIdleIds)
            GLib.source_remove(sourceId);
        this._pendingIdleIds.clear();
        this._pendingDuringGrab = null;
        this._snapshotCache.clear();
    }

    private _run(startWsIndex: number, exclude?: Meta.Window): void {
        _fillInProgress = true;
        try {
            // the setting may have been flipped off since the idle was queued
            if (!Settings.ENABLE_AUTO_FILL_FREED_TILES) {
                this._log('auto-fill of freed tiles disabled: skipping pass');
                return;
            }

            const contexts = this._deps.getMonitorContexts();
            if (contexts.length === 0) {
                this._log('no managed monitor: skipping pass');
                return;
            }
            const contextsByMonitor = new Map<
                number,
                FreeTileFillerMonitorContext
            >(
                contexts.map(
                    context => [context.monitorIndex, context] as const
                )
            );

            this._snapshotCache.clear();
            // the planner walks cascade-relative ws indexes (0 = trigger
            // workspace); wrap the snapshot with the absolute offset and add
            // it back to every returned fromWs/toWs
            const plannedMoves = planFillCascade(k =>
                this._buildSnapshot(startWsIndex + k, contexts, exclude)
            ).map(move => ({
                ...move,
                fromWs: move.fromWs + startWsIndex,
                toWs: move.toWs + startWsIndex,
            }));

            if (plannedMoves.length === 0) {
                this._log(
                    `planned 0 moves from ws ${startWsIndex}: ` +
                        'every tile seated or no movable window to the right'
                );
                return;
            }
            this._log(
                `planned ${plannedMoves.length} move(s) from ws ${startWsIndex}`
            );

            // gated clear: only a pass that actually planned moves may
            // wipe the table - a redundant 0-move pass (e.g. the second
            // idle when two windows are closed in quick succession) must
            // keep the fresh records of the previous pass
            clearAppliedFillMoves();

            // resolve every ws index to a Meta.Workspace OBJECT before
            // mutating anything: dynamic workspaces reindex when one is
            // removed mid-cascade, objects stay valid, indexes do not
            const entries: ResolvedMove[] = [];
            for (const move of plannedMoves) {
                const snapshot = this._snapshotCache.get(move.fromWs);
                const window = snapshot?.windows[move.windowIndex];
                const fromWs = global.workspaceManager.get_workspace_by_index(
                    move.fromWs
                );
                const toWs = global.workspaceManager.get_workspace_by_index(
                    move.toWs
                );
                if (!snapshot || !window || !fromWs || !toWs) {
                    this._log(
                        'skipping move whose window or workspaces are gone:',
                        move
                    );
                    continue;
                }
                entries.push({ move, fromWs, toWs, window });
            }

            let appliedCount = 0;
            withAutoFillSuppressed(() => {
                for (const { move, fromWs, toWs, window } of entries) {
                    if (
                        !this._isWorkspaceLive(fromWs) ||
                        !this._isWorkspaceLive(toWs)
                    ) {
                        this._log(
                            `skipping ${move.kind} move on a removed workspace`
                        );
                        continue;
                    }
                    const targetSnapshot = this._snapshotCache.get(move.toWs);
                    const targetTile =
                        targetSnapshot?.sortedTiles[move.tileIndex];
                    if (!targetTile) {
                        this._log(
                            `skipping ${move.kind} move: no tile ${move.tileIndex} on ws ${move.toWs}`
                        );
                        continue;
                    }
                    const targetContext = contextsByMonitor.get(
                        targetTile.monitorIndex
                    );
                    if (!targetContext) {
                        this._log(
                            `skipping ${move.kind} move: monitor ${targetTile.monitorIndex} is no longer managed`
                        );
                        continue;
                    }
                    // copy like the assignedTile precedent: downstream
                    // placement must never share the layout's tile object
                    const tile = new Tile({ ...targetTile.layoutTile });

                    // the target monitor's tiling layout must exist BEFORE
                    // the window is placed there, or the placement bails
                    // out early
                    targetContext.ensureTilingLayout(toWs);
                    if (move.kind === 'pull') window.change_workspace(toWs);
                    // routed through the destination monitor's manager:
                    // its work area, gaps and move_to_monitor migration
                    targetContext.tileWindow(tile, window);
                    appliedCount++;
                    // shallow-copied rect: the snapshot tile's rect must
                    // never be shared with consumers of this record
                    _appliedFillMoves.push({
                        windowId: window.get_id(),
                        window,
                        toWsIndex: move.toWs,
                        destRect: {
                            x: targetTile.rect.x,
                            y: targetTile.rect.y,
                            width: targetTile.rect.width,
                            height: targetTile.rect.height,
                        },
                    });
                    this._log(
                        `${move.kind}: window moved to ws ${move.toWs} ` +
                            `monitor ${targetTile.monitorIndex} tile ${move.tileIndex}`
                    );
                }
            });
            this._log(
                `applied ${appliedCount}/${entries.length} planned move(s)`
            );
        } finally {
            _fillInProgress = false;
        }
    }

    /**
     * Occupancy vs movability snapshot of one workspace across every
     * managed monitor, in global pixel space. Occupancy mirrors
     * _getTiledWindowRects (assigned tile, not minimized, not maximized -
     * so fullscreen/sticky/dialog tiled windows keep their tiles busy);
     * movability mirrors the _findSwapTargetOnTile guard set plus
     * single-seat and still-on-own-tile checks.
     */
    private _buildSnapshot(
        wsIndex: number,
        contexts: FreeTileFillerMonitorContext[],
        exclude?: Meta.Window
    ): WorkspaceSnapshot | null {
        if (wsIndex >= global.workspaceManager.n_workspaces) return null;
        // re-query LIVE every call: with dynamic workspaces a ws may be
        // gone by the time the cascade reaches it (its last window left)
        const ws = global.workspaceManager.get_workspace_by_index(wsIndex);
        if (!ws) return null;

        const workAreas = new Map<number, Mtk.Rectangle>();
        const sortedTiles: SnapshotTile[] = [];
        for (const context of contexts) {
            const workArea = context.getWorkArea();
            workAreas.set(context.monitorIndex, workArea);
            for (const layoutTile of GlobalState.get().getSelectedLayoutOfMonitor(
                context.monitorIndex,
                wsIndex
            ).tiles) {
                const pixelRect = TileUtils.apply_props(layoutTile, workArea);
                sortedTiles.push({
                    rect: {
                        x: pixelRect.x,
                        y: pixelRect.y,
                        width: pixelRect.width,
                        height: pixelRect.height,
                    },
                    monitorIndex: context.monitorIndex,
                    layoutTile,
                });
            }
        }
        sortedTiles.sort((a, b) => compareTilesInReadingOrder(a.rect, b.rect));
        const sortedRects = sortedTiles.map(tile => tile.rect);

        const windows: Meta.Window[] = [];
        const windowRects: RectLike[] = [];
        const movableWindowIndexes: number[] = [];
        const floatingWindowIndexes: number[] = [];
        let tiledCount = 0;

        for (const window of getWindows(ws)) {
            // -1 (dying) and unmanaged monitors have no work area here
            const workArea = workAreas.get(window.get_monitor());
            if (!workArea) continue;
            const extWin = window as ExtendedWindow;

            if (
                window === exclude ||
                window.minimized ||
                window.maximizedHorizontally ||
                window.maximizedVertically
            )
                continue;

            // non-geometric movability guards, shared verbatim between
            // the floating and the tiled branch below
            const eligible =
                window.windowType === Meta.WindowType.NORMAL &&
                !window.is_on_all_workspaces() &&
                !window.is_fullscreen() &&
                window.get_transient_for() === null &&
                !window.is_attached_dialog() &&
                window.allows_move() &&
                window.allows_resize();

            if (!extWin.assignedTile) {
                // floating: an eligible window joins the snapshot as a
                // last-rank pull candidate (the planner treats it as
                // gone - never moved by compaction, never blocking the
                // tiles it covers); anything else stays completely
                // invisible so a fullscreen/dialog floating window
                // cannot block tiles it happens to cover
                if (!eligible) continue;
                // global pixels: the same space as the scaled tiles above
                const rect = window.get_frame_rect();
                windows.push(window);
                windowRects.push(rect);
                floatingWindowIndexes.push(windows.length - 1);
                continue;
            }

            // global pixels: the same space as the scaled tiles above
            const rect = window.get_frame_rect();
            windows.push(window);
            windowRects.push(rect);
            tiledCount++;

            // windows resized across tiles (or no longer mostly inside
            // their own assigned tile) block but never move
            const movable =
                eligible &&
                isSeatedOnSingleTile(rect, sortedRects) &&
                rectMostlyInsideTile(
                    rect,
                    TileUtils.apply_props(extWin.assignedTile, workArea)
                );
            if (movable) movableWindowIndexes.push(windows.length - 1);
        }

        this._log(
            `ws ${wsIndex}: ${tiledCount} tiled window(s) + ` +
                `${floatingWindowIndexes.length} floating candidate(s) ` +
                `over ${sortedTiles.length} tile(s) of ${contexts.length} ` +
                `monitor(s), ${movableWindowIndexes.length} movable`
        );
        this._snapshotCache.set(wsIndex, { windows, sortedTiles });
        return {
            tiles: sortedRects,
            windowRects,
            movableWindowIndexes,
            floatingWindowIndexes,
        };
    }

    private _isWorkspaceLive(ws: Meta.Workspace): boolean {
        try {
            return (
                global.workspaceManager.get_workspace_by_index(ws.index()) ===
                ws
            );
        } catch (e) {
            // a disposed workspace wrapper throws from GJS accessors
            this._log('workspace disposed mid-cascade:', e);
            return false;
        }
    }
}
