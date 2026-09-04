const node = `<node>
    <interface name="org.gnome.Shell.Extensions.AutoTile">
        <method name="openLayoutEditor" />
    </interface>
</node>`;

import { Gio } from './gi/ext';

export default class DBus {
    private _dbus: Gio.DBusExportedObject | null;

    constructor() {
        this._dbus = null;
    }

    public enable(ext: unknown) {
        if (this._dbus) return;

        try {
            this._dbus = Gio.DBusExportedObject.wrapJSObject(node, ext);
            this._dbus.export(
                Gio.DBus.session,
                '/org/gnome/Shell/Extensions/AutoTile',
            );
        } catch (e) {
            console.error('[autotile]', '[dbus]', e);
            this._dbus = null;
        }
    }

    public disable() {
        this._dbus?.flush();
        this._dbus?.unexport();
        this._dbus = null;
    }
}
