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
    planInsertion,
    ChainInputs,
    ChainSlot,
    InsertionPlan,
} from './insertionPlanner';
import GlobalState from '../../utils/globalState';
import { Monitor } from 'resource:///org/gnome/shell/ui/layout.js';
import ExtendedWindow from './extendedWindow';
import EdgeTilingManager from './edgeTilingManager';
import TouchPointer from './touchPointer';
import { KeyBindingsDirection } from '../../keybindings';
import TilingShellWindowManager from '../../components/windowManager/tilingShellWindowManager';
import TilingLayoutWithSuggestions from '../windowsSuggestions/tilingLayoutWithSuggestions';
import { maximizeWindow, unmaximizeWindow } from '../../utils/gnomesupport';

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

    private readonly _signals: SignalHandling;
    private readonly _debug: (..._content: unknown[]) => void;

    /**
     * Constructs a new TilingManager instance.
     * @param monitor The monitor to manage tiling for.
     */
    constructor(
        monitor: Monitor,
        enableScaling: boolean,
        getTilingManager?: (index: number) => TilingManager | undefined,
    ) {
        this._isGrabbingWindow = false;
        this._wasSpanMultipleTilesActivated = false;
        this._wasTilingSystemActivated = false;
        this._snapAssistingInfo = new SnapAssistingInfo();
        this._enableScaling = enableScaling;
        this._monitor = monitor;
        this._signals = new SignalHandling();
        this._getTilingManager = getTilingManager;

        this._debug = logger(`TilingManager ${monitor.index}`);

        // get the monitor's workarea
        this._workArea = Main.layoutManager.getWorkAreaForMonitor(
            this._monitor.index,
        );
        this._debug(
            `Work area for monitor ${this._monitor.index}: ${this._workArea.x} ${this._workArea.y} ${this._workArea.width}x${this._workArea.height}`,
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
                ws.index(),
            );
            this._workspaceTilingLayout.set(
                ws,
                new TilingLayout(
                    layout,
                    innerGaps,
                    outerGaps,
                    this._workArea,
                    monitorScalingFactor,
                ),
            );
        }

        this._tilingSuggestionsLayout = new TilingLayoutWithSuggestions(
            buildMargin(Settings.get_inner_gaps()),
            buildMargin(Settings.get_outer_gaps()),
            this._workArea,
            monitorScalingFactor,
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
            monitorScalingFactor,
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
                    ws.index(),
                );
                this._workspaceTilingLayout.get(ws)?.relayout({ layout });
            },
        );
        this._signals.connect(
            GlobalState.get(),
            GlobalState.SIGNAL_LAYOUTS_CHANGED,
            () => {
                const ws = global.workspaceManager.get_active_workspace();
                if (!ws) return;

                const layout = GlobalState.get().getSelectedLayoutOfMonitor(
                    this._monitor.index,
                    ws.index(),
                );
                this._workspaceTilingLayout.get(ws)?.relayout({ layout });
            },
        );

        this._signals.connect(Settings, Settings.KEY_INNER_GAPS, () => {
            const innerGaps = buildMargin(Settings.get_inner_gaps());
            this._workspaceTilingLayout.forEach((tilingLayout) =>
                tilingLayout.relayout({ innerGaps }),
            );
        });
        this._signals.connect(Settings, Settings.KEY_OUTER_GAPS, () => {
            const outerGaps = buildMargin(Settings.get_outer_gaps());
            this._workspaceTilingLayout.forEach((tilingLayout) =>
                tilingLayout.relayout({ outerGaps }),
            );
        });

        this._signals.connect(
            global.display,
            'grab-op-begin',
            (
                _display: Meta.Display,
                window: Meta.Window,
                grabOp: Meta.GrabOp,
            ) => {
                const moving = (grabOp & ~1024) === 1;
                if (!moving) return;

                this._onWindowGrabBegin(window, grabOp);
            },
        );

        this._signals.connect(
            global.display,
            'grab-op-end',
            (_display: Meta.Display, window: Meta.Window) => {
                if (!this._isGrabbingWindow) return;

                this._onWindowGrabEnd(window);
            },
        );

        this._signals.connect(
            this._snapAssist,
            'snap-assist',
            this._onSnapAssist.bind(this),
        );

        this._signals.connect(
            global.workspaceManager,
            'active-workspace-changed',
            () => {
                const ws = global.workspaceManager.get_active_workspace();
                if (this._workspaceTilingLayout.has(ws)) return;

                const monitorScalingFactor = this._enableScaling
                    ? getMonitorScalingFactor(this._monitor.index)
                    : undefined;
                const layout: Layout =
                    GlobalState.get().getSelectedLayoutOfMonitor(
                        this._monitor.index,
                        ws.index(),
                    );
                const innerGaps = buildMargin(Settings.get_inner_gaps());
                const outerGaps = buildMargin(Settings.get_outer_gaps());

                this._debug('created new tiling layout for active workspace');
                this._workspaceTilingLayout.set(
                    ws,
                    new TilingLayout(
                        layout,
                        innerGaps,
                        outerGaps,
                        this._workArea,
                        monitorScalingFactor,
                    ),
                );
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspace-removed',
            (_) => {
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

                [...this._workspaceTilingLayout.values()].forEach((tl) =>
                    tl.destroy(),
                );
                this._workspaceTilingLayout.clear();
                this._workspaceTilingLayout = newMap;
                this._debug('deleted workspace');
            },
        );

        this._signals.connect(
            global.display,
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                if (Settings.ENABLE_AUTO_TILING) this._autoTile(window, true);
            },
        );
        this._signals.connect(
            TilingShellWindowManager.get(),
            'unmaximized',
            (_, window: Meta.Window) => {
                if (Settings.ENABLE_AUTO_TILING) this._autoTile(window, false);
            },
        );

        // forget assigned tile when window is maximized
        this._signals.connect(
            TilingShellWindowManager.get(),
            'maximized',
            (_, window: Meta.Window) => {
                delete (window as ExtendedWindow).assignedTile;
            },
        );
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
            tilingLayout.innerGaps.bottom,
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
        opts: { deferEdgeToNeighbor?: boolean; freeTileOnly?: boolean } = {},
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
                enlargeFactor,
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
                    this._getTiledWindowRects(currentWs),
                );
                if (!destination && !opts.freeTileOnly)
                    destination = tilingLayout.findNearestTile(windowRectCopy);
            } else {
                destination = tilingLayout.findNearestTileDirection(
                    windowRectCopy,
                    direction,
                    true, // clamp: the offset point must land inside this monitor
                    this._directionEnlargeFactor(tilingLayout),
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
                this._workArea,
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
                window,
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
        this._signals.disconnect();
        this._isGrabbingWindow = false;
        this._snapAssistingInfo.update(undefined);
        this._edgeTilingManager.abortEdgeTiling();
        this._workspaceTilingLayout.forEach((tl) => tl.destroy());
        this._workspaceTilingLayout.clear();
        this._snapAssist.destroy();
        this._selectedTilesPreview.destroy();
        this._tilingSuggestionsLayout.destroy();
    }

    public set workArea(newWorkArea: Mtk.Rectangle) {
        if (newWorkArea.equal(this._workArea)) return;

        this._workArea = newWorkArea;
        this._debug(
            `new work area for monitor ${this._monitor.index}: ${newWorkArea.x} ${newWorkArea.y} ${newWorkArea.width}x${newWorkArea.height}`,
        );

        // notify the tiling layout that the workarea changed and trigger a new relayout
        // so we will have the layout already computed to be shown quickly when needed
        this._workspaceTilingLayout.forEach((tl) =>
            tl.relayout({ containerRect: this._workArea }),
        );
        this._snapAssist.workArea = this._workArea;
        this._edgeTilingManager.workarea = this._workArea;
    }

    private _onWindowGrabBegin(window: Meta.Window, grabOp: number) {
        if (this._isGrabbingWindow) return;

        TouchPointer.get().updateWindowPosition(window.get_frame_rect());
        this._signals.connect(
            global.stage,
            'touch-event',
            (_source, event: Clutter.Event) => {
                const [x, y] = event.get_coords();
                TouchPointer.get().onTouchEvent(x, y);
            },
        );
        // Add Wacom tablet support, listen to tablet events
        this._signals.connect(
            global.stage,
            'captured-event',
            (_source, event: Clutter.Event) => {
                const device = event.get_source_device();
                if (!device) return;

                const deviceType = device.get_device_type();

                // Check for tablet device types
                if (deviceType === Clutter.InputDeviceType.TABLET_DEVICE ||
                    deviceType === Clutter.InputDeviceType.PEN_DEVICE) {

                    const eventType = event.type();
                    // Capture motion events from tablet
                    if (eventType === Clutter.EventType.MOTION) {
                        const [x, y] = event.get_coords();
                        TouchPointer.get().onTouchEvent(x, y);
                        // Move the actual mouse cursor to match tablet position
                        const seat = Clutter.get_default_backend().get_default_seat();
                        seat.warp_pointer(x, y);
                    }
                }
            },
        );

        // workaround for gnome-shell bug https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2857
        if (
            Settings.ENABLE_BLUR_SNAP_ASSISTANT ||
            Settings.ENABLE_BLUR_SELECTED_TILEPREVIEW
        ) {
            this._signals.connect(window, 'position-changed', () => {
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
            this._onMovingWindow.bind(this, window, grabOp),
        );

        this._onMovingWindow(window, grabOp);
    }

    private _activationKeyStatus(
        modifier: number,
        key: ActivationKey,
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
                        y,
                    );
                }
            }
            extWin.originalSize = undefined;
            this._grabStartPosition = null;
        }

        const isSpanMultiTilesActivated = this._activationKeyStatus(
            modifier,
            Settings.SPAN_MULTIPLE_TILES_ACTIVATION_KEY,
        );
        const isTilingSystemActivated = this._activationKeyStatus(
            modifier,
            Settings.TILING_SYSTEM_ACTIVATION_KEY,
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
                        true,
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
            changedSpanMultipleTiles && !allowSpanMultipleTiles,
        );
        if (!selectionRect) return GLib.SOURCE_CONTINUE;

        selectionRect = selectionRect.copy();
        if (allowSpanMultipleTiles && this._selectedTilesPreview.showing) {
            selectionRect = selectionRect.union(
                this._selectedTilesPreview.rect,
            );
        }
        tilingLayout.hoverTilesInRect(selectionRect, !allowSpanMultipleTiles);

        this.openSelectionTilePreview(selectionRect, true, true, window);

        return GLib.SOURCE_CONTINUE;
    }

    private _onWindowGrabEnd(window: Meta.Window) {
        this._isGrabbingWindow = false;
        this._grabStartPosition = null;

        this._signals.disconnect(window);
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
            Settings.TILING_SYSTEM_ACTIVATION_KEY,
        );
        if (
            !isTilingSystemActivated &&
            !this._snapAssistingInfo.isSnapAssisting &&
            !this._edgeTilingManager.isPerformingEdgeTiling()
        )
            return;

        const wasSnapAssistingLayout = this._snapAssistingInfo.isSnapAssisting
            ? GlobalState.get().layouts.find(
                  (lay) => lay.id === this._snapAssistingInfo.layoutId,
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
                this._monitor.index,
            );
        }

        if (!tilingLayout || !canShowTilingSuggestions) return;

        // retrieve the current layout for the monitor and workspace
        // were the window was tiled
        const layout = wasEdgeTiling
            ? (Settings.EDGE_TILING_MODE === EdgeTilingMode.DEFAULT
                ? new Layout([
                    new Tile({ x: 0, y: 0, height: 0.5, width: 0.5, groups: []}),
                    new Tile({ x: 0.5, y: 0, height: 0.5, width: 0.5, groups: []}),
                    new Tile({ x: 0, y: 0.5, height: 0.5, width: 0.5, groups: []}),
                    new Tile({ x: 0.5, y: 0.5, height: 0.5, width: 0.5, groups: []})],
                    "quarters"
                )
                : GlobalState.get().getSelectedLayoutOfMonitor(
                  this._monitor.index,
                  window.get_workspace().index())
            ): (wasSnapAssistingLayout
              ? wasSnapAssistingLayout
              : GlobalState.get().getSelectedLayoutOfMonitor(
                    this._monitor.index,
                    window.get_workspace().index(),
                ));
        this._openWindowsSuggestions(
            window,
            desiredWindowRect,
            window.get_monitor(),
            layout,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            tilingLayout.scalingFactor,
        );
    }

    private _openWindowsSuggestions(
        window: Meta.Window,
        windowDesiredRect: Mtk.Rectangle,
        monitorIndex: number,
        layout: Layout,
        innerGaps: Clutter.Margin,
        outerGaps: Clutter.Margin,
        scalingFactor: number,
    ): void {
        const tiledWindows: ExtendedWindow[] = [];
        const nontiledWindows: Meta.Window[] = [];
        getWindows().forEach((extWin) => {
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
            scalingFactor,
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
            monitorIndex,
        );
    }

    private _easeWindowRect(
        window: Meta.Window,
        destRect: Mtk.Rectangle,
        user_op: boolean = false,
        force: boolean = false,
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
        windowActor.remove_all_transitions();
        // @ts-expect-error "Main.wm has the "private" function _prepareAnimationInfo"
        Main.wm._prepareAnimationInfo(
            global.windowManager,
            windowActor,
            beforeRect.copy(),
            Meta.SizeChange.UNMAXIMIZE,
        );

        // move and resize the window to the current selection
        window.move_to_monitor(this._monitor.index);
        if (force) window.move_frame(user_op, destRect.x, destRect.y);
        window.move_resize_frame(
            user_op,
            destRect.x,
            destRect.y,
            destRect.width,
            destRect.height,
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
        window?: Meta.Window,
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
                : undefined,
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
                gaps.left > 0,
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
                    this._workArea,
                );
            this._selectedTilesPreview.updateBorderRadius(
                !isTop,
                !isRight,
                !isBottom,
                !isLeft,
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
            }),
        );
        return this._monitor.index === pointerMonitorIndex;
    }

    private _showEdgeTiling(
        window: Meta.Window,
        edgeTile: Mtk.Rectangle,
        pointerX: number,
        pointerY: number,
        tilingLayout: TilingLayout,
    ) {
        this._selectedTilesPreview.gaps = buildTileGaps(
            edgeTile,
            tilingLayout.innerGaps,
            tilingLayout.outerGaps,
            this._workArea,
            this._enableScaling
                ? getScalingFactorOf(tilingLayout)[1]
                : undefined,
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
        targetMonitorIndex: number | undefined = undefined,
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
                : undefined,
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
            this._workArea,
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
                destinationRect.height,
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
     * Re-tile a window that just entered this monitor through a NON
     * Tiling-Shell path (e.g. GNOME's built-in "move window one monitor
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
            window,
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
        // focused one
        let anchorCandidate: Meta.Window | undefined =
            global.display.get_focus_window() ?? undefined;
        let anchorFromFocus = anchorCandidate !== undefined;
        if (anchorCandidate === undefined || anchorCandidate === window) {
            // Wayland timing defense (not verified on every mutter
            // version): fall back to the MRU head of the birth workspace,
            // excluding the new window itself
            anchorCandidate = getWindows(window.get_workspace()).find(
                (win) => win !== window,
            );
            anchorFromFocus = false;
        }
        this._debug(
            `insertion: anchor source=${anchorFromFocus ? 'focus' : 'mru'}`,
        );

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

                // insert-after-focused: plan against the anchor captured
                // at window-created time. INVARIANT: when this returns
                // true the window was fully handled (placed, or left
                // floating by an aborted plan), so BOTH default searches
                // below stay unreachable for it — the synchronous
                // row-by-row monitor search AND the GLib.idle_add
                // other-workspace search registered further down: the
                // return sits before both on this code path.
                if (this._runInsertionAfterFocused(window, anchorCandidate))
                    return;

                // search the monitors row by row from top to bottom and, within
                // a row, from left to right: the first monitor with an empty
                // tile wins
                for (const monitorIndex of this._getMonitorsInRowOrder()) {
                    const manager =
                        monitorIndex === this._monitor.index
                            ? this
                            : this._getTilingManager?.(monitorIndex);
                    if (!manager) continue;
                    const tile = this._findEmptyTile(window, monitorIndex);
                    if (tile) {
                        manager.autoTileWindowToTile(tile, window);
                        return;
                    }
                }
                // the overflow search must not run inside the first-frame
                // emission: switching workspaces and moving the window while
                // mutter's frame is still in progress aborts the compositor
                // (invalidate_top_window_actor_for_views). Run it from the
                // main loop once the current frame is done.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
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
                    if (window.is_on_all_workspaces())
                        return GLib.SOURCE_REMOVE; // sticky windows just float

                    const vacancy = this._findVacancyInOtherWorkspaces(window);
                    if (vacancy) {
                        this._debug(
                            `all monitors full on this workspace: found free tile on workspace ${vacancy.ws.index()}`,
                        );
                        this._placeWindowOnWorkspace(window, vacancy);
                        return GLib.SOURCE_REMOVE;
                    }

                    if (Meta.prefs_get_dynamic_workspaces()) {
                        const ws = global.workspaceManager.append_new_workspace(
                            false,
                            global.get_current_time(),
                        );
                        const tile = this._findEmptyTile(
                            window,
                            this._monitor.index,
                            ws.index(),
                        );
                        if (tile) {
                            this._debug(
                                `all workspaces full: auto-tiling window to new workspace ${ws.index()}`,
                            );
                            this._placeWindowOnWorkspace(window, {
                                ws,
                                monitorIndex: this._monitor.index,
                                tile,
                            });
                        }
                        return GLib.SOURCE_REMOVE;
                    }

                    this._debug(
                        'all monitors are full on every workspace: leaving the window floating (fixed workspaces)',
                    );
                    return GLib.SOURCE_REMOVE;
                });
                // all monitors are full and workspaces are fixed: the window floats
                // on its birth monitor (decided asynchronously, see idle above)
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
        window: Meta.Window,
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
        if ((anchor as ExtendedWindow).assignedTile === undefined)
            return false;
        if (anchor.get_workspace().index() !== window.get_workspace().index())
            return false;
        return true;
    }

    // The manager of an insertion slot's OWN monitor. NEVER falls back to
    // `this` for a foreign monitor: a wrong manager's work area and monitor
    // index would produce wrong geometry and drag windows onto the wrong
    // monitor.
    private _getInsertionTargetManager(
        monitorIndex: number,
    ): TilingManager | undefined {
        if (monitorIndex === this._monitor.index) return this;
        return this._getTilingManager?.(monitorIndex);
    }

    // Slot occupancy truth for the insertion re-checks: the very same
    // conditions as the tiled-window-rects query backing the vacancy
    // searches.
    private _isInsertionSlotOccupied(
        ws: Meta.Workspace,
        tileRect: Mtk.Rectangle,
    ): boolean {
        return this._getTiledWindowRects(ws).some((rect) =>
            tileRect.overlap(rect),
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
        const layout: Layout =
            GlobalState.get().getSelectedLayoutOfMonitor(
                this._monitor.index,
                ws.index(),
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
                monitorScalingFactor,
            ),
        );
    }

    // Insert-after-focused: validate the captured anchor, plan through the
    // pure insertion planner and dispatch the result. Returns true when
    // the insertion path fully handled the window (direct placement done,
    // an idle plan registered, or an abort that deliberately leaves the
    // window floating) — the caller must then short-circuit the default
    // vacancy searches. Returns false when the default behavior must run
    // (no eligible anchor, mutex deferral, or a planner fallback).
    private _runInsertionAfterFocused(
        window: Meta.Window,
        anchorCandidate: Meta.Window | undefined,
    ): boolean {
        if (!this._isEligibleInsertionAnchor(anchorCandidate, window)) {
            this._debug('insertion: no anchor, default behavior');
            return false;
        }
        const anchor = anchorCandidate;

        // mutex: a plan already sits in the first-frame -> idle gap, so the
        // occupancy truth is stale; a second plan would double-move the
        // same occupants and stack windows on the same slots
        if (_insertionShiftInProgress) {
            this._debug('insertion: deferred, another insertion in flight');
            return false;
        }

        // every bit of shell access the pure planner needs is injected
        const chainInputs: ChainInputs = {
            monitorsInRowOrder: this._getMonitorsInRowOrder(),
            getWorkAreaForMonitor: (m: number) =>
                Main.layoutManager.getWorkAreaForMonitor(m),
            getTilesForMonitor: (m: number, ws: number) =>
                GlobalState.get().getSelectedLayoutOfMonitor(m, ws).tiles,
            getWindows: (ws: Meta.Workspace) => getWindows(ws),
            rectFromTile: (tile: Tile, container: Mtk.Rectangle) =>
                TileUtils.apply_props(tile, container),
        };
        // chains are built lazily and at most once per workspace
        const chainCache = new Map<number, ChainSlot[]>();
        const getChain = (wsIndex: number): ChainSlot[] => {
            const cached = chainCache.get(wsIndex);
            if (cached) return cached;
            const chain = buildWorkspaceChain(wsIndex, chainInputs);
            chainCache.set(wsIndex, chain);
            return chain;
        };

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
            return false;
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
        // (pure existing precedent: the default search below also places
        // the new window itself right here)
        if (
            plan.moves.length === 0 &&
            !plan.switchView &&
            !plan.appendWorkspace
        ) {
            _insertionShiftInProgress = true;
            try {
                const manager = this._getInsertionTargetManager(
                    plan.newWindowTarget.slot.monitorIndex,
                );
                if (!manager) {
                    this._debug(
                        'insertion: fallback, monitor manager unavailable',
                    );
                    return true; // handled: the window stays floating
                }
                manager.autoTileWindowToTile(
                    plan.newWindowTarget.slot.tile,
                    window,
                );
                this._debug(
                    `insertion: direct placement ws=${plan.newWindowTarget.wsIndex} slot=${plan.newWindowTarget.slot.slotIndex} moves=0`,
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
        // crashes the compositor (see the comment below the default
        // search)
        const absorbTarget =
            plan.moves.length > 0
                ? plan.moves[0].target // largest target key: exactly E
                : plan.newWindowTarget;
        this._debug(
            `insertion: shifting ${plan.moves.length} windows, absorb at ws=${absorbTarget.wsIndex} slot=${absorbTarget.slot.slotIndex}`,
        );
        _insertionShiftInProgress = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._executeInsertionPlan(window, plan, anchorWs);
                return GLib.SOURCE_REMOVE;
            } finally {
                _insertionShiftInProgress = false;
            }
        });
        return true;
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
        anchorWs: number,
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
                global.get_current_time(),
            );
            for (const monitorIndex of this._getMonitorsInRowOrder()) {
                this._getInsertionTargetManager(
                    monitorIndex,
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
                global.workspaceManager.get_workspace_by_index(wsIndex) ===
                null
            ) {
                this._debug('insertion: aborted, workspace vanished');
                return;
            }
        }

        // the absorb slot must still be free: a concurrent default-path
        // placement may have filled it in the gap, and the tail move would
        // then stack its occupant on top
        const absorbTarget =
            plan.moves.length > 0
                ? plan.moves[0].target
                : plan.newWindowTarget;
        if (!plan.appendWorkspace) {
            const absorbWs = global.workspaceManager.get_workspace_by_index(
                absorbTarget.wsIndex,
            );
            if (
                absorbWs !== null &&
                this._isInsertionSlotOccupied(
                    absorbWs,
                    absorbTarget.slot.tileRect,
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
            // INTENTIONAL semantic difference from
            // _findVacancyInOtherWorkspaces: that default search wraps
            // around the workspace ring ((origin + k) % n), while an
            // insertion cascade only ever moves FORWARD — workspace
            // indices monotonically non-decreasing from the anchor. A
            // target behind the anchor workspace means the planner
            // regressed to ring semantics: abort the whole plan like the
            // other re-check failures (skip-and-continue would leave an
            // unshifted occupant wedged between the insertion slot and
            // the absorb vacancy).
            if (move.target.wsIndex < anchorWs) {
                this._debug('insertion: skip invalid cross-ws move');
                return;
            }
            const manager = this._getInsertionTargetManager(
                move.target.slot.monitorIndex,
            );
            if (!manager) {
                this._debug(
                    'insertion: fallback, monitor manager unavailable',
                );
                return;
            }
            if (win.get_workspace().index() !== move.target.wsIndex) {
                const targetWs =
                    global.workspaceManager.get_workspace_by_index(
                        move.target.wsIndex,
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
                    `insertion: overflow window -> ws=${move.target.wsIndex}`,
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
                    `insertion: move ${movedOk ? 'ok' : 'FAIL'} ws=${move.target.wsIndex} slot=${move.target.slot.slotIndex}`,
                );
            } else {
                this._auditInsertionMoveLater(
                    win,
                    move.target.wsIndex,
                    move.target.slot.slotIndex,
                    move.target.slot.tileRect,
                );
            }
        }

        // final leg: the new window itself. For an append plan the target
        // workspace was created at the top of this callback, so the
        // lookup below finds it; every manager already holds its layout
        // entry from the same block.
        const newTargetWs = global.workspaceManager.get_workspace_by_index(
            plan.newWindowTarget.wsIndex,
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
                plan.newWindowTarget.slot.tileRect,
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
                `insertion: view switch to ws=${plan.newWindowTarget.wsIndex}`,
            );
            newTargetWs.activate_with_focus(window, global.get_current_time());
        }
        const newManager = this._getInsertionTargetManager(
            plan.newWindowTarget.slot.monitorIndex,
        );
        if (!newManager) {
            this._debug('insertion: fallback, monitor manager unavailable');
            return;
        }
        newManager.autoTileWindowToTile(
            plan.newWindowTarget.slot.tile,
            window,
        );
    }

    // Deferred geometry audit for cross-monitor move legs: the frame rect
    // only settles after the client acks the reconfigure, so the check is
    // retried a bounded number of times before a FAIL is declared.
    private _auditInsertionMoveLater(
        window: Meta.Window,
        wsIndex: number,
        slotIndex: number,
        tileRect: Mtk.Rectangle,
        attempt: number = 1,
    ): void {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250 * attempt, () => {
            if (window.get_compositor_private() === null)
                return GLib.SOURCE_REMOVE; // unmanaged meanwhile: nothing to audit
            const movedOk = window.get_frame_rect().overlap(tileRect);
            if (!movedOk && attempt < 3) {
                this._auditInsertionMoveLater(
                    window,
                    wsIndex,
                    slotIndex,
                    tileRect,
                    attempt + 1,
                );
                return GLib.SOURCE_REMOVE;
            }
            this._debug(
                `insertion: move ${movedOk ? 'ok' : 'FAIL'} ws=${wsIndex} slot=${slotIndex}`,
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    // frame rects of tiled windows (assigned tile, not minimized, not
    // maximized) — the single source of truth for tile occupancy.
    // Without a workspace this scans the ACTIVE workspace (matches the
    // historical getWindows() default used by _findEmptyTile).
    private _getTiledWindowRects(
        workspace: Meta.Workspace | undefined = undefined,
    ): Mtk.Rectangle[] {
        return getWindows(workspace)
            .filter(
                (window) =>
                    window &&
                    (window as ExtendedWindow).assignedTile &&
                    !window.minimized &&
                    !window.maximizedVertically &&
                    !window.maximizedHorizontally,
            )
            .map((window) => window.get_frame_rect());
    }

    private _findSwapTargetOnTile(
        tile: Tile,
        workspace: Meta.Workspace | undefined,
        exclude: Meta.Window,
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
                win.get_frame_rect().overlap(tileRect),
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
        swapTarget: Meta.Window,
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
                originManager._monitor.index,
            );
        }
        return true;
    }

    private _findEmptyTile(
        window: Meta.Window,
        monitorIndex: number = window.get_monitor(),
        wsIndex: number = window.get_workspace().index(),
    ): Tile | undefined {
        const targetWs =
            global.workspaceManager.get_workspace_by_index(wsIndex);
        const occupiedRects = this._getTiledWindowRects(targetWs ?? undefined);
        const tiles = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            wsIndex,
        ).tiles;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const vacantTiles = tiles.filter((t) => {
            const tileRect = TileUtils.apply_props(t, workArea);
            return !occupiedRects.find((rect) => tileRect.overlap(rect));
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

    private _findVacancyInOtherWorkspaces(window: Meta.Window): {
        ws: Meta.Workspace;
        monitorIndex: number;
        tile: Tile;
    } | undefined {
        const origin = window.get_workspace().index();
        const n = global.workspaceManager.get_n_workspaces();
        const nMonitors = Main.layoutManager.monitors.length;
        for (let k = 1; k < n; k++) {
            const wsIndex = (origin + k) % n;
            const ws = global.workspaceManager.get_workspace_by_index(wsIndex);
            if (!ws) continue;
            for (let m = 0; m < nMonitors; m++) {
                if (m !== this._monitor.index && !this._getTilingManager?.(m))
                    continue;
                const tile = this._findEmptyTile(window, m, wsIndex);
                if (tile) return { ws, monitorIndex: m, tile };
            }
        }
        return undefined;
    }

    private _placeWindowOnWorkspace(
        window: Meta.Window,
        target: { ws: Meta.Workspace; monitorIndex: number; tile: Tile },
    ): void {
        const manager =
            target.monitorIndex === this._monitor.index
                ? this
                : this._getTilingManager?.(target.monitorIndex);
        if (!manager) return;
        this._debug(
            `auto-tiling window to workspace ${target.ws.index()} monitor ${target.monitorIndex}`,
        );
        window.change_workspace(target.ws);
        // switch the view and focus the window; this also synchronously fires
        // each manager's active-workspace-changed handler which creates the
        // target workspace's TilingLayout — the placement below depends on it
        target.ws.activate_with_focus(window, global.get_current_time());
        manager.autoTileWindowToTile(target.tile, window);
    }

    private _getMonitorsInRowOrder(): number[] {
        return Main.layoutManager.monitors
            .map((monitor, index) => ({ index, x: monitor.x, y: monitor.y }))
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map(entry => entry.index);
    }
}
