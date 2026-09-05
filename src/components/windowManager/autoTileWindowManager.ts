import { registerGObjectClass } from '../../utils/gjs';
import SignalHandling from '../../utils/signalHandling';
import { GObject, Meta, Mtk, Clutter, Graphene } from '../../gi/ext';

class CachedWindowProperties {
    private _is_initialized: boolean = false;
    public maximized: boolean = false;
    // last-known workspace: must stay an object, dynamic workspace removals
    // renumber survivors without firing per-window signals (an index goes stale)
    public workspace: Meta.Workspace | null = null;

    constructor(window: Meta.Window, manager: AutoTileWindowManager) {
        this.workspace = window.get_workspace();
        this.update(window, manager);
        this._is_initialized = true;
    }

    public update(window: Meta.Window, manager: AutoTileWindowManager) {
        const newMaximized =
            window.maximizedVertically && window.maximizedHorizontally;
        if (this._is_initialized) {
            if (this.maximized && !newMaximized)
                manager.emit('unmaximized', window);
            else if (!this.maximized && newMaximized)
                manager.emit('maximized', window);
        }

        this.maximized = newMaximized;
    }
}

interface WindowWithCachedProps extends Meta.Window {
    __ts_cached: CachedWindowProperties | undefined;
}

export default class AutoTileWindowManager extends GObject.Object {
    static { registerGObjectClass(this, {
        GTypeName: 'AutoTileWindowManager',
        Signals: {
            unmaximized: {
                param_types: [Meta.Window.$gtype],
            },
            maximized: {
                param_types: [Meta.Window.$gtype],
            },
            'window-unmanaged': {
                param_types: [Meta.Window.$gtype],
            },
            'window-workspace-changed': {
                param_types: [
                    Meta.Window.$gtype,
                    GObject.TYPE_INT,
                    GObject.TYPE_INT,
                ], // Meta.Window, old workspace index, new workspace index
            },
        },
    })};

    private static _instance: AutoTileWindowManager | null;

    private readonly _signals: SignalHandling;
    private readonly _windowSignals: SignalHandling;

    static get(): AutoTileWindowManager {
        if (!this._instance) this._instance = new AutoTileWindowManager();

        return this._instance;
    }

    static destroy() {
        if (this._instance) {
            this._instance._signals.disconnect();
            this._instance._windowSignals.disconnect();
            this._instance = null;
        }
    }

    constructor() {
        super();

        this._signals = new SignalHandling();
        this._windowSignals = new SignalHandling();
        global.get_window_actors().forEach((winActor) => {
            (winActor.metaWindow as WindowWithCachedProps).__ts_cached =
                new CachedWindowProperties(winActor.metaWindow, this);
            this._trackWindowSignals(winActor.metaWindow);
        });

        this._signals.connect(
            global.display,
            'window-created',
            (_, window: Meta.Window) => {
                (window as WindowWithCachedProps).__ts_cached =
                    new CachedWindowProperties(window, this);
                this._trackWindowSignals(window);
            },
        );
        this._signals.connect(
            global.windowManager,
            'minimize',
            (_, actor: Meta.WindowActor) => {
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
        this._signals.connect(
            global.windowManager,
            'unminimize',
            (_, actor: Meta.WindowActor) => {
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
        this._signals.connect(
            global.windowManager,
            'size-changed',
            (_, actor: Meta.WindowActor) => {
                // TODO disable default window animations Main.wm.skipNextEffect(actor);
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
    }

    private _trackWindowSignals(window: Meta.Window) {
        const workspaceChangedId = this._windowSignals.connect(
            window,
            'workspace-changed',
            () => {
                this._onWindowWorkspaceChanged(window);
            },
        );
        const unmanagedId = this._windowSignals.connect(
            window,
            'unmanaged',
            () => {
                window.disconnect(workspaceChangedId);
                window.disconnect(unmanagedId);
                this.emit('window-unmanaged', window);
            },
        );
    }

    private _onWindowWorkspaceChanged(window: Meta.Window) {
        const cached = (window as WindowWithCachedProps).__ts_cached;
        if (!cached) return;

        let oldIdx = -1;
        if (cached.workspace) {
            try {
                oldIdx = cached.workspace.index();
            } catch (e) {
                // calling index() on a disposed workspace wrapper throws:
                // reset the tracker to the current workspace and skip emission
                cached.workspace = window.get_workspace();
                console.warn(
                    'AutoTile: tracked workspace of window',
                    window.get_id(),
                    'was disposed, resetting it',
                    e,
                );
                return;
            }
        }

        const newIdx = window.get_workspace()?.index() ?? -1;
        if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx)
            this.emit('window-workspace-changed', window, oldIdx, newIdx);

        // emit happens before this refresh, so handlers could still read the
        // true old workspace object from the cache; null-tracked windows
        // bootstrap their tracker here too
        cached.workspace = window.get_workspace();
    }

    public static easeMoveWindow(params: {
        window: Meta.Window;
        from: Mtk.Rectangle;
        to: Mtk.Rectangle;
        duration: number;
        monitorIndex?: number;
    }): void {
        const winActor =
            params.window.get_compositor_private() as Meta.WindowActor;
        if (!winActor) return;

        // create a clone and hide the window actor
        // then we can change the actual window size
        // without showing that to the user
        const winRect = params.window.get_frame_rect();
        const xExcludingShadow = winRect.x - winActor.get_x();
        const yExcludingShadow = winRect.y - winActor.get_y();
        const staticClone = new Clutter.Clone({
            source: winActor,
            reactive: false,
            scale_x: 1,
            scale_y: 1,
            x: params.from.x,
            y: params.from.y,
            width: params.from.width,
            height: params.from.height,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        });
        global.windowGroup.add_child(staticClone);
        winActor.opacity = 0;
        staticClone.ease({
            x: params.to.x - xExcludingShadow,
            y: params.to.y - yExcludingShadow,
            width: params.to.width + 2 * yExcludingShadow,
            height: params.to.height + 2 * xExcludingShadow,
            duration: params.duration,
            onStopped: () => {
                winActor.opacity = 255;
                winActor.set_scale(1, 1);
                staticClone.destroy();
            },
        });
        // finally move the window
        // the actor has opacity = 0, so this is not seen by the user
        winActor.set_pivot_point(0, 0);
        winActor.set_position(params.to.x, params.to.y);
        winActor.set_size(params.to.width, params.to.height);
        const user_op = false;
        if (params.monitorIndex)
            params.window.move_to_monitor(params.monitorIndex);
        params.window.move_frame(user_op, params.to.x, params.to.y);
        params.window.move_resize_frame(
            user_op,
            params.to.x,
            params.to.y,
            params.to.width,
            params.to.height,
        );
        // while we hide the preview, show the actor to the new position,
        // this has opacity of 0 so it is hidden. Later we immediately swap
        // the animating actor with this
        winActor.show();
    }
}
