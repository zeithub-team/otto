# Building the Windows installer

```bash
npm install
npm run dist:local -w @otto/desktop
```

The result is `apps/desktop/release/v<version>/zeithub-otto-setup-<version>.exe`.
The version comes from `apps/desktop/package.json`.

## What happens

1. The server and the web UI are built.
2. `electron-builder --dir` packs the app into `release/win-unpacked/` without running anything.
3. `makensis` wraps it with `apps/desktop/installer/standalone.nsi`, our own installer script
   with the dark wizard, theme and language choice.

We don't use electron-builder's NSIS target directly: its generated uninstaller is executed
during the build, and Windows Smart App Control blocks that on some machines.

`makensis` is taken from the electron-builder cache or a regular NSIS install. If neither is
there, run `npm run dist:win` once — it downloads NSIS.

## Before you build

- Close any running Otto started from `release/` — Windows locks its files.
- Wizard images live in `apps/desktop/build/`, the icon in `apps/desktop/assets/icon.ico`.

## Publishing a release

```bash
git tag v0.1.5 && git push origin main --tags
gh release create v0.1.5 apps/desktop/release/v0.1.5/zeithub-otto-setup-0.1.5.exe \
  --repo zeithub-team/otto --title "zeithub.otto 0.1.5" --notes-file notes.md
```

## Troubleshooting

**`makensis.exe not found`** — run `npm run dist:win` once, or install NSIS.

**`EBUSY` / file is locked** — Otto or an installer is still running from `release/`.
Close it and build again.

**SmartScreen warning on the installer** — expected until the installer is code-signed.
