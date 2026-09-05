
/*!
 * AutoTile: advanced and modern window management for GNOME
 *
 * Copyright (C) 2025 Domenico Ferraro
 * Copyright (C) 2026 Kyle Lee
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Extension } from './polyfill'; // must stay at the top
import { Gio, GLib, Meta } from './gi/ext';
import { logger } from './utils/logger';
import {
    filterUnfocusableWindows,
    getMonitors,
    getWindows,
    squaredEuclideanDistance,
} from './utils/ui';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { TilingManager } from './components/tilingsystem/tilingManager';
import Settings from './settings/settings';
import SignalHandling from './utils/signalHandling';
import GlobalState from './utils/globalState';
import Indicator from './indicator/indicator';
import { ExtensionMetadata } from 'resource:///org/gnome/shell/extensions/extension.js';
import DBus from './dbus';
import { KeyBindingsDirection, FocusSwitchDirection } from './keybindings';
import KeyBindings from './keybindings';
import SettingsOverride from './settings/settingsOverride';
import { ResizingManager } from './components/tilingsystem/resizeManager';
import { withAutoFillSuppressed } from './components/tilingsystem/autoFillSuppression';
import OverriddenWindowMenu from './components/window_menu/overriddenWindowMenu';
import Tile from './components/layout/Tile';
import { WindowBorderManager } from './components/windowBorder/windowBorderManager';
import AutoTileWindowManager from './components/windowManager/autoTileWindowManager';
import ExtendedWindow from './components/tilingsystem/extendedWindow';
import OverriddenAltTab from './components/altTab/overriddenAltTab';
import { LayoutSwitcherPopup } from './components/layoutSwitcher/layoutSwitcher';
import { unmaximizeWindow } from './utils/gnomesupport';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { RaiseTogetherManager } from './components/raiseTogether/raiseTogetherManager';
import { FocusOnCloseManager } from './components/focusOnClose/focusOnCloseManager';

const debug = logger('extension');

export default class AutoTileExtension extends Extension {
    private _indicator: Indicator | null;
    private _tilingManagers: TilingManager[];
    private _fractionalScalingEnabled: boolean;
    private _dbus: DBus | null;
    private _signals: SignalHandling | null;
    private _keybindings: KeyBindings | null;
    private _resizingManager: ResizingManager | null;
    private _windowBorderManager: WindowBorderManager | null;
    private _raiseTogetherManager: RaiseTogetherManager | null;
    private _focusOnCloseManager: FocusOnCloseManager | null;

    constructor(metadata: ExtensionMetadata) {
        super(metadata);
        this._signals = null;
        this._fractionalScalingEnabled = false;
        this._tilingManagers = [];
        this._indicator = null;
        this._dbus = null;
        this._keybindings = null;
        this._resizingManager = null;
        this._windowBorderManager = null;
        this._raiseTogetherManager = null;
        this._focusOnCloseManager = null;
    }

    createIndicator() {
        this._indicator = new Indicator(this.path, this.uuid);
        this._indicator.enableScaling = !this._fractionalScalingEnabled;
        this._indicator.enable();
        this._signals?.connect(this._indicator, 'open-preferences', () => this.openPreferences());
    }

    private _validateSettings() {
        if (Settings.LAST_VERSION_NAME_INSTALLED === '17.0') {
            debug('apply compatibility changes');
            // if users enabled window border, they set it custom in the past, so enable the custom border
            // keep using the custom border instead of using the accent color by default
            Settings.WINDOW_USE_CUSTOM_BORDER_COLOR =
                Settings.ENABLE_WINDOW_BORDER;
        }

        if (
            Settings.LAST_VERSION_NAME_INSTALLED !== '17.3' &&
            Settings.LAST_VERSION_NAME_INSTALLED !== '18.0'
        ) {
            debug('apply compatibility changes for 17.3');

            // if users used cycle layouts keybinding, enable the backwards one
            Settings.gioSetting.set_strv(Settings.SETTING_CYCLE_LAYOUTS_BACKWARD, [
                `<Shift>${Settings.gioSetting.get_strv(Settings.SETTING_CYCLE_LAYOUTS)}`
            ]);
        }
    }

    private _onInstall() {
        const GNOME_VERSION_MAJOR = Number(
            Config.PACKAGE_VERSION.split('.')[0],
        );
        // Force use of customer border color on GNOME < 47 since accent colors are not available
        Settings.WINDOW_USE_CUSTOM_BORDER_COLOR = GNOME_VERSION_MAJOR < 47;
    }

    enable(): void {
        if (this._signals) this._signals.disconnect();
        this._signals = new SignalHandling();

        Settings.initialize(this.getSettings());
        if (Settings.LAST_VERSION_NAME_INSTALLED === '0') {
            this._onInstall();

            // Setting used for compatibility changes if necessary
            if (this.metadata['version-name']) {
                Settings.LAST_VERSION_NAME_INSTALLED =
                    this.metadata['version-name'] || '0';
            }
        }

        this._validateSettings();

        // force initialization and tracking of windows
        AutoTileWindowManager.get();

        this._fractionalScalingEnabled = this._isFractionalScalingEnabled(
            new Gio.Settings({ schema: 'org.gnome.mutter' }),
        );

        if (this._keybindings) this._keybindings.destroy();
        this._keybindings = new KeyBindings(this.getSettings());

        // disable native edge tiling
        if (Settings.ACTIVE_SCREEN_EDGES) {
            SettingsOverride.get().override(
                new Gio.Settings({ schemaId: 'org.gnome.mutter' }),
                'edge-tiling',
                new GLib.Variant('b', false),
            );
        }

        if (Main.layoutManager._startingUp) {
            this._signals.connect(
                Main.layoutManager,
                'startup-complete',
                () => {
                    this._createTilingManagers();
                    this._setupSignals();
                },
            );
        } else {
            this._createTilingManagers();
            this._setupSignals();
        }

        this._resizingManager = new ResizingManager();
        this._resizingManager.enable();

        if (this._windowBorderManager) this._windowBorderManager.destroy();
        this._windowBorderManager = new WindowBorderManager(
            !this._fractionalScalingEnabled,
        );
        this._windowBorderManager.enable();

        this._raiseTogetherManager = new RaiseTogetherManager();
        this._raiseTogetherManager.enable();

        if (this._focusOnCloseManager) this._focusOnCloseManager.destroy();
        this._focusOnCloseManager = new FocusOnCloseManager();
        this._focusOnCloseManager.enable();

        this.createIndicator();

        if (this._dbus) this._dbus.disable();
        this._dbus = new DBus();
        this._dbus.enable(this);

        if (Settings.OVERRIDE_WINDOW_MENU) OverriddenWindowMenu.enable();
        if (Settings.OVERRIDE_ALT_TAB) OverriddenAltTab.enable();

        debug('extension is enabled');
    }

    public openLayoutEditor() {
        this._indicator?.openLayoutEditor();
    }

    private _createTilingManagers() {
        debug('building a tiling manager for each monitor');
        this._tilingManagers.forEach((tm) => tm.destroy());
        this._tilingManagers = getMonitors().map(
            (monitor) =>
                new TilingManager(
                    monitor,
                    !this._fractionalScalingEnabled,
                    (i: number) => this._tilingManagers[i],
                ),
        );
        this._tilingManagers.forEach((tm) => tm.enable());
    }

    private _setupSignals() {
        if (!this._signals) return;

        this._signals.connect(global.display, 'workareas-changed', () => {
            const allMonitors = getMonitors();
            if (this._tilingManagers.length !== allMonitors.length) {
                // a monitor was disconnected or a new one was connected
                GlobalState.get().validate_selected_layouts();
                // finally build a tiling manager for each monitor
                this._createTilingManagers();
            } else {
                // the number of monitors is the same, so update the workarea
                this._tilingManagers.forEach((tm, index) => {
                    tm.workArea =
                        Main.layoutManager.getWorkAreaForMonitor(index);
                });
            }
        });

        let userGrabbingWindow = false;
        this._signals.connect(global.display, 'grab-op-begin', () => {
            userGrabbingWindow = true;
        });
        this._signals.connect(global.display, 'grab-op-end', () => {
            userGrabbingWindow = false;
        });
        this._signals.connect(
            global.display,
            'window-entered-monitor',
            (
                _display: Meta.Display,
                monitorIndex: number,
                window: Meta.Window
            ) => {
                if (userGrabbingWindow) return; // mid-drag: do not fight the user
                this._tilingManagers[monitorIndex]?.onWindowEnteredMonitor(
                    window
                );
            }
        );
        this._signals.connect(
            global.display,
            'window-left-monitor',
            (
                _display: Meta.Display,
                monitorIndex: number,
                window: Meta.Window
            ) => {
                if (userGrabbingWindow) {
                    debug('skip monitor-left auto-fill: user is dragging');
                    return;
                }
                if (!(window as ExtendedWindow).assignedTile) return;
                const oldMonitorTilingManager =
                    this._tilingManagers[monitorIndex];
                if (!oldMonitorTilingManager) return;
                // tile-lock enforcement while auto-fill is on: here the
                // geometry legit test DOES govern (a monitor move can leave
                // the rect off-tile) and the suppression gate inside exempts
                // keyboard swap legs
                // a dying window emits monitor signals during teardown with
                // its workspace already torn to null: never enforce on it
                // (compositor abort on not-settled windows)
                if (window.get_workspace()) {
                    const assignedTile = (window as ExtendedWindow).assignedTile;
                    oldMonitorTilingManager.enforceTiledPlacement(window, {
                        window,
                        tiled: true,
                        monitorIndex,
                        ws: window.get_workspace() ?? undefined,
                        wsIndex: window.get_workspace()?.index(),
                        tile: assignedTile
                            ? new Tile({ ...assignedTile })
                            : undefined,
                    });
                }
                // monitorIndex is the OLD monitor: this signal fires before
                // 'window-entered-monitor'; exclude the transitioning window
                // so mid-transition occupancy is not confused
                oldMonitorTilingManager.scheduleAutoFill(
                    window.get_workspace()?.index() ?? 0,
                    window
                );
            }
        );

        this._signals.connect(
            new Gio.Settings({ schema: 'org.gnome.mutter' }),
            'changed::experimental-features',
            (_mutterSettings: Gio.Settings) => {
                if (!_mutterSettings) return;

                const fractionalScalingEnabled =
                    this._isFractionalScalingEnabled(_mutterSettings);

                if (this._fractionalScalingEnabled === fractionalScalingEnabled)
                    return;

                this._fractionalScalingEnabled = fractionalScalingEnabled;
                this._createTilingManagers();
                if (this._indicator) {
                    this._indicator.enableScaling =
                        !this._fractionalScalingEnabled;
                }
                if (this._windowBorderManager)
                    this._windowBorderManager.destroy();
                this._windowBorderManager = new WindowBorderManager(
                    !this._fractionalScalingEnabled,
                );
                this._windowBorderManager.enable();
            },
        );

        if (this._keybindings) {
            this._signals.connect(
                this._keybindings,
                'move-window',
                (
                    kb: KeyBindings,
                    dp: Meta.Display,
                    dir: KeyBindingsDirection,
                ) => {
                    this._onKeyboardMoveWin(dp, dir, false);
                },
            );
            this._signals.connect(
                this._keybindings,
                'span-window',
                (
                    kb: KeyBindings,
                    dp: Meta.Display,
                    dir: KeyBindingsDirection,
                ) => {
                    this._onKeyboardMoveWin(dp, dir, true);
                },
            );
            this._signals.connect(
                this._keybindings,
                'span-window-all-tiles',
                (kb: KeyBindings, dp: Meta.Display) => {
                    const window = dp.focus_window;
                    const monitorIndex = window.get_monitor();
                    const manager = this._tilingManagers[monitorIndex];
                    if (manager) manager.onSpanAllTiles(window);
                },
            );
            this._signals.connect(
                this._keybindings,
                'untile-window',
                this._onKeyboardUntileWindow.bind(this),
            );
            this._signals.connect(
                this._keybindings,
                'move-window-center',
                (kb: KeyBindings, dp: Meta.Display) => {
                    this._onKeyboardMoveWin(
                        dp,
                        KeyBindingsDirection.NODIRECTION,
                        false,
                    );
                },
            );
            this._signals.connect(
                this._keybindings,
                'focus-window',
                (
                    kb: KeyBindings,
                    dp: Meta.Display,
                    dir: FocusSwitchDirection,
                ) => {
                    this._onKeyboardFocusWin(dp, dir);
                },
            );
            this._signals.connect(
                this._keybindings,
                'focus-window-direction',
                (
                    kb: KeyBindings,
                    dp: Meta.Display,
                    dir: KeyBindingsDirection,
                ) => {
                    this._onKeyboardFocusWinDirection(dp, dir);
                },
            );
            this._signals.connect(
                this._keybindings,
                'highlight-current-window',
                (kb: KeyBindings, dp: Meta.Display) => {
                    const focus_window = dp.get_focus_window();
                    getWindows(
                        global.workspaceManager.get_active_workspace(),
                    ).forEach((win) => {
                        if (win !== focus_window && win.can_minimize())
                            win.minimize();
                    });
                    Main.activateWindow(
                        focus_window,
                        global.get_current_time(),
                    );
                },
            );
            this._signals.connect(
                this._keybindings,
                'cycle-layouts',
                (
                    kb: KeyBindings,
                    dp: Meta.Display,
                    currentAction: number,
                    mask: number
                ) => {
                    const backwardAction = kb.cycleLayoutsBackwardAction;
                    const switcher = new LayoutSwitcherPopup(
                        kb.cycleLayoutsAction!,
                        backwardAction!,
                        !this._fractionalScalingEnabled,
                    );

                    if (!switcher.show(currentAction === backwardAction, '', mask)) switcher.destroy();
                },
            );
        }

        // when AutoTile's edge-tiling is enabled/disable
        // then enable/disable native edge-tiling
        this._signals.connect(
            Settings,
            Settings.KEY_ACTIVE_SCREEN_EDGES,
            () => {
                const gioSettings = new Gio.Settings({
                    schemaId: 'org.gnome.mutter',
                });
                if (Settings.ACTIVE_SCREEN_EDGES) {
                    debug('disable native edge tiling');
                    // disable native edge tiling
                    SettingsOverride.get().override(
                        gioSettings,
                        'edge-tiling',
                        new GLib.Variant('b', false),
                    );
                } else {
                    // bring back the value of native edge tiling
                    debug('bring back native edge tiling');
                    SettingsOverride.get().restoreKey(
                        gioSettings,
                        'edge-tiling',
                    );
                }
            },
        );

        // enable/disable window menu from preferences
        this._signals.connect(
            Settings,
            Settings.KEY_OVERRIDE_WINDOW_MENU,
            () => {
                if (Settings.OVERRIDE_WINDOW_MENU)
                    OverriddenWindowMenu.enable();
                else OverriddenWindowMenu.disable();
            },
        );

        // tile a window when a tile or a button is clicked from the window menu
        this._signals.connect(
            OverriddenWindowMenu,
            'tile-clicked',
            (_, tile: Tile, window: Meta.Window) => {
                const monitorIndex = window.get_monitor();
                const manager = this._tilingManagers[monitorIndex];
                if (manager) manager.onTileFromWindowMenu(tile, window);
            },
        );

        // enable/disable addition of tiled windows at the end of ALT+TAB from preferences
        this._signals.connect(Settings, Settings.KEY_OVERRIDE_ALT_TAB, () => {
            if (Settings.OVERRIDE_ALT_TAB) OverriddenAltTab.enable();
            else OverriddenAltTab.disable();
        });

        /* todo move maximized to workspace
        this._signals.connect(
            global.window_manager,
            'size-change',
            this._moveMaximizedToWorkspace.bind(this),
        );

        this._signals.connect(
            global.window_manager,
            'size-changed',
            this._onSizeChanged.bind(this),
        );*/
    }

    /* todo private _moveMaximizedToWorkspace(
        wm: Shell.WM,
        winActor: Meta.WindowActor,
        change: Meta.SizeChange,
    ) {
        const window = winActor.metaWindow;
        if (
            window.wmClass === null ||
            change !== Meta.SizeChange.MAXIMIZE || // handle maximize changes only
            (window.maximizedHorizontally && window.maximizedVertically) || // handle maximized window only
            window.is_attached_dialog() || // skip dialogs
            window.is_on_all_workspaces() ||
            window.windowType !== Meta.WindowType.NORMAL || // handle normal windows only
            window.wmClass === 'gjs'
        )
            return;

        const prevWorkspace = window.get_workspace();
        // if it is the only window in the workspace, no new workspace is needed
        if (
            !prevWorkspace
                .list_windows()
                .find(
                    (otherWin) =>
                        otherWin !== window &&
                        otherWin.windowType === Meta.WindowType.NORMAL &&
                        !otherWin.is_always_on_all_workspaces() &&
                        otherWin.wmClass !== null &&
                        otherWin.wmClass !== 'gjs',
                )
        )
            return;

        // disable GNOME default fade out animation
        // @ts-expect-error Main.wm has "_sizeChangeWindowDone" function
        Main.wm._sizeChangeWindowDone(global.windowManager, winActor);

        const wasActive = prevWorkspace.active;
        // create a new workspace, do not focus it
        const newWorkspace = global.workspace_manager.append_new_workspace(
            false,
            global.get_current_time(),
        );
        // place the workspace after the current one
        global.workspace_manager.reorder_workspace(
            newWorkspace,
            prevWorkspace.index() + 1,
        );
        // queue focus the workspace, focusing the window too. This will trigger workspace slide-in animation
        if (wasActive) window._queue_focus_ws = newWorkspace;
    }

    private _onSizeChanged(wm: Shell.WM, winActor: Meta.WindowActor) {
        const window = winActor.metaWindow;

        if (!window._queue_focus_ws) return;
        const ws = window._queue_focus_ws;
        delete window._queue_focus_ws;

        console.log(`_onSizeChanged ${ws}`);
        // move the window
        ws.activate_with_focus(window, global.get_current_time());
        window.change_workspace(ws);
        // todo check the following
        // If the selected window is on a different workspace, we don't
        // want it to disappear, then slide in with the workspace; instead,
        // always activate it on the active workspace ...
        activeWs.activate_with_focus(window, global.get_current_time());

        // ... then slide it over to the original workspace if necessary
        Main.wm.actionMoveWindow(window, ws);

    }*/

    private _onKeyboardMoveWin(
        display: Meta.Display,
        direction: KeyBindingsDirection,
        spanFlag: boolean,
    ) {
        // The keyboard move/swap command must never trigger the
        // auto-fill cascade: its cross-monitor legs fire the
        // monitor-left and workspace-changed signals synchronously,
        // and the suppression flag is checked at signal time.
        withAutoFillSuppressed(() => {
            const focus_window = display.get_focus_window();
            if (
                !focus_window ||
                !focus_window.has_focus() ||
                (focus_window.get_wm_class() &&
                    focus_window.get_wm_class() === 'gjs') ||
                focus_window.is_fullscreen()
            )
                return;

            // if the window is maximized, it cannot be spanned
            if (
                (focus_window.maximizedHorizontally ||
                    focus_window.maximizedVertically) &&
                spanFlag
            )
                return;

            // handle unmaximize of maximized window
            if (
                (focus_window.maximizedHorizontally ||
                    focus_window.maximizedVertically) &&
                direction === KeyBindingsDirection.DOWN
            ) {
                unmaximizeWindow(focus_window);
                return;
            }

            const monitorTilingManager =
                this._tilingManagers[focus_window.get_monitor()];
            if (!monitorTilingManager) return;

            if (
                Settings.ENABLE_AUTO_TILING &&
                (focus_window.maximizedHorizontally ||
                    focus_window.maximizedVertically)
            ) {
                unmaximizeWindow(focus_window);
                return;
            }

            let displayDirection = Meta.DisplayDirection.DOWN;
            switch (direction) {
                case KeyBindingsDirection.LEFT:
                    displayDirection = Meta.DisplayDirection.LEFT;
                    break;
                case KeyBindingsDirection.RIGHT:
                    displayDirection = Meta.DisplayDirection.RIGHT;
                    break;
                case KeyBindingsDirection.UP:
                    displayDirection = Meta.DisplayDirection.UP;
                    break;
            }
            const neighborMonitorIndex = display.get_monitor_neighbor_index(
                focus_window.get_monitor(),
                displayDirection,
            );

            // no monitor in this direction: extend the unified "next tile
            // in the direction" model to the adjacent WORKSPACE (LEFT/RIGHT
            // only, never wrapping) before the clamped same-monitor move —
            // mirrors the directional focus feature's neighbor-workspace
            // search. Declines (floating/maximized mover, not at the edge
            // column, workspace boundary) fall through to the legacy path.
            if (
                neighborMonitorIndex === -1 &&
                !spanFlag &&
                (direction === KeyBindingsDirection.LEFT ||
                    direction === KeyBindingsDirection.RIGHT) &&
                monitorTilingManager.onKeyboardMoveWindowAcrossWorkspaces(
                    focus_window,
                    direction,
                )
            )
                return;

            const success = monitorTilingManager.onKeyboardMoveWindow(
                focus_window,
                direction,
                false,
                spanFlag,
                neighborMonitorIndex === -1, // clamp if there is NOT a monitor in this direction
                // for UP, defer the at-edge maximize to the neighbor fallback so a
                // free tile on the monitor above wins first (user decision)
                {
                    deferEdgeToNeighbor:
                        direction === KeyBindingsDirection.UP &&
                        neighborMonitorIndex !== -1,
                },
            );

            if (
                success ||
                direction === KeyBindingsDirection.NODIRECTION ||
                neighborMonitorIndex === -1
            )
                return;

            let wasMaximizedBeforeMove = false;
            // if the window is maximized, direction is UP and there is a monitor above, minimize the window
            if (
                (focus_window.maximizedHorizontally ||
                    focus_window.maximizedVertically) &&
                direction === KeyBindingsDirection.UP
            ) {
                Main.wm.skipNextEffect(focus_window.get_compositor_private());
                unmaximizeWindow(focus_window);
                (focus_window as ExtendedWindow).assignedTile = undefined;
                wasMaximizedBeforeMove = true;
            }

            const neighborTilingManager =
                this._tilingManagers[neighborMonitorIndex];
            if (!neighborTilingManager) return;

            neighborTilingManager.onKeyboardMoveWindow(
                focus_window,
                direction,
                true,
                spanFlag,
                false,
                {
                    // non-maximized UP edge: free tile or (inside the neighbor
                    // manager) maximize — no nearest-tile stacking. Maximized
                    // origin keeps the historical free-tile-else-nearest-tile.
                    freeTileOnly:
                        direction === KeyBindingsDirection.UP &&
                        !wasMaximizedBeforeMove,
                },
            );
        });
    }

    private _onKeyboardFocusWinDirection(
        display: Meta.Display,
        direction: KeyBindingsDirection | FocusSwitchDirection,
    ) {
        const focus_window = display.get_focus_window();

        if (
            !focus_window ||
            !focus_window.has_focus() ||
            (focus_window.get_wm_class() &&
                focus_window.get_wm_class() === 'gjs')
        )
            return;

        let bestWindow: Meta.Window | undefined;
        let bestWindowDistance = -1;

        const focusWindowRect = focus_window.get_frame_rect();
        const focusWindowCenter = {
            x: focusWindowRect.x + focusWindowRect.width / 2,
            y: focusWindowRect.y + focusWindowRect.height / 2,
        };

        const windowList = filterUnfocusableWindows(
            focus_window.get_workspace().list_windows(),
        );
        const onlyTiledWindows = Settings.ENABLE_DIRECTIONAL_FOCUS_TILED_ONLY;

        windowList
            .filter((win) => {
                if (win === focus_window || win.minimized) return false;
                if (
                    onlyTiledWindows &&
                    (win as ExtendedWindow).assignedTile === undefined
                )
                    return false;

                const winRect = win.get_frame_rect();
                switch (direction) {
                    case KeyBindingsDirection.RIGHT:
                        return winRect.x > focusWindowRect.x;
                    case KeyBindingsDirection.LEFT:
                        return winRect.x < focusWindowRect.x;
                    case KeyBindingsDirection.UP:
                        return winRect.y < focusWindowRect.y;
                    case KeyBindingsDirection.DOWN:
                        return winRect.y > focusWindowRect.y;
                }
                return false;
            })
            .forEach((win) => {
                const winRect = win.get_frame_rect();
                const winCenter = {
                    x: winRect.x + winRect.width / 2,
                    y: winRect.y + winRect.height / 2,
                };

                const euclideanDistance = squaredEuclideanDistance(
                    winCenter,
                    focusWindowCenter,
                );

                if (
                    !bestWindow ||
                    euclideanDistance < bestWindowDistance ||
                    (euclideanDistance === bestWindowDistance &&
                        bestWindow.get_frame_rect().y > winRect.y)
                ) {
                    bestWindow = win;
                    bestWindowDistance = euclideanDistance;
                }
            });

        if (!bestWindow) {
            // no window along the direction in this workspace: search the
            // neighbor workspaces along the same direction
            bestWindow = this._findWindowInNeighborWorkspaces(
                focus_window,
                direction,
            );
        }

        if (!bestWindow) return;

        bestWindow.activate(global.get_current_time());
    }

    /**
     * Search the workspaces after the one of focusWindow, along direction,
     * for the nearest workspace containing at least one selectable window.
     * Only the horizontal directions move across workspaces. The selected
     * window is the one on the tile nearest to the source workspace: the
     * leftmost for RIGHT, the rightmost for LEFT. Windows on the same edge
     * are ranked by vertical proximity to the focused window.
     *
     * Workspaces are never wrapped around at the ends.
     */
    private _findWindowInNeighborWorkspaces(
        focusWindow: Meta.Window,
        direction: KeyBindingsDirection | FocusSwitchDirection,
    ): Meta.Window | undefined {
        if (
            direction !== KeyBindingsDirection.LEFT &&
            direction !== KeyBindingsDirection.RIGHT
        )
            return undefined;

        const step = direction === KeyBindingsDirection.RIGHT ? 1 : -1;
        const startIndex = focusWindow.get_workspace().index() + step;
        const nWorkspaces = global.workspaceManager.get_n_workspaces();
        const onlyTiledWindows = Settings.ENABLE_DIRECTIONAL_FOCUS_TILED_ONLY;
        const focusRect = focusWindow.get_frame_rect();
        const focusWindowCenterY = focusRect.y + focusRect.height / 2;

        for (
            let wsIndex = startIndex;
            wsIndex >= 0 && wsIndex < nWorkspaces;
            wsIndex += step
        ) {
            const workspace =
                global.workspaceManager.get_workspace_by_index(wsIndex);
            if (!workspace) continue;

            let candidate: Meta.Window | undefined;
            let candidateEdge = 0; // x of the tile edge nearest to the source workspace
            let candidateCenterDistanceY = 0;

            filterUnfocusableWindows(workspace.list_windows()).forEach((win) => {
                if (win === focusWindow || win.minimized) return;
                if (
                    onlyTiledWindows &&
                    (win as ExtendedWindow).assignedTile === undefined
                )
                    return;

                const winRect = win.get_frame_rect();
                const edge =
                    direction === KeyBindingsDirection.RIGHT
                        ? winRect.x
                        : winRect.x + winRect.width;
                const centerDistanceY = Math.abs(
                    winRect.y + winRect.height / 2 - focusWindowCenterY,
                );

                // RIGHT searches the leftmost tile, LEFT the rightmost one
                const nearerEdge =
                    direction === KeyBindingsDirection.RIGHT
                        ? edge < candidateEdge
                        : edge > candidateEdge;

                if (
                    !candidate ||
                    nearerEdge ||
                    (edge === candidateEdge &&
                        centerDistanceY < candidateCenterDistanceY)
                ) {
                    candidate = win;
                    candidateEdge = edge;
                    candidateCenterDistanceY = centerDistanceY;
                }
            });

            if (candidate) return candidate;
        }

        return undefined;
    }

    private _onKeyboardFocusWin(
        display: Meta.Display,
        direction: FocusSwitchDirection,
    ) {
        const focus_window = display.get_focus_window();

        if (
            !focus_window ||
            !focus_window.has_focus() ||
            (focus_window.get_wm_class() &&
                focus_window.get_wm_class() === 'gjs')
        )
            return;

        const windowList = filterUnfocusableWindows(
            focus_window.get_workspace().list_windows(),
        );
        if (windowList.length === 0) return;
        const focusParent = focus_window.get_transient_for() || focus_window;
        const focusedIdx = windowList.findIndex((win) => {
            // in case we are iterating over a modal dialog for our focused window
            return win === focusParent;
        });

        let nextIndex = -1;
        switch (direction) {
            case FocusSwitchDirection.PREV:
                if (focusedIdx === -1) return;
                if (focusedIdx === 0 && !Settings.WRAPAROUND_FOCUS) return;
                if (focusedIdx === 0 && Settings.WRAPAROUND_FOCUS) {
                    windowList[windowList.length - 1].activate(
                        global.get_current_time(),
                    );
                } else {
                    windowList[focusedIdx - 1].activate(
                        global.get_current_time(),
                    );
                }
                break;
            case FocusSwitchDirection.NEXT:
                if (focusedIdx === -1) return;
                nextIndex = (focusedIdx + 1) % windowList.length;
                if (nextIndex > 0 || Settings.WRAPAROUND_FOCUS)
                    windowList[nextIndex].activate(global.get_current_time());
                break;
        }
    }

    private _onKeyboardUntileWindow(kb: KeyBindings, display: Meta.Display) {
        const focus_window = display.get_focus_window();
        if (
            !focus_window ||
            !focus_window.has_focus() ||
            focus_window.windowType !== Meta.WindowType.NORMAL ||
            (focus_window.get_wm_class() &&
                focus_window.get_wm_class() === 'gjs')
        )
            return;

        // if the window is maximized, unmaximize it
        if (
            focus_window.maximizedHorizontally ||
            focus_window.maximizedVertically
        )
            unmaximizeWindow(focus_window);

        const monitorTilingManager =
            this._tilingManagers[focus_window.get_monitor()];
        if (!monitorTilingManager) return;

        monitorTilingManager.onUntileWindow(focus_window, true);
    }

    private _isFractionalScalingEnabled(
        _mutterSettings: Gio.Settings,
    ): boolean {
        return (
            _mutterSettings
                .get_strv('experimental-features')
                .find(
                    (feat) =>
                        feat === 'scale-monitor-framebuffer' ||
                        feat === 'x11-randr-fractional-scaling',
                ) !== undefined
        );
    }

    disable(): void {
        // bring back overridden keybindings
        this._keybindings?.destroy();
        this._keybindings = null;

        // destroy indicator
        this._indicator?.destroy();
        this._indicator = null;

        // destroy tiling managers
        this._tilingManagers.forEach((tm) => tm.destroy());
        this._tilingManagers = [];

        // disconnect signals
        this._signals?.disconnect();
        this._signals = null;

        this._resizingManager?.destroy();
        this._resizingManager = null;

        this._windowBorderManager?.destroy();
        this._windowBorderManager = null;

        this._raiseTogetherManager?.destroy();
        this._raiseTogetherManager = null;

        this._focusOnCloseManager?.destroy();
        this._focusOnCloseManager = null;

        // disable dbus
        this._dbus?.disable();
        this._dbus = null;

        this._fractionalScalingEnabled = false;

        OverriddenWindowMenu.destroy();
        OverriddenAltTab.destroy();

        // restore native edge tiling and all the overridden settings
        SettingsOverride.destroy();

        // destroy state and settings
        GlobalState.destroy();
        Settings.destroy();
        AutoTileWindowManager.destroy();

        debug('extension is disabled');
    }
}
