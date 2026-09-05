import { GLib, Meta } from '../../gi/ext';
import GlobalState from '../../utils/globalState';
import { logger } from '../../utils/logger';
import SignalHandling from '../../utils/signalHandling';
import { filterUnfocusableWindows } from '../../utils/ui';
import TileUtils from '../layout/TileUtils';
import ExtendedWindow from '../tilingsystem/extendedWindow';
import {
    AREA_EPSILON,
    findPreviousSeatOccupant,
    matchRectToSeat,
    pickFillSuccessor,
    positiveAreaIntersection,
    type RectLike,
    type SeatWindow,
    type WsSeats,
} from '../tilingsystem/fillSuccessorPolicy';
import { compareTilesInReadingOrder } from '../tilingsystem/freeTileFillPlanner';
import {
    clearAppliedFillMoves,
    takeAppliedFillMoves,
} from '../tilingsystem/freeTileFiller';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// structural mirror of AutoTileWindowManager's per-window cache marker
// (not exported there): get_workspace() is unreliable at unmanage time
// (tilingManager precedent), the tracked workspace object is not
interface WindowWithCachedWs {
    __ts_cached?: { workspace: Meta.Workspace | null };
}

/** the closed window's seat, captured while its wrapper is still alive */
interface CloseAnchor {
    wsIndex: number;
    frameRect: RectLike;
}

/** one live tiled window as gathered for the walk-back search */
interface SeatEntry {
    window: Meta.Window;
    wsIndex: number;
    /** the seat this window occupies, when it overlaps any */
    seatRect: RectLike | undefined;
}

export class FocusOnCloseManager {
    private readonly _signals: SignalHandling;

    private _unmanagingIds: {
        [windowId: number]: { id: number; win: Meta.Window };
    };

    private _idleId: number = 0;

    private _pendingAnchor: CloseAnchor | null = null;

    private _debug = logger('FocusOnClose');

    constructor() {
        this._signals = new SignalHandling();
        this._unmanagingIds = {};
    }

