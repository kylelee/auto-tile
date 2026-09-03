/**
 * Executor of the "auto-fill freed tiles from next workspaces" cascade.
 *
 * TilingManager signal handlers funnel every freed-tile trigger into
 * scheduleFill(); this class defers the actual pass to a GLib idle (never
 * mutating windows inside a first-frame signal emission), builds the
 * occupancy/movable snapshots of each workspace, lets the pure
 * freeTileFillPlanner compute the cascade, and applies the resulting moves
 * through the injected tiling callbacks - without switching the workspace
 * view, without stealing focus and without touching other monitors.
 *
 * Geometry parity: window frame rects are normalized to workArea
 * proportions with TileUtils.build_tile (the exact inverse of the
 * TileUtils.apply_props formula used to convert tiles back to pixels);
 * layout tiles are already proportion-space and are passed as-is.
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
    isSeatedOnSingleTile,
    planFillCascade,
    rectMostlyInsideTile,
    sortTilesInReadingOrder,
    type CascadeMove,
    type RectLike,
    type WorkspaceSnapshot,
} from './freeTileFillPlanner';
import {
    isAutoFillSuppressed,
    withAutoFillSuppressed,
} from './autoFillSuppression';

export interface FreeTileFillerDependencies {
    monitorIndex: number;
    getWorkArea: () => Mtk.Rectangle;
    ensureTilingLayout: (ws: Meta.Workspace) => void;
    tileWindow: (tile: Tile, window: Meta.Window) => void;
    isInteracting: () => boolean;
}

interface PendingTrigger {
    wsIndex: number;
    exclude?: Meta.Window;
}

/** per-workspace data kept around for the plan application pass */
interface SnapshotWindows {
    windows: Meta.Window[];
    sortedTiles: Tile[];
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
     * from a GLib idle. While a grab is in progress the trigger is NOT
     * dropped: it is stashed (newer triggers overwrite older ones) and
     * re-scheduled by flushPending() when the grab ends.
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
        if (this._deps.isInteracting()) {
            this._log(`grab in progress: stashing trigger for ws ${wsIndex}`);
            this._pendingDuringGrab = { wsIndex, exclude };
            return;
        }

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

            this._snapshotCache.clear();
            // the planner walks cascade-relative ws indexes (0 = trigger
            // workspace); wrap the snapshot with the absolute offset and add
            // it back to every returned fromWs/toWs
            const plannedMoves = planFillCascade(k =>
                this._buildSnapshot(startWsIndex + k, exclude)
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
                    // copy like the assignedTile precedent: downstream
                    // placement must never share the layout's tile object
                    const tile = new Tile({ ...targetTile });

                    // the target tiling layout must exist BEFORE the window
                    // is placed there, or the placement bails out early
                    this._deps.ensureTilingLayout(toWs);
                    if (move.kind === 'pull') window.change_workspace(toWs);
                    this._deps.tileWindow(tile, window);
                    appliedCount++;
                    this._log(
                        `${move.kind}: window moved to ws ${move.toWs} tile ${move.tileIndex}`
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
     * Occupancy vs movability snapshot of one workspace, in proportion
     * space. Occupancy mirrors _getTiledWindowRects (assigned tile, not
     * minimized, not maximized - so fullscreen/sticky/dialog tiled windows
     * keep their tiles busy); movability mirrors the _findSwapTargetOnTile
     * guard set plus single-seat and still-on-own-tile checks.
     */
    private _buildSnapshot(
        wsIndex: number,
        exclude?: Meta.Window
    ): WorkspaceSnapshot | null {
        if (wsIndex >= global.workspaceManager.n_workspaces) return null;
        // re-query LIVE every call: with dynamic workspaces a ws may be
        // gone by the time the cascade reaches it (its last window left)
        const ws = global.workspaceManager.get_workspace_by_index(wsIndex);
        if (!ws) return null;

        const workArea = this._deps.getWorkArea();
        const layoutTiles = GlobalState.get().getSelectedLayoutOfMonitor(
            this._deps.monitorIndex,
            wsIndex
        ).tiles;
        // reading-order tiles (planner index space), same references
        const sortedTiles = sortTilesInReadingOrder(layoutTiles) as Tile[];

        const windows: Meta.Window[] = [];
        const windowRects: RectLike[] = [];
        const movableWindowIndexes: number[] = [];

        for (const window of getWindows(ws)) {
            if (window.get_monitor() !== this._deps.monitorIndex) continue;
            const extWin = window as ExtendedWindow;
            if (
                window === exclude ||
                !extWin.assignedTile ||
                window.minimized ||
                window.maximizedHorizontally ||
                window.maximizedVertically
            )
                continue;

            // exact inverse of the apply_props pixel conversion: any other
            // formula breaks the proportion parity the planner relies on
            const rect = TileUtils.build_tile(
                window.get_frame_rect(),
                workArea
            );
            windows.push(window);
            windowRects.push(rect);

            // windows resized across tiles (or no longer mostly inside
            // their own assigned tile) block but never move
            const movable =
                window.windowType === Meta.WindowType.NORMAL &&
                !window.is_on_all_workspaces() &&
                !window.is_fullscreen() &&
                window.get_transient_for() === null &&
                !window.is_attached_dialog() &&
                window.allows_move() &&
                window.allows_resize() &&
                isSeatedOnSingleTile(rect, sortedTiles) &&
                rectMostlyInsideTile(rect, extWin.assignedTile);
            if (movable) movableWindowIndexes.push(windows.length - 1);
        }

        this._log(
            `ws ${wsIndex}: ${windows.length} tiled window(s), ` +
                `${movableWindowIndexes.length} movable`
        );
        this._snapshotCache.set(wsIndex, { windows, sortedTiles });
        return { tiles: layoutTiles, windowRects, movableWindowIndexes };
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
