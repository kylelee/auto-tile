// entry point file for all the translation related stuff. It is easier for the build system to
// work with this file only to support GNOME shells <= 44 (e.g converting the imports)
// Note: DO NOT import this file from prefs.ts or any preferences related file

import * as ExtensionUtilsModule from 'resource:///org/gnome/shell/misc/extensionUtils.js';
// the import below is rewritten by the legacy build into
// `const { gettext: _, ngettext, pgettext } = imports.misc.extensionUtils`:
// keep the `gettext as _` alias and these three names exactly as they are
import { gettext as _, ngettext, pgettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Gio, GLib } from './gi/ext';
import { MoCatalog, chineseCatalogFor } from './utils/moCatalog';

const ExtensionUtils = ExtensionUtilsModule as unknown as {
    getCurrentExtension?: () => {
        metadata?: { 'gettext-domain'?: string };
        path?: string;
        dir?: { get_path?: () => string | null };
    } | null;
};

// Chinese catalogs live under script-based names (zh_Simplified, zh_Traditional)
// that the system gettext cannot resolve: it only probes the locale names from
// the environment (zh_CN, zh_TW, ...). Resolve them manually here and keep
// every other locale on the system gettext.
let chineseCatalog: MoCatalog | null | undefined;

function getChineseCatalog(): MoCatalog | null {
    if (chineseCatalog !== undefined) return chineseCatalog;

    chineseCatalog = null;
    try {
        const extension = ExtensionUtils.getCurrentExtension?.() ?? null;
        const domain = extension?.metadata?.['gettext-domain'];
        const extensionPath = extension?.path ?? extension?.dir?.get_path?.() ?? null;
        if (!domain || !extensionPath) return null;

        for (const name of GLib.get_language_names()) {
            const catalogName = chineseCatalogFor(name);
            if (!catalogName) continue;
            const [, contents] = Gio.File.new_for_path(
                `${extensionPath}/locale/${catalogName}/LC_MESSAGES/${domain}.mo`,
            ).load_contents(null);
            const catalog = MoCatalog.fromBytes(contents);
            if (catalog) {
                chineseCatalog = catalog;
                break;
            }
        }
    } catch (e) {
        console.warn('AutoTile: failed to load the Chinese translation catalog', e);
    }
    return chineseCatalog;
}

export function t(msgid: string): string {
    return getChineseCatalog()?.gettext(msgid) ?? _(msgid);
}

export function tn(singular: string, plural: string, n: number): string {
    return (
        getChineseCatalog()?.ngettext(singular, plural, n) ??
        ngettext(singular, plural, n)
    );
}

export function tp(context: string, msgid: string): string {
    return getChineseCatalog()?.pgettext(context, msgid) ?? pgettext(context, msgid);
}
