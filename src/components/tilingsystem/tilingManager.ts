import { Clutter, Mtk, Meta, GLib } from '../../gi/ext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { logger } from '../../utils/logger';
import {
    buildMargin,
    buildRectangle,
    buildTileGaps,
    getMonitorScalingFactor,
    getScalingFactorOf,
    getWindows,
    isPointInsideRect,
    isTileOnContainerBorder,
    squaredEuclideanDistance,
} from '../../utils/ui';
import TilingLayout from '../../components/tilingsystem/tilingLayout';
import SnapAssist from '../snapassist/snapAssist';
import SelectionTilePreview from '../tilepreview/selectionTilePreview';
import { ActivationKey, EdgeTilingMode } from '../../settings/settings';
import Settings from '../../settings/settings';
import SignalHandling from '../../utils/signalHandling';
import Layout from '../layout/Layout';
import Tile from '../layout/Tile';
import TileUtils from '../layout/TileUtils';
import {
    buildWorkspaceChain,
    findFirstVacancy,
    planInsertion,
    ChainInputs,
    ChainSlot,
    InsertionPlan,
} from './insertionPlanner';
import GlobalState from '../../utils/globalState';
import { Monitor } from 'resource:///org/gnome/shell/ui/layout.js';
import ExtendedWindow from './extendedWindow';
import EdgeTilingManager from './edgeTilingManager';
import FreeTileFiller, {
    type FreeTileFillerMonitorContext,
} from './freeTileFiller';
import TouchPointer from './touchPointer';
import { KeyBindingsDirection } from '../../keybindings';
import AutoTileWindowManager from '../../components/windowManager/autoTileWindowManager';
import TilingLayoutWithSuggestions from '../windowsSuggestions/tilingLayoutWithSuggestions';
import { maximizeWindow, unmaximizeWindow } from '../../utils/gnomesupport';
import { rectMostlyInsideTile } from './freeTileFillPlanner';
import {
    isAutoFillSuppressed,
    withAutoFillSuppressed,
} from './autoFillSuppression';
import { shouldAutoTileWindow } from './autoTileCandidate';

const MINIMUM_DISTANCE_TO_RESTORE_ORIGINAL_SIZE = 90;

class SnapAssistingInfo {
    private _snapAssistantLayoutId: string | undefined;

    constructor() {
        this._snapAssistantLayoutId = undefined;
    }

    public get layoutId(): string {
        return this._snapAssistantLayoutId ?? '';
    }

    public get isSnapAssisting(): boolean {
        return this._snapAssistantLayoutId !== undefined;
    }

    public update(layoutId: string | undefined) {
        this._snapAssistantLayoutId =
            !layoutId || layoutId.length === 0 ? undefined : layoutId;
    }
}

// squared-distance slack under which two vacant tiles count as equally
// centered when picking the next empty tile for a new window
const CENTERING_TIE_EPSILON = 1e-9;

// proportion-of-work-area slack under which a tile counts as touching the
// left or right edge of the monitor layout, for directional moves that
// continue into the adjacent workspace
const WORKSPACE_EDGE_EPSILON = 0.0001;

// Windows currently being placed by this module. The guard suppresses the
// window-entered-monitor re-tiling while our own placement (which calls
// move_to_monitor) is synchronously emitting monitor-crossed signals.
const _windowsUnderPlacement = new Set<Meta.Window>();

// FUTURE FEATURE CONTRACT (user constraint, 2026-09): the planned "move
// windows from right-side workspaces to refill free tiles of the current
// workspace" feature MUST NOT react to any free tile while
// _insertionShiftInProgress is true. The insert-after-focused behavior
// structurally and transiently frees slots: the insertion slot behind the
// anchor, plus every slot a shifted window is about to leave while a plan
// is being executed.
let _insertionShiftInProgress = false;

/**
 * Whether an insert-after-focused plan is currently in flight (from
 * planning inside the first-frame handler until the whole plan has been
 * executed by the idle callback). See the FUTURE FEATURE CONTRACT above.
 */
export function isInsertionShiftInProgress(): boolean {
    return _insertionShiftInProgress;
}

// structural mirror of AutoTileWindowManager's per-window cache marker
// (not exported there): only liveness and the tracked workspace are read here
interface WindowWithCachedProps extends Meta.Window {
    __ts_cached: { workspace: Meta.Workspace | null } | undefined;
}

// Snapshot of where a drag started, taken before the first _onMovingWindow
// pass clears assignedTile (recording after it would always see tiled=false).
// Consumed by _onGrabEndFollowUp and by enforceTiledPlacement
interface GrabOrigin {
    window: Meta.Window;
    tiled: boolean;
    monitorIndex: number;
    ws: Meta.Workspace | undefined;
    wsIndex: number | undefined;
    tile: Tile | undefined;
}

// per-call behavior of enforceTiledPlacement: the window-workspace-changed
// wire passes ignoreGeometry because a workspace-only move leaves the frame
// rect unchanged (still inside its tile) — the geometry test can never see
// it, so the workspace change itself is the gate there
export interface EnforceTiledPlacementOptions {
    ignoreGeometry?: boolean;
}

export class TilingManager {
    private readonly _monitor: Monitor;

    private _selectedTilesPreview: SelectionTilePreview;
    private _snapAssist: SnapAssist;
    private _workspaceTilingLayout: Map<Meta.Workspace, TilingLayout>;
    private _edgeTilingManager: EdgeTilingManager;
    private _tilingSuggestionsLayout: TilingLayoutWithSuggestions;

    private _workArea: Mtk.Rectangle;
    private _enableScaling: boolean;

    private _isGrabbingWindow: boolean;
    private _movingWindowTimerDuration: number = 15;
    private _lastCursorPos: { x: number; y: number } | null = null;
    private _grabStartPosition: { x: number; y: number } | null = null;
    private _wasSpanMultipleTilesActivated: boolean;
    private _wasTilingSystemActivated: boolean;
    private _snapAssistingInfo: SnapAssistingInfo;
    private _getTilingManager?: (index: number) => TilingManager | undefined;

    private _movingWindowTimerId: number | null = null;
    // one-shot idle/timeout sources still pending: cancelled on destroy so no
    // callback touches a destroyed manager after the extension is disabled
    private readonly _pendingMainloopSources = new Set<number>();

    private _freeTileFiller?: FreeTileFiller;
    private _grabOrigin: GrabOrigin | null = null;

    private readonly _signals: SignalHandling;
    private readonly _grabSignals: SignalHandling;
    private readonly _debug: (..._content: unknown[]) => void;

    /**
     * Constructs a new TilingManager instance.
     * @param monitor The monitor to manage tiling for.
     */
    constructor(
        monitor: Monitor,
        enableScaling: boolean,
        getTilingManager?: (index: number) => TilingManager | undefined
    ) {
        this._isGrabbingWindow = false;
        this._wasSpanMultipleTilesActivated = false;
        this._wasTilingSystemActivated = false;
        this._snapAssistingInfo = new SnapAssistingInfo();
        this._enableScaling = enableScaling;
        this._monitor = monitor;
        this._signals = new SignalHandling();
        this._grabSignals = new SignalHandling();
        this._getTilingManager = getTilingManager;

        this._debug = logger(`TilingManager ${monitor.index}`);

        // get the monitor's workarea
        this._workArea = Main.layoutManager.getWorkAreaForMonitor(
            this._monitor.index
        );
        this._debug(
            `Work area for monitor ${this._monitor.index}: ${this._workArea.x} ${this._workArea.y} ${this._workArea.width}x${this._workArea.height}`
        );
        this._edgeTilingManager = new EdgeTilingManager(this._workArea);
        this._edgeTilingManager.monitorIndex = this._monitor.index;

        // handle scale factor of the monitor
        const monitorScalingFactor = this._enableScaling
            ? getMonitorScalingFactor(monitor.index)
            : undefined;

        // build a tiling layout for each workspace
        this._workspaceTilingLayout = new Map();
        for (let i = 0; i < global.workspaceManager.get_n_workspaces(); i++) {
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;

            const innerGaps = buildMargin(Settings.get_inner_gaps());
            const outerGaps = buildMargin(Settings.get_outer_gaps());
            const layout = GlobalState.get().getSelectedLayoutOfMonitor(
                monitor.index,
                ws.index()
            );
            this._workspaceTilingLayout.set(
                ws,
                new TilingLayout(
                    layout,
                    innerGaps,
                    outerGaps,
                    this._workArea,
                    monitorScalingFactor
                )
            );
        }

        this._tilingSuggestionsLayout = new TilingLayoutWithSuggestions(
            buildMargin(Settings.get_inner_gaps()),
            buildMargin(Settings.get_outer_gaps()),
            this._workArea,
            monitorScalingFactor
        );

        // build the selection tile
        this._selectedTilesPreview = new SelectionTilePreview({
            parent: global.windowGroup,
        });

        // build the snap assistant
        this._snapAssist = new SnapAssist(
            Main.uiGroup,
            this._workArea,
            this._monitor.index,
            monitorScalingFactor
        );
    }

    /**
     * Enables tiling manager by setting up event listeners:
     *  - handle any window's grab begin.
     *  - handle any window's grab end.
     *  - handle grabbed window's movement.
     */
    public enable() {
        this._signals.connect(
            Settings,
            Settings.KEY_SETTING_SELECTED_LAYOUTS,
            () => {
                const ws = global.workspaceManager.get_active_workspace();
                if (!ws) return;

                const layout = GlobalState.get().getSelectedLayoutOfMonitor(
                    this._monitor.index,
                    ws.index()
                );
                this._workspaceTilingLayout.get(ws)?.relayout({ layout });
            }
        );
        this._signals.connect(
            GlobalState.get(),
            GlobalState.SIGNAL_LAYOUTS_CHANGED,
            () => {
                const ws = global.workspaceManager.get_active_workspace();
                if (!ws) return;

                const layout = GlobalState.get().getSelectedLayoutOfMonitor(
                    this._monitor.index,
                    ws.index()
                );
                this._workspaceTilingLayout.get(ws)?.relayout({ layout });
            }
        );

        this._signals.connect(Settings, Settings.KEY_INNER_GAPS, () => {
            const innerGaps = buildMargin(Settings.get_inner_gaps());
            this._workspaceTilingLayout.forEach(tilingLayout =>
                tilingLayout.relayout({ innerGaps })
            );
        });
        this._signals.connect(Settings, Settings.KEY_OUTER_GAPS, () => {
            const outerGaps = buildMargin(Settings.get_outer_gaps());
            this._workspaceTilingLayout.forEach(tilingLayout =>
                tilingLayout.relayout({ outerGaps })
            );
        });

        this._signals.connect(
            global.display,
            'grab-op-begin',
            (
                _display: Meta.Display,
                window: Meta.Window,
                grabOp: Meta.GrabOp
            ) => {
                const moving = (grabOp & ~1024) === 1;
                if (!moving) return;

                this._onWindowGrabBegin(window, grabOp);
            }
        );

        this._signals.connect(
            global.display,
            'grab-op-end',
            (_display: Meta.Display, window: Meta.Window) => {
                if (!this._isGrabbingWindow) return;

                this._onWindowGrabEnd(window);
                // placed AFTER _onWindowGrabEnd returns so it also runs on
                // each of its early returns (drag-away included)
                this._onGrabEndFollowUp(window);
            }
        );

        this._signals.connect(
            this._snapAssist,
            'snap-assist',
            this._onSnapAssist.bind(this)
        );

        this._signals.connect(
            global.workspaceManager,
            'active-workspace-changed',
            () => {
                const ws = global.workspaceManager.get_active_workspace();
                this._ensureTilingLayout(ws);
            }
        );

        this._signals.connect(
            global.workspaceManager,
            'workspace-removed',
            _ => {
                const newMap: Map<Meta.Workspace, TilingLayout> = new Map();
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const tl = this._workspaceTilingLayout.get(ws);
                    if (!tl) continue;

                    this._workspaceTilingLayout.delete(ws);
                    newMap.set(ws, tl);
                }

                [...this._workspaceTilingLayout.values()].forEach(tl =>
                    tl.destroy()
                );
                this._workspaceTilingLayout.clear();
                this._workspaceTilingLayout = newMap;
                this._debug('deleted workspace');
            }
        );