    public enable(): void {
        // bootstrap over ALL windows (every workspace, not only the active
        // one) so closes on hidden workspaces are tracked too
        global.get_window_actors().forEach(winActor => {
            // a WindowActor can briefly outlive its Meta.Window
            // during teardown; bootstrapping it would throw on
            // the get_id() call inside the handler
            if (winActor.metaWindow)
                this._connectUnmanagingHandler(winActor.metaWindow);
        });
        this._signals.connect(
            global.display,
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                this._connectUnmanagingHandler(window);
            }
        );
    }

    public destroy(): void {
        this._signals.disconnect();

        const toDelete: number[] = [];
        Object.keys(this._unmanagingIds).forEach(key => {
            const windowId = Number(key);
            this._unmanagingIds[windowId].win.disconnect(
                this._unmanagingIds[windowId].id
            );
            toDelete.push(windowId);
        });
        toDelete.forEach(windowId => delete this._unmanagingIds[windowId]);

        if (this._idleId > 0) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._pendingAnchor = null;

        // the consumer owns the applied-move registry: leftover records
        // would pin disposed Meta.Window wrappers across the
        // disable→enable cycle
        clearAppliedFillMoves();
    }

    private _connectUnmanagingHandler(window: Meta.Window): void {
        if (this._unmanagingIds[window.get_id()]) return;

        // the handler deletes its own map entry; every window death fires
        // this signal first and destroy() sweeps the windows still alive
        const id = window.connect('unmanaging', () =>
            this._onWindowUnmanaging(window)
        );
        this._unmanagingIds[window.get_id()] = { id, win: window };
    }

    private _onWindowUnmanaging(window: Meta.Window): void {
        delete this._unmanagingIds[window.get_id()];

        if ((window as ExtendedWindow).assignedTile === undefined) return; // window not tiled
        // resolve the workspace from the tracked workspace OBJECT:
        // get_workspace() is unreliable at unmanage time (tilingManager
        // precedent); either source may already be null here — skip
        // instead of dereferencing a torn-down workspace
        const ws =
            (window as WindowWithCachedWs).__ts_cached?.workspace ??
            window.get_workspace();
        if (!ws) return;
        const wasFocused = window.has_focus();
        const onActiveWs =
            ws.index() === global.workspaceManager.get_active_workspace_index();
        // a background window closing on an inactive workspace keeps
        // GNOME's default focus; every other close (the focused window
        // itself, or any window of the active workspace) takes the
        // deterministic successor
        if (!wasFocused && !onActiveWs) return;

        const rect = window.get_frame_rect();
        const anchor: CloseAnchor = {
            wsIndex: ws.index(),
            frameRect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },
        };
        this._debug(
            `tiled window closing (ws ${anchor.wsIndex}); deferring fill-successor/previous-seat focus search`
        );

        // never activate synchronously inside the handler: moving focus
        // while mutter's frame is still in progress aborts the compositor
        // (invalidate_top_window_actor_for_views) and X11 EnterNotify would
        // race us. Last-anchor-wins under rapid batch closes: the idle
        // recomputes the successor from the live windows.
        //
        // CASCADE CONTRACT: this close also triggers FreeTileFiller's
        // cross-workspace merge, whose pass is deferred to an idle too —
        // queued at PRIORITY_DEFAULT_IDLE from the LATER 'unmanaged'
        // signal, while this anchor is recorded on the EARLIER
        // 'unmanaging' one. Both signals fire within mutter's unmanage
        // call stack, so both idles are pending before either dispatches,
        // and PRIORITY_LOW (numerically above DEFAULT_IDLE) guarantees
        // this search runs strictly AFTER the whole merge applied its
        // moves synchronously: the successor is picked from the merge's
        // applied-move records and the POST-cascade rects, and focus is
        // activated once, after the churn. The successor is the window
        // that compacted onto, or was pulled across workspaces into,
        // the freed spot — or, when no mover landed there, the occupant
        // of the previous occupied seat of the global reading order.
        // Do NOT raise this priority back to PRIORITY_DEFAULT_IDLE: the
        // search would then run on pre-merge geometry and the merge's
        // workspace/tile moves would drop the just-set focus again.
        this._pendingAnchor = anchor;
        if (this._idleId === 0) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idleId = 0;
                const anchorToUse = this._pendingAnchor;
                this._pendingAnchor = null;
                if (anchorToUse) this._focusSuccessor(anchorToUse);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _focusSuccessor(anchor: CloseAnchor): void {
        // Round 0: the window the fill cascade moved into the freed
        // spot. The original records are kept around because the
        // winner's Meta.Window is looked up from them by id after the
        // pick; only the pure projection feeds pickFillSuccessor
        const records = takeAppliedFillMoves();
        const winnerId = pickFillSuccessor(
            records.map(m => ({
                windowId: m.windowId,
                toWsIndex: m.toWsIndex,
                destRect: m.destRect,
            })),
            { wsIndex: anchor.wsIndex, frameRect: anchor.frameRect }
        );
        if (winnerId !== null) {
            const winner = records.find(m => m.windowId === winnerId);
            if (
                winner &&
                this._successorIsFocusable(winner.window, winner.destRect)
            ) {
                this._debug(
                    `focusing fill successor window "${winner.window.title}" (ws ${anchor.wsIndex})`
                );
                // never pass timestamp 0 (CURRENT_TIME: mutter warns);
                // activateWindow handles the cross-workspace jump internally
                Main.activateWindow(winner.window, global.get_current_time());
                return;
            }
        }

        // Round 1: no mover landed on the freed spot: walk the global
        // reading order back to the previous occupied seat
        const { wsSeats, seatsByWindowId } = this._gatherWsSeats(
            anchor.wsIndex
        );
        const previousId = findPreviousSeatOccupant(
            { wsIndex: anchor.wsIndex, frameRect: anchor.frameRect },
            wsSeats
        );
        if (previousId !== null) {
            const previous = seatsByWindowId.get(previousId);
            if (
                previous &&
                previous.seatRect &&
                this._successorIsFocusable(previous.window, previous.seatRect)
            ) {
                this._debug(
                    `focusing previous-seat window "${previous.window.title}" (ws ${previous.wsIndex})`
                );
                Main.activateWindow(previous.window, global.get_current_time());
                return;
            }
        }

        // GNOME's default focus takes over
        this._debug('no successor: no mover and no previous occupied seat');
    }

    /**
     * Triple liveness/geometry gate shared by both rounds: a disposed
     * wrapper, an unmanaging window (workspace torn to null, monitor to
     * -1), or a window that never reached its expected rect all count
     * as a miss and let the search fall through.
     */
    private _successorIsFocusable(
        window: Meta.Window,
        expectedRect: RectLike
    ): boolean {
        // activating a disposed wrapper throws in GJS: the deferred idle
        // may run after the successor itself died, so probe before use
        try {
            window.get_id();
        } catch (_e) {
            return false;
        }
        if (window.get_workspace() === null || window.get_monitor() < 0)
            return false;
        // tileWindow can fail silently: trust the winner only when its
        // live geometry really overlaps the expected rect
        const live = window.get_frame_rect();
        return (
            positiveAreaIntersection(
                {
                    x: live.x,
                    y: live.y,
                    width: live.width,
                    height: live.height,
                },
                expectedRect
            ) > AREA_EPSILON
        );
    }

    /**
     * Live seat map of every workspace from fromWsIndex down to 0, in
     * that descending array order (findPreviousSeatOccupant walks the
     * anchor workspace first, then the smaller workspaces in the order
     * passed here). Gathered fresh on every search, never cached across
     * idles: the seating itself may have changed since the anchor was
     * recorded.
     */
    private _gatherWsSeats(fromWsIndex: number): {
        wsSeats: WsSeats[];
        seatsByWindowId: Map<number, SeatEntry>;
    } {
        const wsSeats: WsSeats[] = [];
        const seatsByWindowId = new Map<number, SeatEntry>();
        for (let i = fromWsIndex; i >= 0; i--) {
            // dynamic workspaces may have removed/renumbered it
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;

            // mirror of FreeTileFiller._buildSnapshot: every monitor's
            // layout tiles for this workspace, scaled to global pixels
            // through their own work area, merged across monitors and
            // sorted in reading order
            const seats: RectLike[] = [];
            const monitors = Main.layoutManager.monitors;
            for (
                let monitorIndex = 0;
                monitorIndex < monitors.length;
                monitorIndex++
            ) {
                const workArea =
                    Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
                for (const layoutTile of GlobalState.get().getSelectedLayoutOfMonitor(
                    monitorIndex,
                    i
                ).tiles) {
                    const pixelRect = TileUtils.apply_props(
                        layoutTile,
                        workArea
                    );
                    seats.push({
                        x: pixelRect.x,
                        y: pixelRect.y,
                        width: pixelRect.width,
                        height: pixelRect.height,
                    });
                }
            }
            seats.sort(compareTilesInReadingOrder);

            const windows: SeatWindow[] = [];
            for (const win of this._tiledWindowsOn(ws)) {
                const frame = win.get_frame_rect();
                const frameRect = {
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height,
                };
                windows.push({ windowId: win.get_id(), frameRect });

                // the window's own seat by the policy's shared matching
                // rule; -1 (overlaps no seat) leaves seatRect undefined
                const seatIndex = matchRectToSeat(frameRect, seats);
                seatsByWindowId.set(win.get_id(), {
                    window: win,
                    wsIndex: i,
                    seatRect: seatIndex < 0 ? undefined : seats[seatIndex],
                });
            }
            wsSeats.push({ wsIndex: i, seats, windows });
        }
        return { wsSeats, seatsByWindowId };
    }

    private _tiledWindowsOn(ws: Meta.Workspace): Meta.Window[] {
        // tiled-occupancy truth: mirrors TilingManager._getTiledWindowRects
        return filterUnfocusableWindows(ws.list_windows()).filter(
            w =>
                (w as ExtendedWindow).assignedTile !== undefined &&
                !w.minimized &&
                !w.maximizedVertically &&
                !w.maximizedHorizontally
        );
    }
}
