import { GLib, Meta } from '../../gi/ext';
import SignalHandling from '../../utils/signalHandling';
import { logger } from '../../utils/logger';
import {
    filterUnfocusableWindows,
    squaredEuclideanDistance,
} from '../../utils/ui';
import ExtendedWindow from '../tilingsystem/extendedWindow';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class FocusOnCloseManager {
    private readonly _signals: SignalHandling;

    private _unmanagingIds: {
        [windowId: number]: { id: number; win: Meta.Window };
    };

    private _idleId: number = 0;

    private _pendingAnchor: {
        x: number;
        y: number;
        wsIndex: number;
    } | null = null;

    private _debug = logger('FocusOnClose');

    constructor() {
        this._signals = new SignalHandling();
        this._unmanagingIds = {};
    }

    public enable(): void {
        // bootstrap over ALL windows (every workspace, not only the active
        // one) so closes on hidden workspaces are tracked too
        global
            .get_window_actors()
            .forEach(winActor =>
                this._connectUnmanagingHandler(winActor.metaWindow)
            );
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
        if (!window.has_focus()) return; // only the focused window needs a successor
        const ws = window.get_workspace();
        if (!ws) return;

        const rect = window.get_frame_rect();
        const anchor = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            wsIndex: ws.index(),
        };
        this._debug(
            `tiled focused window closing (ws ${anchor.wsIndex}); deferring nearest-tile focus search`
        );

        // never activate synchronously inside the handler: moving focus
        // while mutter's frame is still in progress aborts the compositor
        // (invalidate_top_window_actor_for_views) and X11 EnterNotify would
        // race us. Last-anchor-wins under rapid batch closes: the idle
        // recomputes the candidates from the live windows.
        //
        // CASCADE CONTRACT: this close also triggers FreeTileFiller's
        // cross-workspace merge, whose pass is deferred to an idle too —
        // queued at PRIORITY_DEFAULT_IDLE from the LATER 'unmanaged'
        // signal, while this anchor is recorded on the EARLIER
        // 'unmanaging' one. Both signals fire within mutter's unmanage
        // call stack, so both idles are pending before either dispatches,
        // and PRIORITY_LOW (numerically above DEFAULT_IDLE) guarantees
        // this search runs strictly AFTER the whole merge applied its
        // moves synchronously: "nearest" is computed on the POST-cascade
        // rects and focus is activated once, after the churn. The
        // successor is the window that compacted onto, or was pulled
        // across workspaces into, the freed spot nearest the closed one.
        // Do NOT raise this priority back to PRIORITY_DEFAULT_IDLE: the
        // search would then run on pre-merge geometry and the merge's
        // workspace/tile moves would drop the just-set focus again.
        this._pendingAnchor = anchor;
        if (this._idleId === 0) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idleId = 0;
                const anchorToUse = this._pendingAnchor;
                this._pendingAnchor = null;
                if (anchorToUse) this._focusNearestTiledWindow(anchorToUse);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _focusNearestTiledWindow(anchor: {
        x: number;
        y: number;
        wsIndex: number;
    }): void {
        let best: Meta.Window | undefined;
        let bestWsIndex = 0;

        // Round 1: the closing window's workspace first, across ALL its
        // monitors. Dynamic workspaces may have removed/renumbered it, hence
        // the null check.
        const anchorWs = global.workspaceManager.get_workspace_by_index(
            anchor.wsIndex
        );
        if (anchorWs) {
            for (const win of this._tiledWindowsOn(anchorWs)) {
                if (
                    this._isBetterCandidate(
                        win,
                        anchor.wsIndex,
                        best,
                        bestWsIndex,
                        anchor
                    )
                ) {
                    best = win;
                    bestWsIndex = anchor.wsIndex;
                }
            }
        }

        // Round 2: no tiled window left on the anchor workspace: search all
        // the other workspaces
        if (!best) {
            for (
                let i = 0;
                i < global.workspaceManager.get_n_workspaces();
                i++
            ) {
                if (i === anchor.wsIndex) continue;
                const ws = global.workspaceManager.get_workspace_by_index(i);
                if (!ws) continue;
                for (const win of this._tiledWindowsOn(ws)) {
                    if (
                        this._isBetterCandidate(
                            win,
                            i,
                            best,
                            bestWsIndex,
                            anchor
                        )
                    ) {
                        best = win;
                        bestWsIndex = i;
                    }
                }
            }
        }

        if (best) {
            this._debug(
                `focusing nearest tiled window "${best.title}" (ws ${bestWsIndex})`
            );
            // never pass timestamp 0 (CURRENT_TIME: mutter warns);
            // activateWindow handles the cross-workspace jump internally
            Main.activateWindow(best, global.get_current_time());
        } else {
            this._debug('no tiled window left: keeping default behavior');
        }
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

    private _isBetterCandidate(
        candidate: Meta.Window,
        candidateWsIndex: number,
        best: Meta.Window | undefined,
        bestWsIndex: number,
        anchor: { x: number; y: number; wsIndex: number }
    ): boolean {
        if (!best) return true;

        const r = candidate.get_frame_rect();
        const bestRect = best.get_frame_rect();
        const candidateDistance = squaredEuclideanDistance(
            { x: r.x + r.width / 2, y: r.y + r.height / 2 },
            anchor
        );
        const bestDistance = squaredEuclideanDistance(
            {
                x: bestRect.x + bestRect.width / 2,
                y: bestRect.y + bestRect.height / 2,
            },
            anchor
        );

        if (candidateDistance < bestDistance) return true;
        if (candidateDistance > bestDistance) return false;

        const candidateWsGap = Math.abs(candidateWsIndex - anchor.wsIndex);
        const bestWsGap = Math.abs(bestWsIndex - anchor.wsIndex);
        if (candidateWsGap < bestWsGap) return true;
        if (candidateWsGap > bestWsGap) return false;

        if (r.y < bestRect.y) return true;
        if (r.y > bestRect.y) return false;

        return candidate.get_id() < best.get_id();
    }
}
