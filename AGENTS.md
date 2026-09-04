# AGENTS.md

GNOME Shell extension (TypeScript compiled to GJS JavaScript) providing tiling window management. Supports GNOME Shell 42–50; UUID `autotile@kylelee.github.io`. Types come from `@girs/gnome-shell`.

## Commands

```bash
npm i                      # install deps (package-lock.json is NOT committed)
npm run build              # clean + esbuild + schemas + gresources → dist/ AND dist_legacy/
npm run lint               # eslint on src/ — PRs must pass
npm run lint:fix
npm run prettier:check     # prettier over **/*.{ts,scss}
npm run prettier:fix
npm run install:extension  # copy build into ~/.local/share/gnome-shell/extensions (picks dist vs dist_legacy from local gnome-shell version)
npm run build:package      # zips both builds for release
```

- Build requires GLib dev tools on PATH (`glib-compile-schemas`, `glib-compile-resources`).
- **No test suite, no CI.** Verification = `npm run lint` + `npm run build` + manual testing.
- **No typecheck step exists** — esbuild does not type-check; type errors surface only in the editor/LSP.
- Never edit or commit `dist/` / `dist_legacy/` (gitignored, fully generated — the build even runs `eslint --fix` over them).

### Manual testing

- `npm run dev:wayland` — build + install + launch a nested Wayland GNOME Shell (dummy 1920x1080 monitor) without logging out. Fastest feedback loop.
- Vagrant VMs per GNOME version: `npm run dev:vm:gnome46` / `gnome47` / `gnome49` (also gnome44/48 in Vagrantfile; rsyncs the repo and starts the VM).
- Logs: `npm run logs:follow` (shell process) or `journalctl -f -o cat /usr/bin/gjs` (prefs dialog).

## Build pipeline (`esbuild.mjs`) — understand before touching imports

One source tree produces **two builds**:

- `dist/` — GNOME 45+: ESM with `gi://` / `resource://` imports.
- `dist_legacy/` — GNOME 42–44: a Babel pass rewrites ESM to legacy `imports.gi.*` / `Me.imports.*`, converts top-level `const`/`let`/`class` to `var`, strips exports, and appends init banners/footers.

Consequences:

- Relative imports in `src/` don't need `.js`; the build appends it.
- `// @esbuild-drop-next-line` deletes the next statement in build output — used for version-specific code.
- The `shell-version` array in `resources/metadata.json` is split between the two builds (≤44 → legacy). Supporting a new GNOME version = add it to that array.
- New files under `src/` are picked up automatically (glob entrypoints), but a few known-empty files are excluded from the build after compilation.

## Import discipline (build warns on violations)

The extension process and the prefs dialog are separate processes with disjoint GI namespaces:

- Extension code: import GI namespaces from `src/gi/ext.ts` (Clutter, Meta, Mtk, St, Shell, …). **Never** import `Gdk`/`Gtk`/`Adw` outside prefs.
- `src/prefs.ts`: import only from `src/gi/prefs.ts` (Gdk, Gtk, Adw). **Never** import `Clutter`/`Meta`/`Mtk`/`St`/`Shell` in prefs.
- In `src/extension.ts`, `import { Extension } from './polyfill';` must remain the first import.

## Settings & keybindings

Adding a setting/keybinding touches 4 files — follow the step-by-step recipe in README §"How to add new keybindings": `resources/schemas/org.gnome.shell.extensions.autotile.gschema.xml` → `src/settings/settings.ts` (`SETTING_<NAME>` constant) → `src/keybindings.ts` (signal, `addKeybinding` in `enable`, `removeKeybinding` in `disable`) → `src/prefs.ts` (entry; reuse the schema summary text).

## Conventions

- Prettier: 4-space indent, single quotes, semicolons — run `npm run prettier:fix` before committing.
- ESLint enforces GJS restrictions: `log()`/`logError()` forbidden (use `console.*`), no `Lang.*`, `no-await-in-loop` is an error, unused vars/args must be `_`-prefixed.
- User-visible strings use gettext, domain `autotile`: in the extension process import `t`/`tn`/`tp` from `src/translations.ts`; in prefs use the local `_t()`. Chinese locales (zh_CN/zh_SG → zh_Simplified, zh_TW/zh_HK → zh_Traditional) are resolved in code by `src/utils/moCatalog.ts`, not by system gettext.
- `translations/*.po` are generated — after changing translatable strings run `npm run update-translations` (needs gettext tools and a fresh `dist/`; xgettext runs over the built JS, not src).
- Version lives in both `package.json` and `resources/metadata.json` (`version` + `version-name`) — bump together.
- PRs: branch from `main`, lint clean, test changes on both GNOME ≤44 (legacy build) and ≥45; behavior changes need a demo video or description (CONTRIBUTING.md).

## Orientation

- `src/extension.ts` / `src/prefs.ts` — the two entrypoints (shell process / GTK4+Adw prefs dialog).
- `src/components/` — feature modules (tilingsystem, snapassist, editor, layout, windowBorder, …).
- `src/utils/globalState.ts` — persistent state (layouts per monitor/workspace).
- `resources/` — copied verbatim into builds: schemas, icons, `metadata.json`, compiled locales.
- `gresources/` — gresource bundle spec (compiled by `npm run build:resources`, part of `build`).
- `doc/json-internal-documentation.md` — layout JSON format used by import/export.
