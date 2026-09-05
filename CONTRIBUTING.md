# Contributing

We love your input! We want to make contributing to this project as easy and transparent as possible, whether it's:

- Submitting a fix
- Implementing new features
- Becoming a maintainer

## We Develop with Github
When contributing to this repository, please first discuss with the owners of this repository before making a change. To do so, create a new issue.

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. Run `./scripts/test.sh` — it must pass (lint + build + all tests). This is the same verification the maintainer runs; there is no CI.
3. If you've added code, test it for GNOME Shell versions <= 44 and >= 45 (the build produces both `dist/` and `dist_legacy/`). `npm run dev:wayland` gives a quick nested-Wayland shell; the Vagrant VMs (`npm run dev:vm:gnome46/47/49`) cover specific versions. If you don't know how to do it, don't worry, we can do it for you!
4. If you've changed behaviour, record a demonstration video or describe what's new.
5. Ensure the other features are still working.
6. Make sure your code lints and is formatted (`npm run lint`, `npm run prettier:check`).
7. Issue that pull request! 🥳

## Build & install from source

Prefer the wrapper scripts — they check the required tools (GLib dev tools, etc.) for you:

```bash
./scripts/build.sh     # build dist/ (45+) and dist_legacy/ (42-44)
./scripts/install.sh   # install into ~/.local/share/gnome-shell/extensions (run build first)
./scripts/test.sh      # lint + build + all tests
```

The plain `npm run …` equivalents exist too (`npm run build`, `npm run install:extension`, …). See [AGENTS.md](./AGENTS.md) for the full map of the codebase and build pipeline.

## Any contributions you make will be under the GPLv3 Software License
In short, when you submit code changes, your submissions are understood to be under the same [GPLv3 License](https://github.com/kylelee/AutoTile/blob/main/LICENSE) that covers the project. 
Feel free to contact the maintainers if that's a concern.