        this._signals.connect(
            global.display,
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                if (Settings.ENABLE_AUTO_TILING) this._autoTile(window, true);
            }
        );
        this._signals.connect(
            AutoTileWindowManager.get(),
            'unmaximized',
            (_, window: Meta.Window) => {
                if (Settings.ENABLE_AUTO_TILING) this._autoTile(window, false);
            }
        );

        // forget assigned tile when window is maximized
        this._signals.connect(
            AutoTileWindowManager.get(),
            'maximized',
            (_, window: Meta.Window) => {
                delete (window as ExtendedWindow).assignedTile;
            }
        );

        // auto-fill of freed tiles: one executor per monitor, each
        // planning the cascade across EVERY managed monitor so that a
        // free tile on any monitor can be filled from any other one
        this._freeTileFiller = new FreeTileFiller({
            getMonitorContexts: () => this._freeFillMonitorContexts(),
        });

        this._signals.connect(
            AutoTileWindowManager.get(),
            'window-unmanaged',
            (_, window: Meta.Window) => {
                // only a window that occupied a tile can free one
                if (!(window as ExtendedWindow).assignedTile) return;

                // the signal broadcasts to EVERY manager: only the owner of
                // the window's monitor (read at signal time) may trigger the
                // cascade, or N monitors run N cascades for one close
                const monitorIndex = window.get_monitor();
                if (this._monitor.index !== monitorIndex) return;

                // resolve the old workspace LIVE from the tracked workspace
                // OBJECT: a stored index goes stale under dynamic-workspace
                // renumbering and get_workspace() is unreliable at unmanage
                // time. A disposed wrapper throws, and a missing tracker
                // means no safe origin: skip the trigger entirely in both
                // cases
                const trackedWs = (window as WindowWithCachedProps).__ts_cached
                    ?.workspace;
                if (!trackedWs) {
                    console.warn(
                        'AutoTile: unmanaged window has no tracked workspace, skipping auto-fill trigger'
                    );
                    return;
                }
                try {
                    const oldWsIndex = trackedWs.index();
                    this._getTilingManager?.(monitorIndex)?.scheduleAutoFill(
                        oldWsIndex,
                        window
                    );
                } catch (e) {
                    console.warn(
                        'AutoTile: tracked workspace of unmanaged window was disposed, skipping auto-fill trigger',
                        e
                    );
                }
            }
        );

        this._signals.connect(
            AutoTileWindowManager.get(),
            'window-workspace-changed',
            (_, window: Meta.Window, oldIdx: number, newIdx: number) => {
                // the assignedTile gating also keeps floating-window moves
                // and the untiled new-window placement flow from falsely
                // triggering
                if (!(window as ExtendedWindow).assignedTile) return;
                if (oldIdx === newIdx) return;
                if (window.get_monitor() !== this._monitor.index) return;

                // tile-lock enforcement: the workspace change itself is the
                // gate — overview drops and native Super+Shift-arrow moves
                // of tiled windows revert to their origin workspace/tile.
                // Per the plan this path is geometry-blind to
                // workspace-only moves: the legit test is bypassed via
                // ignoreGeometry (the frame rect is unchanged by a pure
                // workspace move, so the geometry test could never see it);
                // mid-drag switches must not fight the ongoing drag and
                // sticky "always on visible workspace" is a membership
                // change that must not be fought either
                if (
                    Settings.ENABLE_AUTO_FILL_FREED_TILES &&
                    !this._isGrabbingWindow &&
                    !isAutoFillSuppressed() &&
                    !window.is_on_all_workspaces() &&
                    window.get_workspace() !== null
                ) {
                    const assignedTile = (window as ExtendedWindow)
                        .assignedTile;
                    // the tracked workspace OBJECT read at signal time is
                    // still the OLD workspace (the tracker is refreshed
                    // only after this signal is emitted)
                    let trackedWs: Meta.Workspace | null = null;
                    try {
                        trackedWs =
                            (window as WindowWithCachedProps).__ts_cached
                                ?.workspace ?? null;
                    } catch (_e) {
                        trackedWs = null;
                    }
                    if (assignedTile && trackedWs) {
                        this.enforceTiledPlacement(
                            window,
                            {
                                window,
                                tiled: true,
                                monitorIndex: window.get_monitor(),
                                ws: trackedWs,
                                wsIndex: oldIdx,
                                tile: new Tile({ ...assignedTile }),
                            },
                            { ignoreGeometry: true }
                        );
                    }
                }

                this.scheduleAutoFill(oldIdx);
            }
        );
    }

    private _ensureTilingLayout(ws: Meta.Workspace): TilingLayout {
        const existing = this._workspaceTilingLayout.get(ws);
        if (existing) return existing;

        const monitorScalingFactor = this._enableScaling
            ? getMonitorScalingFactor(this._monitor.index)
            : undefined;
        const layout: Layout = GlobalState.get().getSelectedLayoutOfMonitor(
            this._monitor.index,
            ws.index()
        );
        const innerGaps = buildMargin(Settings.get_inner_gaps());
        const outerGaps = buildMargin(Settings.get_outer_gaps());

        this._debug('created new tiling layout for active workspace');
        const tilingLayout = new TilingLayout(
            layout,
            innerGaps,
            outerGaps,
            this._workArea,
            monitorScalingFactor
        );
        this._workspaceTilingLayout.set(ws, tilingLayout);
        return tilingLayout;
    }

    public onUntileWindow(window: Meta.Window, force: boolean): void {
        const destination = (window as ExtendedWindow).originalSize;
        if (!destination) return;

        this._easeWindowRect(window, destination, false, force);

        (window as ExtendedWindow).assignedTile = undefined;
    }

    private _directionEnlargeFactor(tilingLayout: TilingLayout): number {
        return Math.max(
            64, // if the gaps are all 0 we choose 64 instead
            tilingLayout.innerGaps.right,
            tilingLayout.innerGaps.left,
            tilingLayout.innerGaps.right,
            tilingLayout.innerGaps.bottom
        );
    }

    public onKeyboardMoveWindow(
        window: Meta.Window,
        direction: KeyBindingsDirection,
        force: boolean,
        spanFlag: boolean,
        clamp: boolean,
        // freeTileOnly is superseded by uniform swap semantics (Q2 user decision)
        // and kept only so src/extension.ts' call signature stays untouched; it
        // has no effect for directional moves now.
        opts: { deferEdgeToNeighbor?: boolean; freeTileOnly?: boolean } = {}
    ): boolean {
        let destination: { rect: Mtk.Rectangle; tile: Tile } | undefined;
        const isMaximized =
            window.maximizedHorizontally || window.maximizedVertically;
        if (spanFlag && isMaximized) return false;

        const currentWs = window.get_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (!tilingLayout) return false;
        const windowRectCopy = window.get_frame_rect().copy();
        const extWin = window as ExtendedWindow;

        if (isMaximized) {
            switch (direction) {
                case KeyBindingsDirection.NODIRECTION:
                case KeyBindingsDirection.LEFT:
                case KeyBindingsDirection.RIGHT:
                    break;
                case KeyBindingsDirection.DOWN:
                    unmaximizeWindow(window);
                    return true;
                case KeyBindingsDirection.UP:
                    return false;
            }
        }

        // maximize the window using keybindings
        if (
            direction === KeyBindingsDirection.UP &&
            window.get_monitor() === this._monitor.index &&
            extWin.assignedTile &&
            extWin.assignedTile?.y === 0
        ) {
            // defer to the neighbor-monitor fallback (it may find a free
            // tile on the monitor above; if not, its no-destination path
            // maximizes below)
            if (opts.deferEdgeToNeighbor) return false;
            maximizeWindow(window);
            return true;
        }

        // find the nearest tile
        // direction is NODIRECTION -> move to the center of the screen
        if (direction === KeyBindingsDirection.NODIRECTION) {
            const rect = buildRectangle({
                x:
                    this._workArea.x +
                    this._workArea.width / 2 -
                    windowRectCopy.width / 2,
                y:
                    this._workArea.y +
                    this._workArea.height / 2 -
                    windowRectCopy.height / 2,
                width: windowRectCopy.width,
                height: windowRectCopy.height,
            });
            destination = {
                rect,
                tile: TileUtils.build_tile(rect, this._workArea),
            };
        } else if (window.get_monitor() === this._monitor.index) {
            const enlargeFactor = this._directionEnlargeFactor(tilingLayout);
            destination = tilingLayout.findNearestTileDirection(
                windowRectCopy,
                direction,
                clamp,
                enlargeFactor
            );
        } else {
            // the window comes from another monitor: the direction-adjacent tile
            // on THIS monitor's layout is THE target - occupied -> swap (see the
            // shared hook below), free -> move onto it. No free-tile search, no
            // center-nearest fallback: keeps the pure "move to the next tile in
            // the direction" mental model (user decision).
            if (direction === KeyBindingsDirection.NODIRECTION) {
                // structurally unreachable for ANY caller: the if-chain above
                // (direction === NODIRECTION branch) routes NODIRECTION away from
                // this else. Retained only to keep the legacy free-tile search
                // code alive for future direct callers of this public method.
                destination = tilingLayout.findNearestFreeTile(
                    windowRectCopy,
                    this._getTiledWindowRects(currentWs)
                );
                if (!destination && !opts.freeTileOnly)
                    destination = tilingLayout.findNearestTile(windowRectCopy);
            } else {
                destination = tilingLayout.findNearestTileDirection(
                    windowRectCopy,
                    direction,
                    true, // clamp: the offset point must land inside this monitor
                    this._directionEnlargeFactor(tilingLayout)
                );
                if (!destination) return false; // defensive: no tile resolvable
            }
        }

        // if the window is already on the desired tile
        if (
            window.get_monitor() === this._monitor.index &&
            destination &&
            !window.maximizedHorizontally &&
            !window.maximizedVertically &&
            (window as ExtendedWindow).assignedTile &&
            (window as ExtendedWindow).assignedTile?.x === destination.tile.x &&
            (window as ExtendedWindow).assignedTile?.y === destination.tile.y &&
            (window as ExtendedWindow).assignedTile?.width ===
                destination.tile.width &&
            (window as ExtendedWindow).assignedTile?.height ===
                destination.tile.height
        )
            return true;

        // there isn't a tile near the window
        if (!destination) {
            if (spanFlag) return false;

            // handle maximize of window
            if (
                direction === KeyBindingsDirection.UP &&
                window.can_maximize() &&
                !opts.deferEdgeToNeighbor
            ) {
                maximizeWindow(window);
                return true;
            }
            return false;
        }

        if (!(window as ExtendedWindow).assignedTile && !isMaximized)
            (window as ExtendedWindow).originalSize = windowRectCopy;

        if (spanFlag) {
            destination.rect = destination.rect.union(windowRectCopy);
            destination.tile = TileUtils.build_tile(
                destination.rect,
                this._workArea
            );
        }

        // directional swap: the destination tile is occupied -> exchange positions
        // with its topmost swappable window (same monitor and neighbor monitor
        // alike; see _performKeyboardSwap for the canonical tile-placement leg).
        // The mover must itself be tiled: after a swap BOTH windows must conform
        // to their target tiles (user constraint) - a floating mover keeps the
        // legacy stacking move.
        if (
            !spanFlag &&
            !isMaximized &&
            direction !== KeyBindingsDirection.NODIRECTION &&
            destination &&
            (window as ExtendedWindow).assignedTile
        ) {
            const swapTarget = this._findSwapTargetOnTile(
                destination.tile,
                currentWs,
                window
            );
            if (swapTarget) this._performKeyboardSwap(window, swapTarget);
        }

        if (isMaximized) unmaximizeWindow(window);

        this._easeWindowRect(window, destination.rect, false, force);

        if (direction !== KeyBindingsDirection.NODIRECTION) {
            // ensure the assigned tile is a COPY
            (window as ExtendedWindow).assignedTile = new Tile({
                ...destination.tile,
            });
        }
        return true;
    }

    /**
     * Destroys the tiling manager and cleans up resources.
     */
    public destroy() {
        if (this._movingWindowTimerId) {
            GLib.Source.remove(this._movingWindowTimerId);
            this._movingWindowTimerId = null;
        }
        this._pendingMainloopSources.forEach(id => GLib.Source.remove(id));
        this._pendingMainloopSources.clear();
        // a cancelled FORM TWO idle would otherwise leave the flag latched
        _insertionShiftInProgress = false;
        this._signals.disconnect();
        this._grabSignals.disconnect();
        this._grabOrigin = null;
        this._freeTileFiller?.destroy();
        this._freeTileFiller = undefined;
        this._isGrabbingWindow = false;
        this._snapAssistingInfo.update(undefined);
        this._edgeTilingManager.abortEdgeTiling();
        this._workspaceTilingLayout.forEach(tl => tl.destroy());
        this._workspaceTilingLayout.clear();
        this._snapAssist.destroy();
        this._selectedTilesPreview.destroy();
        this._tilingSuggestionsLayout.destroy();
    }

    public set workArea(newWorkArea: Mtk.Rectangle) {
        if (newWorkArea.equal(this._workArea)) return;

        this._workArea = newWorkArea;
        this._debug(
            `new work area for monitor ${this._monitor.index}: ${newWorkArea.x} ${newWorkArea.y} ${newWorkArea.width}x${newWorkArea.height}`
        );

        // notify the tiling layout that the workarea changed and trigger a new relayout
        // so we will have the layout already computed to be shown quickly when needed
        this._workspaceTilingLayout.forEach(tl =>
            tl.relayout({ containerRect: this._workArea })
        );
        this._snapAssist.workArea = this._workArea;
        this._edgeTilingManager.workarea = this._workArea;
    }

    private _onWindowGrabBegin(window: Meta.Window, grabOp: number) {
        if (this._isGrabbingWindow) return;

        // defensive: drop connections of a grab whose end was missed
        this._grabSignals.disconnect();

        // drag origin snapshot: MUST be recorded strictly before the
        // synchronous _onMovingWindow call at the bottom of this method,
        // whose first pass clears assignedTile (recording after it would
        // silently kill the drag lock: tiled would always be false)
        const extWin = window as ExtendedWindow;
        this._grabOrigin = {
            window,
            tiled: !!extWin.assignedTile,
            monitorIndex: window.get_monitor(),
            ws: window.get_workspace() ?? undefined,
            wsIndex: window.get_workspace()?.index(),
            tile: extWin.assignedTile
                ? new Tile({ ...extWin.assignedTile })
                : undefined,
        };

        TouchPointer.get().updateWindowPosition(window.get_frame_rect());
        this._grabSignals.connect(
            global.stage,
            'touch-event',
            (_source, event: Clutter.Event) => {
                const [x, y] = event.get_coords();
                TouchPointer.get().onTouchEvent(x, y);
            }
        );
        // Add Wacom tablet support, listen to tablet events
        this._grabSignals.connect(
            global.stage,
            'captured-event',
            (_source, event: Clutter.Event) => {
                const device = event.get_source_device();
                if (!device) return;

                const deviceType = device.get_device_type();

                // Check for tablet device types
                if (
                    deviceType === Clutter.InputDeviceType.TABLET_DEVICE ||
                    deviceType === Clutter.InputDeviceType.PEN_DEVICE
                ) {
                    const eventType = event.type();
                    // Capture motion events from tablet
                    if (eventType === Clutter.EventType.MOTION) {
                        const [x, y] = event.get_coords();
                        TouchPointer.get().onTouchEvent(x, y);
                        // Move the actual mouse cursor to match tablet position
                        const seat =
                            Clutter.get_default_backend().get_default_seat();
                        seat.warp_pointer(x, y);
                    }
                }
            }
        );

        // workaround for gnome-shell bug https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2857
        if (
            Settings.ENABLE_BLUR_SNAP_ASSISTANT ||
            Settings.ENABLE_BLUR_SELECTED_TILEPREVIEW
        ) {
            this._grabSignals.connect(window, 'position-changed', () => {
                if (Settings.ENABLE_BLUR_SELECTED_TILEPREVIEW) {
                    this._selectedTilesPreview
                        .get_effect('blur')
                        ?.queue_repaint();
                }
                if (Settings.ENABLE_BLUR_SNAP_ASSISTANT) {
                    this._snapAssist
                        .get_first_child()
                        ?.get_effect('blur')
                        ?.queue_repaint();
                }
            });
        }

        this._isGrabbingWindow = true;
        this._movingWindowTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            this._movingWindowTimerDuration,
            this._onMovingWindow.bind(this, window, grabOp)
        );

        this._onMovingWindow(window, grabOp);
    }

    private _activationKeyStatus(
        modifier: number,
        key: ActivationKey
    ): boolean {
        if (key === ActivationKey.NONE) return true;

        let mask = Clutter.ModifierType.CONTROL_MASK;
        switch (key) {
            case ActivationKey.CTRL:
                mask = Clutter.ModifierType.CONTROL_MASK;
                break;
            case ActivationKey.ALT:
                mask = Clutter.ModifierType.MOD1_MASK;
                break;
            case ActivationKey.SUPER:
                mask = Clutter.ModifierType.SUPER_MASK;
                break;
        }
        return (modifier & mask) === mask;
    }

    private _onMovingWindow(window: Meta.Window, grabOp: number) {
        // if the window is no longer grabbed, disable handler
        if (!this._isGrabbingWindow) {
            this._movingWindowTimerId = null;
            return GLib.SOURCE_REMOVE;
        }

        const currentWs = window.get_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (!tilingLayout) return GLib.SOURCE_REMOVE;

        this._edgeTilingManager.workspaceIndex = currentWs.index();

        // if the window was moved into another monitor and it is still grabbed
        if (
            !window.allows_resize() ||
            !window.allows_move() ||
            !this._isPointerInsideThisMonitor(window)
        ) {
            tilingLayout.close();
            this._selectedTilesPreview.close(true);
            this._snapAssist.close(true);
            this._snapAssistingInfo.update(undefined);
            this._edgeTilingManager.abortEdgeTiling();

            return GLib.SOURCE_CONTINUE;
        }

        const [x, y, modifier] = TouchPointer.get().isTouchDeviceActive()
            ? TouchPointer.get().get_pointer(window)
            : global.get_pointer();
        const extWin = window as ExtendedWindow;
        extWin.assignedTile = undefined;
        const currPointerPos = { x, y };
        if (this._grabStartPosition === null)
            this._grabStartPosition = { x, y };

        // if there is "originalSize" attached, it means the window were tiled and
        // it is the first time the window is moved. If that's the case, change
        // window's size to the size it had before it were tiled (the originalSize)
        if (
            extWin.originalSize &&
            squaredEuclideanDistance(currPointerPos, this._grabStartPosition) >
                MINIMUM_DISTANCE_TO_RESTORE_ORIGINAL_SIZE
        ) {
            if (Settings.RESTORE_WINDOW_ORIGINAL_SIZE) {
                const windowRect = window.get_frame_rect();
                const offsetX = (x - windowRect.x) / windowRect.width;
                const offsetY = (y - windowRect.y) / windowRect.height;

                const newSize = buildRectangle({
                    x: x - extWin.originalSize.width * offsetX,
                    y: y - extWin.originalSize.height * offsetY,
                    width: extWin.originalSize.width,
                    height: extWin.originalSize.height,
                });

                // restart grab for GNOME 42
                const restartGrab =
                    // @ts-expect-error "grab is available on GNOME 42"
                    global.display.end_grab_op && global.display.begin_grab_op;
                if (restartGrab) {
                    // @ts-expect-error "grab is available on GNOME 42"
                    global.display.end_grab_op(global.get_current_time());
                }
                // if we restarted the grab, we need to force window movement and to
                // perform user operation
                this._easeWindowRect(window, newSize, restartGrab, restartGrab);
                TouchPointer.get().updateWindowPosition(newSize);

                if (restartGrab) {
                    // must be done now, before begin_grab_op, because begin_grab_op will trigger
                    // _onMovingWindow again, so we will go into infinite loop on restoring the window size
                    extWin.originalSize = undefined;
                    // @ts-expect-error "grab is available on GNOME 42"
                    global.display.begin_grab_op(
                        window,
                        grabOp,
                        true, // pointer already grabbed
                        true, // frame action
                        -1, // Button
                        modifier,
                        global.get_current_time(),
                        x,
                        y
                    );
                }
            }
            extWin.originalSize = undefined;
            this._grabStartPosition = null;
        }

        const isSpanMultiTilesActivated = this._activationKeyStatus(
            modifier,
            Settings.SPAN_MULTIPLE_TILES_ACTIVATION_KEY
        );
        const isTilingSystemActivated = this._activationKeyStatus(
            modifier,
            Settings.TILING_SYSTEM_ACTIVATION_KEY
        );
        const deactivationKey = Settings.TILING_SYSTEM_DEACTIVATION_KEY;
        const isTilingSystemDeactivated =
            deactivationKey === ActivationKey.NONE
                ? false
                : this._activationKeyStatus(modifier, deactivationKey);
        const allowSpanMultipleTiles =
            Settings.SPAN_MULTIPLE_TILES && isSpanMultiTilesActivated;
        const showTilingSystem =
            Settings.TILING_SYSTEM &&
            isTilingSystemActivated &&
            !isTilingSystemDeactivated;
        // ensure we handle window movement only when needed
        // if the snap assistant activation key status is not changed and the mouse is on the same position as before
        // and the tiling system activation key status is not changed, we have nothing to do
        const changedSpanMultipleTiles =
            Settings.SPAN_MULTIPLE_TILES &&
            isSpanMultiTilesActivated !== this._wasSpanMultipleTilesActivated;
        const changedShowTilingSystem =
            Settings.TILING_SYSTEM &&
            isTilingSystemActivated !== this._wasTilingSystemActivated;
        if (
            !changedSpanMultipleTiles &&
            !changedShowTilingSystem &&
            currPointerPos.x === this._lastCursorPos?.x &&
            currPointerPos.y === this._lastCursorPos?.y
        )
            return GLib.SOURCE_CONTINUE;

        this._lastCursorPos = currPointerPos;
        this._wasTilingSystemActivated = isTilingSystemActivated;
        this._wasSpanMultipleTilesActivated = isSpanMultiTilesActivated;

        // layout must not be shown if it was disabled or if it is enabled but tiling system activation key is not pressed
        // then close it and open snap assist (if enabled)
        if (!showTilingSystem) {
            if (tilingLayout.showing) {
                tilingLayout.close();
                this._selectedTilesPreview.close(true);
            }

            if (
                Settings.ACTIVE_SCREEN_EDGES &&
                !this._snapAssistingInfo.isSnapAssisting &&
                this._edgeTilingManager.canActivateEdgeTiling(currPointerPos)
            ) {
                const { changed, rect } =
                    this._edgeTilingManager.startEdgeTiling(currPointerPos);
                if (changed)
                    this._showEdgeTiling(window, rect, x, y, tilingLayout);
                this._snapAssist.close(true);
            } else {
                if (this._edgeTilingManager.isPerformingEdgeTiling()) {
                    this._selectedTilesPreview.close(true);
                    this._edgeTilingManager.abortEdgeTiling();
                }

                if (Settings.SNAP_ASSIST) {
                    this._snapAssist.onMovingWindow(
                        window,
                        currPointerPos,
                        true
                    );
                }
            }

            return GLib.SOURCE_CONTINUE;
        }

        // we know that the layout must be shown, snap assistant must be closed
        if (!tilingLayout.showing) {
            // this._debug("open layout below grabbed window");
            tilingLayout.openAbove(window);
            this._snapAssist.close(true);
            // close selection tile if we were performing edge-tiling
            if (this._edgeTilingManager.isPerformingEdgeTiling()) {
                this._selectedTilesPreview.close(true);
                this._edgeTilingManager.abortEdgeTiling();
            }
        }
        // if it was snap assisting then close the selection tile preview. We may reopen it if that's the case
        if (this._snapAssistingInfo.isSnapAssisting) {
            this._selectedTilesPreview.close(true);
            this._snapAssistingInfo.update(undefined);
        }

        // if the pointer is inside the current selection and ALT key status is not changed, then there is nothing to do
        if (
            !changedSpanMultipleTiles &&
            isPointInsideRect(currPointerPos, this._selectedTilesPreview.rect)
        )
            return GLib.SOURCE_CONTINUE;

        let selectionRect = tilingLayout.getTileBelow(
            currPointerPos,
            changedSpanMultipleTiles && !allowSpanMultipleTiles
        );
        if (!selectionRect) return GLib.SOURCE_CONTINUE;

        selectionRect = selectionRect.copy();
        if (allowSpanMultipleTiles && this._selectedTilesPreview.showing) {
            selectionRect = selectionRect.union(
                this._selectedTilesPreview.rect
            );
        }
        tilingLayout.hoverTilesInRect(selectionRect, !allowSpanMultipleTiles);

        this.openSelectionTilePreview(selectionRect, true, true, window);

        return GLib.SOURCE_CONTINUE;
    }

    private _onWindowGrabEnd(window: Meta.Window) {
        this._isGrabbingWindow = false;
        this._grabStartPosition = null;

        this._grabSignals.disconnect();
        TouchPointer.get().reset();

        const currentWs = window.get_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (tilingLayout) tilingLayout.close();
        const desiredWindowRect = buildRectangle({
            x: this._selectedTilesPreview.innerX,
            y: this._selectedTilesPreview.innerY,
            width: this._selectedTilesPreview.innerWidth,
            height: this._selectedTilesPreview.innerHeight,
        });
        const selectedTilesRect = this._selectedTilesPreview.rect.copy();
        this._selectedTilesPreview.close(true);
        this._snapAssist.close(true);
        this._lastCursorPos = null;

        const isTilingSystemActivated = this._activationKeyStatus(
            global.get_pointer()[2],
            Settings.TILING_SYSTEM_ACTIVATION_KEY
        );
        if (
            !isTilingSystemActivated &&
            !this._snapAssistingInfo.isSnapAssisting &&
            !this._edgeTilingManager.isPerformingEdgeTiling()
        )
            return;

        const wasSnapAssistingLayout = this._snapAssistingInfo.isSnapAssisting
            ? GlobalState.get().layouts.find(
                  lay => lay.id === this._snapAssistingInfo.layoutId
              )
            : undefined;

        // disable snap assistance
        this._snapAssistingInfo.update(undefined);

        if (
            this._edgeTilingManager.isPerformingEdgeTiling() &&
            this._edgeTilingManager.needMaximize() &&
            window.can_maximize()
        )
            maximizeWindow(window);

        // disable edge-tiling
        const wasEdgeTiling = this._edgeTilingManager.isPerformingEdgeTiling();
        this._edgeTilingManager.abortEdgeTiling();

        const canShowTilingSuggestions =
            (wasSnapAssistingLayout &&
                Settings.ENABLE_SNAP_ASSISTANT_WINDOWS_SUGGESTIONS) ||
            (wasEdgeTiling &&
                Settings.ENABLE_SCREEN_EDGES_WINDOWS_SUGGESTIONS) ||
            (isTilingSystemActivated &&
                Settings.ENABLE_TILING_SYSTEM_WINDOWS_SUGGESTIONS);

        // abort if the pointer is moving on another monitor: the user moved
        // the window to another monitor not handled by this tiling manager
        if (!this._isPointerInsideThisMonitor(window)) return;

        // abort if there is an invalid selection
        if (desiredWindowRect.width <= 0 || desiredWindowRect.height <= 0)
            return;

        if (window.maximizedHorizontally || window.maximizedVertically) return;

        (window as ExtendedWindow).originalSize = window
            .get_frame_rect()
            .copy();
        (window as ExtendedWindow).assignedTile = new Tile({
            ...TileUtils.build_tile(selectedTilesRect, this._workArea),
        });
        this._easeWindowRect(window, desiredWindowRect);

        // Sync the desktop layout to match the snap-assisted layout if enabled
        if (wasSnapAssistingLayout && Settings.SNAP_ASSIST_SYNC_LAYOUT) {
            GlobalState.get().setSelectedLayoutOfMonitor(
                wasSnapAssistingLayout.id,
                this._monitor.index
            );
        }

        if (!tilingLayout || !canShowTilingSuggestions) return;

        // retrieve the current layout for the monitor and workspace
        // were the window was tiled
        const layout = wasEdgeTiling
            ? Settings.EDGE_TILING_MODE === EdgeTilingMode.DEFAULT
                ? new Layout(
                      [
                          new Tile({
                              x: 0,
                              y: 0,
                              height: 0.5,
                              width: 0.5,
                              groups: [],
                          }),
                          new Tile({
                              x: 0.5,
                              y: 0,
                              height: 0.5,
                              width: 0.5,
                              groups: [],
                          }),
                          new Tile({
                              x: 0,
                              y: 0.5,
                              height: 0.5,
                              width: 0.5,
                              groups: [],
                          }),
                          new Tile({
                              x: 0.5,
                              y: 0.5,
                              height: 0.5,
                              width: 0.5,
                              groups: [],
                          }),
                      ],
                      'quarters'
                  )
                : GlobalState.get().getSelectedLayoutOfMonitor(
                      this._monitor.index,
                      window.get_workspace().index()
                  )
            : wasSnapAssistingLayout
              ? wasSnapAssistingLayout
              : GlobalState.get().getSelectedLayoutOfMonitor(
                    this._monitor.index,
                    window.get_workspace().index()
                );
        this._openWindowsSuggestions(
            window,
            desiredWindowRect,
            window.get_monitor(),
            layout,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            tilingLayout.scalingFactor
        );
    }

    // any introspected method call on a disposed GObject wrapper throws in
    // GJS, which makes get_id() a safe liveness probe
    private _isWindowAlive(window: Meta.Window): boolean {
        try {
            window.get_id();
            return true;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Post-placement follow-up of a window drag: flushes any auto-fill
     * trigger stashed during the grab and, on the drag's origin monitor
     * only, schedules the fill of the tile freed by a drag-away.
     */
    private _onGrabEndFollowUp(window: Meta.Window): void {
        // liveness bail: the dragged window may have been closed mid-drag
        // (mutter ends the grab on unmanage and grab-op-end still fires;
        // __ts_cached is never deleted on unmanaged, so only a probe can
        // detect the disposed wrapper)
        if (!this._isWindowAlive(window)) {
            this._grabOrigin = null;
            this._freeTileFiller?.flushPending();
            return;
        }

        const origin = this._grabOrigin;
        this._grabOrigin = null;

        // flush in EVERY manager: a trigger stashed mid-drag on ANOTHER
        // monitor's filler must be flushed too (no-op when empty)
        this._freeTileFiller?.flushPending();

        // all managers see grab signals: only the origin's manager proceeds
        if (!origin || this._monitor.index !== origin.monitorIndex) return;

        this.enforceTiledPlacement(window, origin);
        if (
            origin.wsIndex !== undefined &&
            (window.get_monitor() !== origin.monitorIndex ||
                window.get_workspace()?.index() !== origin.wsIndex)
        )
            this.scheduleAutoFill(origin.wsIndex);
    }

    private _openWindowsSuggestions(
        window: Meta.Window,
        windowDesiredRect: Mtk.Rectangle,
        monitorIndex: number,
        layout: Layout,
        innerGaps: Clutter.Margin,
        outerGaps: Clutter.Margin,
        scalingFactor: number
    ): void {
        const tiledWindows: ExtendedWindow[] = [];
        const nontiledWindows: Meta.Window[] = [];
        getWindows().forEach(extWin => {
            if (
                extWin &&
                !extWin.minimized &&
                (extWin as ExtendedWindow).assignedTile
            )
                tiledWindows.push(extWin as ExtendedWindow);
            else nontiledWindows.push(extWin);
        });

        if (nontiledWindows.length === 0) return;

        this._tilingSuggestionsLayout.destroy();
        this._tilingSuggestionsLayout = new TilingLayoutWithSuggestions(
            innerGaps,
            outerGaps,
            this._workArea,
            scalingFactor
        );
        this._tilingSuggestionsLayout.relayout({ layout });
        /* this._tilingSuggestionsLayout.relayout({
            containerRect: this._workArea,
            innerGaps,
            outerGaps,
            layout,
        });*/
        this._tilingSuggestionsLayout.open(
            tiledWindows,
            nontiledWindows,
            window,
            windowDesiredRect,
            monitorIndex
        );
    }

    private _easeWindowRect(
        window: Meta.Window,
        destRect: Mtk.Rectangle,
        user_op: boolean = false,
        force: boolean = false
    ) {
        _windowsUnderPlacement.add(window);
        const windowActor = window.get_compositor_private() as Clutter.Actor;

        const beforeRect = window.get_frame_rect();
        // do not animate the window if it will not move or scale
        if (
            destRect.x === beforeRect.x &&
            destRect.y === beforeRect.y &&
            destRect.width === beforeRect.width &&
            destRect.height === beforeRect.height
        ) {
            _windowsUnderPlacement.delete(window);
            return;
        }

        // apply animations when tiling the window
        // never remove_all_transitions() here: it would kill the previous
        // size-change ease, whose onStopped is GNOME's only cleanup path —
        // without it the actor leaks into _resizing and later size changes
        // early-return before resetting translation/scale (stale-transform
        // displacement). Left running, the old ease completes and self-heals.
        // @ts-expect-error "Main.wm has the "private" function _prepareAnimationInfo"
        Main.wm._prepareAnimationInfo(
            global.windowManager,
            windowActor,
            beforeRect.copy(),
            Meta.SizeChange.UNMAXIMIZE
        );

        // move and resize the window to the current selection
        window.move_to_monitor(this._monitor.index);
        if (force) window.move_frame(user_op, destRect.x, destRect.y);
        window.move_resize_frame(
            user_op,
            destRect.x,
            destRect.y,
            destRect.width,
            destRect.height
        );
        _windowsUnderPlacement.delete(window);
    }

    private _onSnapAssist(_: SnapAssist, tile: Tile, layoutId: string) {
        // if there isn't a tile hovered, then close selection
        if (tile.width === 0 || tile.height === 0) {
            this._selectedTilesPreview.close(true);
            this._snapAssistingInfo.update(undefined);
            return;
        }

        // We apply the proportions to get tile size and position relative to the work area
        const scaledRect = TileUtils.apply_props(tile, this._workArea);
        // ensure the rect doesn't go horizontally beyond the workarea
        if (
            scaledRect.x + scaledRect.width >
            this._workArea.x + this._workArea.width
        ) {
            scaledRect.width -=
                scaledRect.x +
                scaledRect.width -
                this._workArea.x -
                this._workArea.width;
        }
        // ensure the rect doesn't go vertically beyond the workarea
        if (
            scaledRect.y + scaledRect.height >
            this._workArea.y + this._workArea.height
        ) {
            scaledRect.height -=
                scaledRect.y +
                scaledRect.height -
                this._workArea.y -
                this._workArea.height;
        }

        const currentWs = global.workspaceManager.get_active_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (!tilingLayout) return;

        this._selectedTilesPreview
            .get_parent()
            ?.set_child_above_sibling(this._selectedTilesPreview, null);

        this.openSelectionTilePreview(scaledRect, false, true, undefined);
        this._snapAssistingInfo.update(layoutId);
    }

    private openSelectionTilePreview(
        position: Mtk.Rectangle,
        isAboveLayout: boolean,
        ease: boolean,
        window?: Meta.Window
    ) {
        const currentWs = global.workspaceManager.get_active_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (!tilingLayout) return;

        this._selectedTilesPreview.gaps = buildTileGaps(
            position,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            this._workArea,
            this._enableScaling
                ? getScalingFactorOf(tilingLayout)[1]
                : undefined
        ).gaps;
        this._selectedTilesPreview
            .get_parent()
            ?.set_child_above_sibling(this._selectedTilesPreview, null);

        const gaps = this._selectedTilesPreview.gaps;
        if (isAboveLayout) {
            this._selectedTilesPreview.updateBorderRadius(
                gaps.top > 0,
                gaps.right > 0,
                gaps.bottom > 0,
                gaps.left > 0
            );
        } else {
            const { isTop, isRight, isBottom, isLeft } =
                isTileOnContainerBorder(
                    buildRectangle({
                        x: position.x + gaps.left,
                        y: position.y + gaps.top,
                        width: position.width - gaps.left - gaps.right,
                        height: position.height - gaps.top - gaps.bottom,
                    }),
                    this._workArea
                );
            this._selectedTilesPreview.updateBorderRadius(
                !isTop,
                !isRight,
                !isBottom,
                !isLeft
            );
        }
        if (window)
            this._selectedTilesPreview.openAbove(window, position, ease);
        else this._selectedTilesPreview.open(position, ease);
    }

    /**
     * Checks if pointer is inside the current monitor
     * @returns true if the pointer is inside the current monitor, false otherwise
     */
    private _isPointerInsideThisMonitor(window: Meta.Window): boolean {
        const [x, y] = TouchPointer.get().isTouchDeviceActive()
            ? TouchPointer.get().get_pointer(window)
            : global.get_pointer();

        const pointerMonitorIndex = global.display.get_monitor_index_for_rect(
            buildRectangle({
                x,
                y,
                width: 1,
                height: 1,
            })
        );
        return this._monitor.index === pointerMonitorIndex;
    }

    private _showEdgeTiling(
        window: Meta.Window,
        edgeTile: Mtk.Rectangle,
        pointerX: number,
        pointerY: number,
        tilingLayout: TilingLayout
    ) {
        this._selectedTilesPreview.gaps = buildTileGaps(
            edgeTile,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            this._workArea,
            this._enableScaling
                ? getScalingFactorOf(tilingLayout)[1]
                : undefined
        ).gaps;

        if (!this._selectedTilesPreview.showing) {
            const { left, right, top, bottom } =
                this._selectedTilesPreview.gaps;
            const initialRect = buildRectangle({
                x: pointerX,
                y: pointerY,
                width: left + right + 8, // width without gaps will be 8
                height: top + bottom + 8, // height without gaps will be 8
            });
            initialRect.x -= initialRect.width / 2;
            initialRect.y -= initialRect.height / 2;
            this._selectedTilesPreview.open(initialRect, false);
        }

        this.openSelectionTilePreview(edgeTile, false, true, window);
    }

    private _easeWindowRectFromTile(
        tile: Tile,
        window: Meta.Window,
        skipAnimation: boolean = false,
        targetMonitorIndex: number | undefined = undefined
    ) {
        const currentWs = window.get_workspace();
        const tilingLayout = this._workspaceTilingLayout.get(currentWs);
        if (!tilingLayout) return;

        // We apply the proportions to get tile size and position relative to the work area
        const scaledRect = TileUtils.apply_props(tile, this._workArea);
        // ensure the rect doesn't go horizontally beyond the workarea
        if (
            scaledRect.x + scaledRect.width >
            this._workArea.x + this._workArea.width
        ) {
            scaledRect.width -=
                scaledRect.x +
                scaledRect.width -
                this._workArea.x -
                this._workArea.width;
        }
        // ensure the rect doesn't go vertically beyond the workarea
        if (
            scaledRect.y + scaledRect.height >
            this._workArea.y + this._workArea.height
        ) {
            scaledRect.height -=
                scaledRect.y +
                scaledRect.height -
                this._workArea.y -
                this._workArea.height;
        }

        const gaps = buildTileGaps(
            scaledRect,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            this._workArea,
            this._enableScaling
                ? getScalingFactorOf(tilingLayout)[1]
                : undefined
        ).gaps;

        const destinationRect = buildRectangle({
            x: scaledRect.x + gaps.left,
            y: scaledRect.y + gaps.top,
            width: scaledRect.width - gaps.left - gaps.right,
            height: scaledRect.height - gaps.top - gaps.bottom,
        });

        // abort if there is an invalid selection
        if (destinationRect.width <= 0 || destinationRect.height <= 0) return;

        const isMaximized =
            window.maximizedHorizontally || window.maximizedVertically;
        const rememberOriginalSize = !isMaximized;
        if (isMaximized) unmaximizeWindow(window);

        if (rememberOriginalSize && !(window as ExtendedWindow).assignedTile) {
            (window as ExtendedWindow).originalSize = window
                .get_frame_rect()
                .copy();
        }
        (window as ExtendedWindow).assignedTile = TileUtils.build_tile(
            buildRectangle({
                x: scaledRect.x,
                y: scaledRect.y,
                width: scaledRect.width,
                height: scaledRect.height,
            }),
            this._workArea
        );
        if (skipAnimation) {
            _windowsUnderPlacement.add(window);
            // on Wayland, target-monitor coordinates alone do not migrate a
            // window: the explicit move is mandatory before resizing
            if (
                targetMonitorIndex !== undefined &&
                window.get_monitor() !== targetMonitorIndex
            )
                window.move_to_monitor(targetMonitorIndex);
            window.move_resize_frame(
                false,
                destinationRect.x,
                destinationRect.y,
                destinationRect.width,
                destinationRect.height
            );
            _windowsUnderPlacement.delete(window);
        } else {
            this._easeWindowRect(window, destinationRect);
        }
    }

    public onTileFromWindowMenu(tile: Tile, window: Meta.Window) {
        this._easeWindowRectFromTile(tile, window);
    }

    public autoTileWindowToTile(tile: Tile, window: Meta.Window): void {
        this._easeWindowRectFromTile(tile, window, true, this._monitor.index);
    }

    /**
     * Fill contexts of every managed monitor, resolved LIVE on each pass
     * (monitors and their managers come and go). Each planned move is
     * applied through the DESTINATION monitor's own manager, so its work
     * area, gaps and move_to_monitor migration are the right ones.
     * Private members of sibling instances are read on purpose: the fill
     * cascade is a cross-monitor concern.
     */
    private _freeFillMonitorContexts(): FreeTileFillerMonitorContext[] {
        const contexts: FreeTileFillerMonitorContext[] = [];
        Main.layoutManager.monitors.forEach((_monitor, index) => {
            const manager =
                index === this._monitor.index
                    ? this
                    : this._getTilingManager?.(index);
            if (!manager) return;
            contexts.push({
                monitorIndex: index,
                getWorkArea: () => manager._workArea,
                ensureTilingLayout: ws => manager._ensureTilingLayout(ws),
                tileWindow: (tile, window) =>
                    manager.autoTileWindowToTile(tile, window),
                isInteracting: () => manager._isGrabbingWindow,
            });
        });
        return contexts;
    }

    public scheduleAutoFill(wsIndex: number, exclude?: Meta.Window): void {
        // insertion-shift contract: an in-flight insert-after-focused plan
        // transiently frees slots (the insertion slot plus every seat a
        // shifted window is about to leave); reacting to them would pull
        // windows into seats that are about to be taken
        if (isInsertionShiftInProgress()) {
            this._debug(
                'auto-fill deferred: insert-after-focused shift in flight'
            );
            return;
        }
        this._freeTileFiller?.scheduleFill(wsIndex, exclude);
    }

    /**
     * Tile-lock enforcement: while the freed-tile auto-fill feature is
     * on, a tiled window that a drag (or a native workspace/monitor
     * move) pulled off its tile is pushed back to its origin tile.
     * Maximized windows and drops still conforming to a tile are left
     * alone; the whole revert runs under auto-fill suppression so it
     * never fights the filler's own moves.
     */
    public enforceTiledPlacement(
        window: Meta.Window,
        origin: GrabOrigin,
        opts?: EnforceTiledPlacementOptions
    ): void {
        // dying-window guards, before everything else (even the suppression
        // check, so re-entrances on dying windows are cheaply dropped): an
        // unmanaging window has its workspace torn to null and its monitor
        // torn to -1 while the GObject wrapper is still alive — get_id()
        // only throws AFTER 'unmanaged'. A LIVE tiled window always has
        // both a workspace and a valid monitor; window-management calls on
        // a not-settled window abort the whole compositor.
        if (!this._isWindowAlive(window)) return;
        if (!window.get_workspace()) return;
        const monitorIdx = window.get_monitor();
        if (monitorIdx < 0 || monitorIdx >= global.display.get_n_monitors())
            return;

        // MANDATORY FIRST: the filler's own change_workspace/move_to_monitor
        // calls re-enter the monitor-left/workspace-changed wires while the
        // suppression depth is positive; without this gate the enforcement
        // would revert exactly the moves the cascade is allowed to make
        if (isAutoFillSuppressed()) return;
        // insertion-shift contract (same gate as scheduleAutoFill): the
        // shifted windows fire workspace-changed/monitor-left synchronously
        // while the plan executes; reverting them would tear the shift apart
        if (isInsertionShiftInProgress()) return;
        if (!Settings.ENABLE_AUTO_FILL_FREED_TILES) return;
        if (!origin.tiled) return;
        if (!origin.tile) return;
        if (origin.window !== window) return;

        // maximize via top-edge drag stays allowed (existing feature)
        if (window.maximizedHorizontally || window.maximizedVertically) return;

        const extWin = window as ExtendedWindow;
        // legit test: the drop still conforms to a tile — the current
        // assignedTile if the drop re-tiled it (a spanned drop selection's
        // union tile passes the 50% test), else the drag's origin tile
        // (in-tile nudges keep passing; free-form drops fail). The
        // ignoreGeometry bypass (wire 2) matches the plan: that path is
        // geometry-blind to workspace-only moves
        if (!opts?.ignoreGeometry) {
            const referenceTile = extWin.assignedTile ?? origin.tile;
            const normalizedFrameRect = TileUtils.build_tile(
                window.get_frame_rect(),
                Main.layoutManager.getWorkAreaForMonitor(monitorIdx)
            );
            if (rectMostlyInsideTile(normalizedFrameRect, referenceTile))
                return;
        }

        this._debug('enforcing tiled placement: reverting window to origin');

        const originTile: Tile = origin.tile;
        const originMonitorIndex = origin.monitorIndex;
        const originWs = origin.ws;
        const originWsIndex = origin.wsIndex;

        withAutoFillSuppressed(() => {
            // the monitor/workspace moves below synchronously re-enter
            // onWindowEnteredMonitor once the grab has ended: the guard
            // keeps our own placement from clearing assignedTile and
            // re-tiling to a foreign tile
            _windowsUnderPlacement.add(window);
            try {
                if (window.get_monitor() !== originMonitorIndex)
                    window.move_to_monitor(originMonitorIndex);

                // resolve the target workspace BY OBJECT: a stale index can
                // resolve to a live-but-different workspace, and index() on
                // a disposed wrapper throws before === even evaluates
                const wsIndexOf = (candidate: Meta.Workspace): number => {
                    try {
                        return candidate.index();
                    } catch (_e) {
                        return -1;
                    }
                };
                let ws: Meta.Workspace | null = null;
                if (originWs !== undefined) {
                    ws =
                        global.workspaceManager.get_workspace_by_index(
                            wsIndexOf(originWs)
                        ) === originWs
                            ? originWs
                            : null;
                } else if (originWsIndex !== undefined) {
                    ws =
                        global.workspaceManager.get_workspace_by_index(
                            originWsIndex
                        );
                }

                if (!ws) {
                    // the origin workspace vanished (dynamic collapse):
                    // re-seat on the window's current workspace
                    console.warn(
                        'AutoTile: origin workspace of enforced window vanished, re-seating on the current one'
                    );
                    const tile = this._findEmptyTile(
                        window,
                        originMonitorIndex,
                        window.get_workspace().index()
                    );
                    if (tile) {
                        const originalSize = extWin.originalSize;
                        this.autoTileWindowToTile(tile, window);
                        if (originalSize) extWin.originalSize = originalSize;
                    }
                    return;
                }

                if (window.get_workspace() !== ws) {
                    this._ensureTilingLayout(ws);
                    window.change_workspace(ws);
                }

                // re-tile to the origin tile, preserving the TRUE pre-tile
                // size for a future untile (same snapshot pattern as
                // onWindowEnteredMonitor)
                const originalSize = extWin.originalSize;
                this.autoTileWindowToTile(new Tile({ ...originTile }), window);
                if (originalSize) extWin.originalSize = originalSize;
            } finally {
                _windowsUnderPlacement.delete(window);
            }
        });
    }

    /**
     * Re-tile a window that just entered this monitor through a NON
     * AutoTile path (e.g. GNOME's built-in "move window one monitor
     * up/down" shortcuts). Only already-tiled windows are handled: they keep
     * being tiled on the destination monitor, per the destination layout.
     */
    public onWindowEnteredMonitor(window: Meta.Window): void {
        if (window.get_monitor() !== this._monitor.index) return;
        if (_windowsUnderPlacement.has(window)) return; // our own placement
        if (this._isGrabbingWindow) return; // user is dragging windows
        if (
            window.windowType !== Meta.WindowType.NORMAL ||
            window.get_transient_for() !== null ||
            window.is_attached_dialog() ||
            window.minimized ||
            window.maximizedHorizontally ||
            window.maximizedVertically ||
            window.is_fullscreen()
        )
            return;

        const extWin = window as ExtendedWindow;
        if (!extWin.assignedTile) return; // floating windows keep GNOME's behavior

        // detach from the old tile first so the window's own current rect does
        // not count as an occupier when searching the destination layout
        // (same pattern as _autoTile) ...
        extWin.assignedTile = undefined;

        const ws = window.get_workspace();
        const tile = this._findEmptyTile(
            window,
            this._monitor.index,
            ws ? ws.index() : 0
        );
        if (!tile) return; // destination full: leave it floating (consistent with the all-full design)

        this._debug(
            `window entered monitor ${this._monitor.index}: re-tiling per destination layout`
        );
        // ... but remember the TRUE original size for a future untile:
        // _easeWindowRectFromTile overwrites originalSize when assignedTile is
        // unset, and we just cleared it
        const originalSize = extWin.originalSize;
        this.autoTileWindowToTile(tile, window);
        if (originalSize) extWin.originalSize = originalSize;
    }

    public onSpanAllTiles(window: Meta.Window) {
        this._easeWindowRectFromTile(
            new Tile({
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                groups: [],
            }),
            window
        );
    }

    private _autoTile(window: Meta.Window, windowCreated: boolean) {
        // do not handle windows in monitors not managed by this manager
        if (window.get_monitor() !== this._monitor.index) return;

        if (
            window === null ||
            window.windowType !== Meta.WindowType.NORMAL ||
            window.get_transient_for() !== null ||
            window.is_attached_dialog() ||
            window.minimized ||
            window.maximizedHorizontally ||
            window.maximizedVertically
        )
            return;

        (window as ExtendedWindow).assignedTile = undefined;

        // unmaximize never crosses monitors
        if (!windowCreated) {
            const vacantTile = this._findEmptyTile(window);
            if (!vacantTile) return;
            this._easeWindowRectFromTile(vacantTile, window, true);
            return;
        }

        // capture the pre-creation focus anchor synchronously: at
        // window-created time the new window is neither mapped nor
        // focused, so the focused window is normally the previously
        // focused one. When the focus is unreportable (undefined or the
        // new window itself — Wayland timing), scan the MRU list of the
        // birth workspace for the first eligible tiled anchor. A
        // REPORTED focus is never replaced by that scan — it is the
        // authoritative signal of user intent, so when it fails
        // eligibility the path stays no-anchor.
        let anchorCandidate: Meta.Window | undefined =
            global.display.get_focus_window() ?? undefined;
        let anchorSource: 'focus' | 'mru-scan' | 'none';
        if (anchorCandidate !== undefined && anchorCandidate !== window) {
            anchorSource = 'focus';
        } else {
            anchorSource = 'none';
            anchorCandidate = getWindows(window.get_workspace()).find(
                win =>
                    win !== window &&
                    this._isEligibleInsertionAnchor(win, window)
            );
            if (anchorCandidate !== undefined) anchorSource = 'mru-scan';
        }
        this._debug(`insertion: anchor source=${anchorSource}`);

        // the create -> first-frame gap can be long (delayed-mapping apps
        // are not rare): property access on a released Meta.Window throws
        // in GJS, so clear the candidate as soon as the anchor dies. The
        // new window's own hook releases the anchor hook when the new
        // window is destroyed before its first frame (signal-leak guard).
        const anchorUnmanagedId =
            anchorCandidate !== undefined
                ? anchorCandidate.connect('unmanaged', () => {
                      anchorCandidate = undefined;
                  })
                : 0;
        const newWindowUnmanagedId = window.connect('unmanaged', () => {
            if (anchorCandidate !== undefined && anchorUnmanagedId !== 0)
                anchorCandidate.disconnect(anchorUnmanagedId);
        });

        const windowActor = window.get_compositor_private() as Meta.WindowActor;
        const id = windowActor.connect('first-frame', () => {
            windowActor.disconnect(id);

            // release BOTH unmanaged hooks on every exit path of this
            // callback, the early returns included: the disconnection must
            // never depend on reaching the insertion block below
            try {
                // the window state may have changed since its creation
                if (
                    window.minimized ||
                    window.maximizedHorizontally ||
                    window.maximizedVertically ||
                    window.get_transient_for() !== null ||
                    window.is_attached_dialog()
                )
                    return;

                // ghost-window immunity — wl-clipboard maps 0×0→1×1 for
                // ~12ms; keep such windows floating (measured 2026-09-05)
                const frame = window.get_frame_rect();
                if (
                    !shouldAutoTileWindow({
                        wmClass: window.get_wm_class(),
                        frameWidth: frame.width,
                        frameHeight: frame.height,
                    })
                )
                    return;

                // insert-after-focused: anchor eligibility is decided
                // here. The capture-time scan guarantees an mru-scan
                // anchor is eligible, so only a reported focus can
                // fail — and a failed focus is the authoritative
                // no-anchor signal (never re-scanned). Every insertion
                // outcome is terminal: a direct placement, an
                // idle-registered plan, or an abort that deliberately
                // leaves the window floating — no search ever follows
                // it. A false return means the anchor came apart in
                // the create -> first-frame gap: the window falls
                // through to the no-anchor first-vacancy path below.
                if (this._isEligibleInsertionAnchor(anchorCandidate, window)) {
                    if (this._runInsertionAfterFocused(window, anchorCandidate))
                        return;
                } else {
                    this._debug('insertion: no anchor, default behavior');
                }

                // no anchor: the first free slot in strict reading order
                // from the birth workspace's slot 0 (across the monitors
                // in row order) — never a nearest-to-center or
                // ring-wrapping search
                this._runFirstVacancyPlacement(window);
            } finally {
                if (anchorCandidate !== undefined && anchorUnmanagedId !== 0)
                    anchorCandidate.disconnect(anchorUnmanagedId);
                window.disconnect(newWindowUnmanagedId);
            }
        });
    }

    // Anchor eligibility for insert-after-focused. Every condition mirrors
    // the default-path eligibility checks: a minimized/maximized/fullscreen/
    // sticky/dialog anchor holds no meaningful tile slot, and an anchor on
    // another workspace would break the same-workspace insertion premise.
    private _isEligibleInsertionAnchor(
        anchor: Meta.Window | undefined,
        window: Meta.Window
    ): anchor is Meta.Window {
        if (anchor === undefined || anchor === window) return false;
        if (anchor.windowType !== Meta.WindowType.NORMAL) return false;
        if (anchor.get_transient_for() !== null) return false;
        if (anchor.is_attached_dialog()) return false;
        if (anchor.minimized) return false;
        if (anchor.maximizedHorizontally || anchor.maximizedVertically)
            return false;
        if (anchor.is_fullscreen()) return false;
        if (anchor.is_on_all_workspaces()) return false;
        if ((anchor as ExtendedWindow).assignedTile === undefined) return false;
        if (anchor.get_workspace().index() !== window.get_workspace().index())
            return false;
        return true;
    }

    // The manager of an insertion slot's OWN monitor. NEVER falls back to
    // `this` for a foreign monitor: a wrong manager's work area and monitor
    // index would produce wrong geometry and drag windows onto the wrong
    // monitor.
    private _getInsertionTargetManager(
        monitorIndex: number
    ): TilingManager | undefined {
        if (monitorIndex === this._monitor.index) return this;
        return this._getTilingManager?.(monitorIndex);
    }

    // Slot occupancy truth for the insertion re-checks: the very same
    // conditions as the tiled-window-rects query backing the vacancy
    // searches.
    private _isInsertionSlotOccupied(
        ws: Meta.Workspace,
        tileRect: Mtk.Rectangle
    ): boolean {
        return this._getTiledWindowRects(ws).some(rect =>
            tileRect.overlap(rect)
        );
    }

    // Hard precondition for non-activating cross-workspace placements:
    // _easeWindowRectFromTile silently returns when this manager holds no
    // TilingLayout entry for the window's workspace, and entries are
    // otherwise only created at manager construction and on
    // active-workspace-changed — a never-activated workspace (e.g. the
    // trailing empty one under dynamic workspaces) has no entry anywhere,
    // so a cross-workspace leg onto it would silently no-op. Mirrors the
    // active-workspace-changed handler body exactly.
    private _ensureWorkspaceTilingLayout(ws: Meta.Workspace): void {
        if (this._workspaceTilingLayout.has(ws)) return;

        const monitorScalingFactor = this._enableScaling
            ? getMonitorScalingFactor(this._monitor.index)
            : undefined;
        const layout: Layout = GlobalState.get().getSelectedLayoutOfMonitor(
            this._monitor.index,
            ws.index()
        );
        const innerGaps = buildMargin(Settings.get_inner_gaps());
        const outerGaps = buildMargin(Settings.get_outer_gaps());

        this._debug('created new tiling layout for workspace');
        this._workspaceTilingLayout.set(
            ws,
            new TilingLayout(
                layout,
                innerGaps,
                outerGaps,
                this._workArea,
                monitorScalingFactor
            )
        );
    }

    // Every bit of shell access the pure insertion planner needs is
    // injected here, shared by the anchor insertion path and the
    // no-anchor first-vacancy path. Chains are built lazily and at
    // most once per workspace.
    private _buildChainInputs(): {
        inputs: ChainInputs;
        getChain: (wsIndex: number) => ChainSlot[];
    } {
        const inputs: ChainInputs = {
            monitorsInRowOrder: this._getMonitorsInRowOrder(),
            getWorkAreaForMonitor: (m: number) =>
                Main.layoutManager.getWorkAreaForMonitor(m),
            getTilesForMonitor: (m: number, ws: number) =>
                GlobalState.get().getSelectedLayoutOfMonitor(m, ws).tiles,
            getWindows: (ws: Meta.Workspace) => getWindows(ws),
            rectFromTile: (tile: Tile, container: Mtk.Rectangle) =>
                TileUtils.apply_props(tile, container),
        };
        const chainCache = new Map<number, ChainSlot[]>();
        const getChain = (wsIndex: number): ChainSlot[] => {
            const cached = chainCache.get(wsIndex);
            if (cached) return cached;
            const chain = buildWorkspaceChain(wsIndex, inputs);
            chainCache.set(wsIndex, chain);
            return chain;
        };
        return { inputs, getChain };
    }

    // Insert-after-focused: validate the captured anchor, plan through the
    // pure insertion planner and dispatch the result. Returns true when
    // the insertion path fully handled the window — direct placement
    // done, an idle plan registered, or a terminal abort that
    // deliberately leaves the window floating (mutex deferral and every
    // planner fallback included). Returns false only when the anchor is
    // not established (ineligible or dead candidate): the caller then
    // routes the window to the no-anchor first-vacancy path.
    private _runInsertionAfterFocused(
        window: Meta.Window,
        anchorCandidate: Meta.Window | undefined
    ): boolean {
        if (!this._isEligibleInsertionAnchor(anchorCandidate, window)) {
            this._debug('insertion: no anchor, default behavior');
            return false;
        }
        const anchor = anchorCandidate;

        // mutex: a plan already sits in the first-frame -> idle gap, so the
        // occupancy truth is stale; a second plan would double-move the
        // same occupants and stack windows on the same slots. Deferred to
        // a terminal float: no search may follow the insertion attempt,
        // so the deferred window simply keeps its floating position
        if (_insertionShiftInProgress) {
            this._debug('insertion: deferred, another insertion in flight');
            return true;
        }

        // every bit of shell access the pure planner needs is injected
        const { inputs: chainInputs, getChain } = this._buildChainInputs();

        const result = planInsertion(anchor, {
            allowCrossWorkspace: Settings.ENABLE_AUTO_TILING_OTHER_WORKSPACES,
            allowAppend:
                Settings.ENABLE_AUTO_TILING_OTHER_WORKSPACES &&
                Meta.prefs_get_dynamic_workspaces(),
            getChain,
            nWorkspaces: global.workspaceManager.get_n_workspaces(),
            inputs: chainInputs,
            getWorkspaceByIndex: (i: number) =>
                global.workspaceManager.get_workspace_by_index(i),
        });

        if ('fallback' in result) {
            // terminal: no search may follow the insertion attempt, so a
            // planner fallback leaves the new window floating — the
            // physical-limit end state (e.g. an immovable sticky or
            // fullscreen tiled occupant inside the shift range)
            switch (result.fallback) {
                case 'no-vacancy':
                    this._debug('insertion: fallback, no vacancy available');
                    break;
                case 'immovable-occupant':
                    this._debug('insertion: fallback, immovable occupant');
                    break;
                case 'anchor-unmapped':
                    this._debug('insertion: no anchor, default behavior');
                    break;
            }
            return true;
        }
        const plan = result;

        const anchorWs = anchor.get_workspace().index();
        const anchorChain = getChain(anchorWs);
        // the anchor's last occupied slot: when the new window target is
        // on the anchor's workspace it sits exactly one slot behind the
        // anchor's end slot; a target on another workspace means the
        // anchor sits on the chain tail
        const anchorSlotIndex =
            plan.newWindowTarget.wsIndex === anchorWs
                ? plan.newWindowTarget.slot.slotIndex - 1
                : anchorChain.length - 1;
        this._debug(`insertion: anchor ws=${anchorWs} slot=${anchorSlotIndex}`);

        // FORM ONE — zero-move direct placement: the only insertion shape
        // allowed to run synchronously inside the first-frame emission
        // (same precedent as the no-anchor birth-workspace placement in
        // _runFirstVacancyPlacement)
        if (
            plan.moves.length === 0 &&
            !plan.switchView &&
            !plan.appendWorkspace
        ) {
            _insertionShiftInProgress = true;
            try {
                const manager = this._getInsertionTargetManager(
                    plan.newWindowTarget.slot.monitorIndex
                );
                if (!manager) {
                    this._debug(
                        'insertion: fallback, monitor manager unavailable'
                    );
                    return true; // handled: the window stays floating
                }
                manager.autoTileWindowToTile(
                    plan.newWindowTarget.slot.tile,
                    window
                );
                this._debug(
                    `insertion: direct placement ws=${plan.newWindowTarget.wsIndex} slot=${plan.newWindowTarget.slot.slotIndex} moves=0`
                );
            } finally {
                _insertionShiftInProgress = false;
            }
            return true;
        }

        // FORM TWO — every other plan (any move, a workspace append, a
        // view switch): only eligibility and planning happen here; the
        // WHOLE plan executes in a one-shot idle callback, because moving
        // windows or switching workspaces inside the first-frame emission
        // crashes the compositor (same rule as the cross-workspace leg in
        // _runFirstVacancyPlacement)
        const absorbTarget =
            plan.moves.length > 0
                ? plan.moves[0].target // largest target key: exactly E
                : plan.newWindowTarget;
        this._debug(
            `insertion: shifting ${plan.moves.length} windows, absorb at ws=${absorbTarget.wsIndex} slot=${absorbTarget.slot.slotIndex}`
        );
        _insertionShiftInProgress = true;
        const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._executeInsertionPlan(window, plan, anchorWs);
                return GLib.SOURCE_REMOVE;
            } finally {
                _insertionShiftInProgress = false;
                this._pendingMainloopSources.delete(idleId);
            }
        });
        this._pendingMainloopSources.add(idleId);
        return true;
    }

    // No-anchor path for a new window: the FIRST free slot in strict
    // reading order — the birth workspace's chain from slot 0 across
    // the monitors in row order, then (only when the other-workspaces
    // preference allows it) strictly forward through the later
    // workspaces, and finally slot 0 of a workspace to be appended
    // when dynamic workspaces also allow it. No vacancy anywhere: the
    // window stays floating (terminal).
    private _runFirstVacancyPlacement(window: Meta.Window): void {
        const fromWs = window.get_workspace().index();
        const { inputs, getChain } = this._buildChainInputs();
        const vacancy = findFirstVacancy({
            fromWs,
            nWorkspaces: global.workspaceManager.get_n_workspaces(),
            allowCrossWorkspace: Settings.ENABLE_AUTO_TILING_OTHER_WORKSPACES,
            allowAppend:
                Settings.ENABLE_AUTO_TILING_OTHER_WORKSPACES &&
                Meta.prefs_get_dynamic_workspaces(),
            getChain,
            inputs,
            getWorkspaceByIndex: (i: number) =>
                global.workspaceManager.get_workspace_by_index(i),
        });

        if (vacancy === null) {
            this._debug('insertion: no-anchor no vacancy, leaving floating');
            return;
        }

        if (vacancy.wsIndex === fromWs) {
            // birth-workspace hit: pure placement, the only shape allowed
            // to run synchronously inside the first-frame emission (same
            // precedent as the zero-move FORM ONE placement above)
            const manager = this._getInsertionTargetManager(
                vacancy.slot.monitorIndex
            );
            if (!manager) {
                this._debug('insertion: fallback, monitor manager unavailable');
                return; // terminal: the window stays floating
            }
            // suppressed: on a cross-monitor hit,
            // _easeWindowRectFromTile assigns the tile BEFORE
            // move_to_monitor, so the monitor-left wire would otherwise
            // see a transient "tiled window off its tile" and revert our
            // own placement (same hazard as _placeWindowOnWorkspace)
            withAutoFillSuppressed(() => {
                manager.autoTileWindowToTile(vacancy.slot.tile, window);
            });
            this._debug(
                `insertion: no-anchor first vacancy ws=${vacancy.wsIndex} slot=${vacancy.slot.slotIndex}`
            );
            return;
        }

        // cross-workspace / append hit: the overflow placement must not
        // run inside the first-frame emission — switching workspaces and
        // moving the window while mutter's frame is still in progress
        // aborts the compositor. Run it from the main loop once the
        // current frame is done.
        const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                // the window state may have changed since the first frame
                if (
                    window.minimized ||
                    window.maximizedHorizontally ||
                    window.maximizedVertically ||
                    window.get_transient_for() !== null ||
                    window.is_attached_dialog()
                )
                    return GLib.SOURCE_REMOVE;

                if (!Settings.ENABLE_AUTO_TILING_OTHER_WORKSPACES)
                    return GLib.SOURCE_REMOVE;
                if (window.is_on_all_workspaces()) return GLib.SOURCE_REMOVE; // sticky windows just float

                // an append hit references a workspace that does not exist
                // yet: create it without activating it (activate=false
                // fires no active-workspace-changed; the activation inside
                // _placeWindowOnWorkspace creates the tiling layouts the
                // placement depends on)
                const ws = vacancy.appendWorkspace
                    ? global.workspaceManager.append_new_workspace(
                          false,
                          global.get_current_time()
                      )
                    : global.workspaceManager.get_workspace_by_index(
                          vacancy.wsIndex
                      );
                if (ws === null) {
                    this._debug(
                        'insertion: no-anchor aborted, workspace vanished'
                    );
                    return GLib.SOURCE_REMOVE;
                }

                // the target slot must still be free: a concurrent placement
                // may have filled it in the first-frame -> idle gap (an
                // appended workspace is empty by construction)
                if (
                    !vacancy.appendWorkspace &&
                    this._isInsertionSlotOccupied(ws, vacancy.slot.tileRect)
                ) {
                    this._debug(
                        'insertion: no-anchor aborted, target occupied'
                    );
                    return GLib.SOURCE_REMOVE;
                }

                this._debug(
                    `insertion: no-anchor forward cross-ws ws=${ws.index()} slot=${vacancy.slot.slotIndex}`
                );
                this._placeWindowOnWorkspace(window, {
                    ws,
                    monitorIndex: vacancy.slot.monitorIndex,
                    tile: vacancy.slot.tile,
                });
                return GLib.SOURCE_REMOVE;
            } finally {
                this._pendingMainloopSources.delete(idleId);
            }
        });
        this._pendingMainloopSources.add(idleId);
    }

    // Executes a FORM TWO plan inside its idle callback: every move plus
    // the new-window placement, with fresh-state re-checks first (the plan
    // was computed inside the first-frame handler; the world may have
    // changed in the gap). Any failed re-check aborts the whole plan and
    // leaves the new window floating: the default searches were
    // short-circuited, and a partially executed plan would stack windows
    // on occupied slots. A single failed move occupant aborts too — NEVER
    // skip-and-continue: a skipped occupant would stay wedged between the
    // insertion slot and the absorb vacancy.
    private _executeInsertionPlan(
        window: Meta.Window,
        plan: InsertionPlan,
        anchorWs: number
    ): void {
        if (
            window.get_compositor_private() === null || // destroyed: property access would throw
            window.minimized ||
            window.maximizedHorizontally ||
            window.maximizedVertically ||
            window.get_transient_for() !== null ||
            window.is_attached_dialog()
        ) {
            this._debug('insertion: aborted, window state changed');
            return;
        }

        // dynamic append: create the plan's target workspace WITHOUT
        // activating it (activate=false fires no
        // active-workspace-changed, so no manager gains a layout entry
        // implicitly) and hand every monitor's manager its entry for the
        // new workspace before any leg references it (see
        // _ensureWorkspaceTilingLayout)
        if (plan.appendWorkspace) {
            const ws = global.workspaceManager.append_new_workspace(
                false,
                global.get_current_time()
            );
            for (const monitorIndex of this._getMonitorsInRowOrder()) {
                this._getInsertionTargetManager(
                    monitorIndex
                )?._ensureWorkspaceTilingLayout(ws);
            }
        }

        // every workspace the plan refers to must still exist: dynamic
        // workspaces can recycle trailing empty ones in the gap. The
        // append case created its target workspace just above.
        const referencedWsIndices = new Set<number>();
        for (const move of plan.moves)
            referencedWsIndices.add(move.target.wsIndex);
        referencedWsIndices.add(plan.newWindowTarget.wsIndex);
        for (const wsIndex of referencedWsIndices) {
            if (
                global.workspaceManager.get_workspace_by_index(wsIndex) === null
            ) {
                this._debug('insertion: aborted, workspace vanished');
                return;
            }
        }

        // the absorb slot must still be free: a concurrent default-path
        // placement may have filled it in the gap, and the tail move would
        // then stack its occupant on top
        const absorbTarget =
            plan.moves.length > 0 ? plan.moves[0].target : plan.newWindowTarget;
        if (!plan.appendWorkspace) {
            const absorbWs = global.workspaceManager.get_workspace_by_index(
                absorbTarget.wsIndex
            );
            if (
                absorbWs !== null &&
                this._isInsertionSlotOccupied(
                    absorbWs,
                    absorbTarget.slot.tileRect
                )
            ) {
                this._debug('insertion: aborted, target occupied');
                return;
            }
        }

        for (const move of plan.moves) {
            const win = move.window;
            if (
                win.get_compositor_private() === null ||
                win.minimized ||
                win.maximizedHorizontally ||
                win.maximizedVertically
            ) {
                this._debug('insertion: aborted, occupant vanished');
                return;
            }
            // INTENTIONAL forward-only semantics: an insertion cascade
            // only ever moves FORWARD — workspace indices monotonically
            // non-decreasing from the anchor, never wrapping around the
            // workspace ring (the no-anchor first-vacancy search below
            // the insertion attempt follows the same rule). A target
            // behind the anchor workspace means the planner regressed
            // to ring semantics: abort the whole plan like the other
            // re-check failures (skip-and-continue would leave an
            // unshifted occupant wedged between the insertion slot and
            // the absorb vacancy).
            if (move.target.wsIndex < anchorWs) {
                this._debug('insertion: skip invalid cross-ws move');
                return;
            }
            const manager = this._getInsertionTargetManager(
                move.target.slot.monitorIndex
            );
            if (!manager) {
                this._debug('insertion: fallback, monitor manager unavailable');
                return;
            }
            if (win.get_workspace().index() !== move.target.wsIndex) {
                const targetWs = global.workspaceManager.get_workspace_by_index(
                    move.target.wsIndex
                );
                if (targetWs === null) {
                    this._debug('insertion: aborted, workspace vanished');
                    return;
                }
                // the placement below runs through the TARGET monitor's
                // manager, whose layout map has no entry for a
                // never-activated workspace (hard precondition, see
                // _ensureWorkspaceTilingLayout)
                manager._ensureWorkspaceTilingLayout(targetWs);
                win.change_workspace(targetWs);
                this._debug(
                    `insertion: overflow window -> ws=${move.target.wsIndex}`
                );
            }
            const preMoveMonitor = win.get_monitor();
            manager.autoTileWindowToTile(move.target.tile, win);

            // geometry verification only: a FAIL never rolls back, it must
            // merely be logged (pre-execution failures use the abort lines
            // above and never reach this). A same-monitor move_resize_frame
            // is reflected by get_frame_rect() synchronously; a
            // cross-monitor one is not — move_to_monitor() flips
            // get_monitor() at once, but the frame rect only lands after
            // the client acks the reconfigure, so an immediate read sees
            // the half-applied rect and would log a false FAIL. Those legs
            // are audited after the settle instead.
            if (preMoveMonitor === move.target.slot.monitorIndex) {
                const movedOk = win
                    .get_frame_rect()
                    .overlap(move.target.slot.tileRect);
                this._debug(
                    `insertion: move ${movedOk ? 'ok' : 'FAIL'} ws=${move.target.wsIndex} slot=${move.target.slot.slotIndex}`
                );
            } else {
                this._auditInsertionMoveLater(
                    win,
                    move.target.wsIndex,
                    move.target.slot.slotIndex,
                    move.target.slot.tileRect
                );
            }
        }

        // final leg: the new window itself. For an append plan the target
        // workspace was created at the top of this callback, so the
        // lookup below finds it; every manager already holds its layout
        // entry from the same block.
        const newTargetWs = global.workspaceManager.get_workspace_by_index(
            plan.newWindowTarget.wsIndex
        );
        if (newTargetWs === null) {
            this._debug('insertion: aborted, workspace vanished');
            return;
        }
        // its target slot must still be free too: another new window may
        // have taken it through the default path in the gap
        if (
            this._isInsertionSlotOccupied(
                newTargetWs,
                plan.newWindowTarget.slot.tileRect
            )
        ) {
            this._debug('insertion: aborted, target occupied');
            return;
        }
        if (window.get_workspace().index() !== plan.newWindowTarget.wsIndex)
            window.change_workspace(newTargetWs);
        if (plan.switchView) {
            // mirrors _placeWindowOnWorkspace: the activation also
            // synchronously creates the target workspace's tiling layouts,
            // which the placement below depends on
            this._debug(
                `insertion: view switch to ws=${plan.newWindowTarget.wsIndex}`
            );
            newTargetWs.activate_with_focus(window, global.get_current_time());
        }
        const newManager = this._getInsertionTargetManager(
            plan.newWindowTarget.slot.monitorIndex
        );
        if (!newManager) {
            this._debug('insertion: fallback, monitor manager unavailable');
            return;
        }
        newManager.autoTileWindowToTile(plan.newWindowTarget.slot.tile, window);
    }

    // Deferred geometry audit for cross-monitor move legs: the frame rect
    // only settles after the client acks the reconfigure, so the check is
    // retried a bounded number of times before a FAIL is declared.
    private _auditInsertionMoveLater(
        window: Meta.Window,
        wsIndex: number,
        slotIndex: number,
        tileRect: Mtk.Rectangle,
        attempt: number = 1
    ): void {
        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250 * attempt,
            () => {
                try {
                    if (window.get_compositor_private() === null)
                        return GLib.SOURCE_REMOVE; // unmanaged meanwhile: nothing to audit
                    const movedOk = window.get_frame_rect().overlap(tileRect);
                    if (!movedOk && attempt < 3) {
                        this._auditInsertionMoveLater(
                            window,
                            wsIndex,
                            slotIndex,
                            tileRect,
                            attempt + 1
                        );
                        return GLib.SOURCE_REMOVE;
                    }
                    this._debug(
                        `insertion: move ${movedOk ? 'ok' : 'FAIL'} ws=${wsIndex} slot=${slotIndex}`
                    );
                    return GLib.SOURCE_REMOVE;
                } finally {
                    this._pendingMainloopSources.delete(timeoutId);
                }
            }
        );
        this._pendingMainloopSources.add(timeoutId);
    }

    // frame rects of tiled windows (assigned tile, not minimized, not
    // maximized) — the single source of truth for tile occupancy.
    // Without a workspace this scans the ACTIVE workspace (matches the
    // historical getWindows() default used by _findEmptyTile).
    private _getTiledWindowRects(
        workspace: Meta.Workspace | undefined = undefined
    ): Mtk.Rectangle[] {
        return getWindows(workspace)
            .filter(
                window =>
                    window &&
                    (window as ExtendedWindow).assignedTile &&
                    !window.minimized &&
                    !window.maximizedVertically &&
                    !window.maximizedHorizontally
            )
            .map(window => window.get_frame_rect());
    }

    private _findSwapTargetOnTile(
        tile: Tile,
        workspace: Meta.Workspace | undefined,
        exclude: Meta.Window
    ): Meta.Window | undefined {
        // occupancy truth MUST match _getTiledWindowRects: assignedTile set,
        // not minimized, not maximized; tile rect MUST come from
        // TileUtils.apply_props(tile, this._workArea) - NOT preview rects
        // (see the parity comment in tilingLayout.ts findNearestFreeTile).
        // getWindows() = MRU order (get_tab_list) with unfocusables already
        // filtered, so candidates[0] is the most-recently-used window on the
        // tile - deterministic and no extra stacking API needed.
        const tileRect = TileUtils.apply_props(tile, this._workArea);
        const candidates = getWindows(workspace).filter(
            (win: Meta.Window) =>
                !!win &&
                win !== exclude &&
                !!(win as ExtendedWindow).assignedTile &&
                !win.minimized &&
                !win.maximizedHorizontally &&
                !win.maximizedVertically &&
                !win.is_fullscreen() &&
                !win.is_on_all_workspaces() &&
                win.windowType === Meta.WindowType.NORMAL &&
                win.get_transient_for() === null &&
                !win.is_attached_dialog() &&
                win.allows_move() &&
                win.allows_resize() &&
                win.get_frame_rect().overlap(tileRect)
        );
        return candidates[0];
    }

    // Swap helper for keyboard directional moves: places `swapTarget` on the
    // tile `movingWindow` currently occupies, on the monitor `movingWindow`
    // currently lives on, via the CANONICAL tile-placement path (gap-adjusted
    // inner rect + assignedTile). The caller then moves
    // `movingWindow` through the existing destination path. Returns false
    // (and does nothing) when the mover has no assigned tile or the origin
    // manager is unavailable - callers then keep legacy behavior.
    // CONSTRAINT (user, turn 4): after a swap BOTH windows must conform to
    // their target tile's position and size - B is never placed at a raw or
    // free-form rect, and a floating (untiled) mover never swaps.
    private _performKeyboardSwap(
        movingWindow: Meta.Window,
        swapTarget: Meta.Window
    ): boolean {
        const aTile = (movingWindow as ExtendedWindow).assignedTile;
        if (!aTile) return false; // floating mover: no swap (constraint)

        const sameMonitor = movingWindow.get_monitor() === this._monitor.index;
        const originManager = sameMonitor
            ? this
            : this._getTilingManager?.(movingWindow.get_monitor());
        if (!originManager) return false;

        if (sameMonitor) {
            // animated, same monitor: the drag-tiling placement path
            originManager._easeWindowRectFromTile(aTile, swapTarget);
        } else {
            // skipAnimation + explicit target monitor: mirrors
            // autoTileWindowToTile, the Wayland-verified cross-monitor tile
            // placement used by the auto-tile monitor search
            originManager._easeWindowRectFromTile(
                aTile,
                swapTarget,
                true,
                originManager._monitor.index
            );
        }
        return true;
    }

    // Unified directional move, workspace leg: called by the extension
    // keybinding handler when the mover's monitor has NO neighbor monitor
    // in the direction. The adjacent workspace's entering-edge tile is THE
    // target - occupied -> swap the occupier back onto the mover's tile on
    // the ORIGIN workspace (canonical _easeWindowRectFromTile placement),
    // free -> move onto it. The view follows the mover (activate_with_focus).
    // LEFT/RIGHT only, never wrapped; a RIGHT move off the last workspace
    // appends a new one only under dynamic workspaces. Returns false (and
    // does nothing) for every declined case so the caller keeps today's
    // clamped same-monitor behavior: UP/DOWN, mover on another monitor,
    // floating or maximized mover, mover not on the exit-edge column, or
    // no resolvable workspace/entering tile.
    public onKeyboardMoveWindowAcrossWorkspaces(
        window: Meta.Window,
        direction: KeyBindingsDirection
    ): boolean {
        if (
            direction !== KeyBindingsDirection.LEFT &&
            direction !== KeyBindingsDirection.RIGHT
        )
            return false;
        if (window.get_monitor() !== this._monitor.index) return false;

        const aTile = (window as ExtendedWindow).assignedTile;
        if (!aTile) return false; // floating mover keeps the legacy path
        if (window.maximizedHorizontally || window.maximizedVertically)
            return false;

        // the mover must already sit on the exit-edge column of this
        // monitor's layout in the movement direction
        const atExitEdge =
            direction === KeyBindingsDirection.RIGHT
                ? aTile.x + aTile.width >= 1 - WORKSPACE_EDGE_EPSILON
                : aTile.x <= WORKSPACE_EDGE_EPSILON;
        if (!atExitEdge) return false;

        const originWs = window.get_workspace();
        const step = direction === KeyBindingsDirection.RIGHT ? 1 : -1;
        const targetIndex = originWs.index() + step;
        const nWorkspaces = global.workspaceManager.get_n_workspaces();
        let targetWs: Meta.Workspace | undefined;
        if (targetIndex >= 0 && targetIndex < nWorkspaces) {
            targetWs =
                global.workspaceManager.get_workspace_by_index(targetIndex) ??
                undefined;
        } else if (
            targetIndex === nWorkspaces &&
            step === 1 &&
            Meta.prefs_get_dynamic_workspaces()
        ) {
            targetWs = global.workspaceManager.append_new_workspace(
                false,
                global.get_current_time()
            );
            this._debug('appended a new workspace for the directional move');
        }
        if (!targetWs) return false; // includes LEFT off workspace 0: no wrap
        // const capture keeps the non-undefined narrowing inside the
        // suppression closure below (same TS quirk as aTile above)
        const targetWorkspace = targetWs;

        this._ensureWorkspaceTilingLayout(targetWs);

        const enteringTile = this._findEnteringTileOnWorkspace(
            window,
            targetWs,
            direction
        );
        if (!enteringTile) return false; // degenerate layout

        this._debug(
            `moving window to workspace ${targetWs.index()} monitor ${this._monitor.index}`
        );
        // suppressed: the relocation's change_workspace calls fire the
        // workspace-changed wires synchronously while the windows carry
        // stale geometry — auto-fill enforcement would revert our own move
        withAutoFillSuppressed(() => {
            // swap-back leg first, while the origin view is still active:
            // the occupier of the entering tile goes to the mover's tile on
            // the ORIGIN workspace through the canonical placement path
            const swapTarget = this._findSwapTargetOnTile(
                enteringTile,
                targetWorkspace,
                window
            );
            if (swapTarget) {
                swapTarget.change_workspace(originWs);
                this._easeWindowRectFromTile(aTile, swapTarget);
            }

            // mover leg: relocate, switch the view with focus retained,
            // then conform to the entering tile (writes assignedTile itself)
            window.change_workspace(targetWorkspace);
            targetWorkspace.activate_with_focus(
                window,
                global.get_current_time()
            );
            this._easeWindowRectFromTile(enteringTile, window);
        });
        return true;
    }

    // Entering-edge tile of the target workspace's layout on THIS monitor:
    // the leftmost tile column for RIGHT, the rightmost for LEFT, ranked by
    // vertical proximity to the mover's frame center (work-area proportions).
    private _findEnteringTileOnWorkspace(
        window: Meta.Window,
        ws: Meta.Workspace,
        direction: KeyBindingsDirection
    ): Tile | undefined {
        const tiles = GlobalState.get().getSelectedLayoutOfMonitor(
            this._monitor.index,
            ws.index()
        ).tiles;
        if (tiles.length === 0) return undefined;

        const enteringX =
            direction === KeyBindingsDirection.RIGHT
                ? Math.min(...tiles.map(t => t.x))
                : Math.max(...tiles.map(t => t.x + t.width));
        const column = tiles.filter(t =>
            direction === KeyBindingsDirection.RIGHT
                ? t.x <= enteringX + WORKSPACE_EDGE_EPSILON
                : t.x + t.width >= enteringX - WORKSPACE_EDGE_EPSILON
        );
        if (column.length === 0) return undefined;

        const frame = window.get_frame_rect();
        const centerY =
            (frame.y + frame.height / 2 - this._workArea.y) /
            this._workArea.height;
        let best = column[0];
        let bestDistance = Infinity;
        for (const t of column) {
            const d = Math.abs(t.y + t.height / 2 - centerY);
            if (d < bestDistance) {
                best = t;
                bestDistance = d;
            }
        }
        return best;
    }

    private _findEmptyTile(
        window: Meta.Window,
        monitorIndex: number = window.get_monitor(),
        wsIndex: number = window.get_workspace().index()
    ): Tile | undefined {
        const targetWs =
            global.workspaceManager.get_workspace_by_index(wsIndex);
        const occupiedRects = this._getTiledWindowRects(targetWs ?? undefined);
        const tiles = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            wsIndex
        ).tiles;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const vacantTiles = tiles.filter(t => {
            const tileRect = TileUtils.apply_props(t, workArea);
            return !occupiedRects.find(rect => tileRect.overlap(rect));
        });

        if (vacantTiles.length === 0) return undefined;

        // finally find the vacant tile whose center point is nearest to the
        // center of the work area; equally centered candidates are searched
        // from top to bottom and from left to right
        vacantTiles.sort((a, b) => a.y - b.y || a.x - b.x);

        const centerDistance = (tile: Tile) =>
            squaredEuclideanDistance(
                { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 },
                { x: 0.5, y: 0.5 }
            );

        let bestTileIndex = 0;
        let bestDistance = centerDistance(vacantTiles[0]);
        for (let index = 1; index < vacantTiles.length; index++) {
            const distance = centerDistance(vacantTiles[index]);
            // strictly closer wins: equally centered tiles keep the first
            // one, i.e. the topmost then leftmost by the sort above
            if (distance < bestDistance - CENTERING_TIE_EPSILON) {
                bestTileIndex = index;
                bestDistance = distance;
            }
        }

        if (bestTileIndex < 0 || bestTileIndex >= vacantTiles.length)
            return undefined;
        return vacantTiles[bestTileIndex];
    }

    private _placeWindowOnWorkspace(
        window: Meta.Window,
        target: { ws: Meta.Workspace; monitorIndex: number; tile: Tile }
    ): void {
        const manager =
            target.monitorIndex === this._monitor.index
                ? this
                : this._getTilingManager?.(target.monitorIndex);
        if (!manager) return;
        this._debug(
            `auto-tiling window to workspace ${target.ws.index()} monitor ${target.monitorIndex}`
        );
        // suppressed: the relocation's change_workspace/move_to_monitor
        // fires the workspace-changed/monitor-left wires while the window
        // transiently carries its just-assigned tile but not yet its
        // geometry — enforcement would revert our own overflow placement
        withAutoFillSuppressed(() => {
            window.change_workspace(target.ws);
            // switch the view and focus the window; this also synchronously fires
            // each manager's active-workspace-changed handler which creates the
            // target workspace's TilingLayout — the placement below depends on it
            target.ws.activate_with_focus(window, global.get_current_time());
            manager.autoTileWindowToTile(target.tile, window);
        });
    }

    private _getMonitorsInRowOrder(): number[] {
        return Main.layoutManager.monitors
            .map((monitor, index) => ({ index, x: monitor.x, y: monitor.y }))
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map(entry => entry.index);
    }
}
