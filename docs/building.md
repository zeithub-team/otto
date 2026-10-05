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

## Microsoft Store

```bash
npm run dist:store -w @otto/desktop
```

The result is `apps/desktop/release/v<version>/zeithub-otto-<version>.appx`. The Store signs it on
submission, so Smart App Control and SmartScreen don't block the Store version.

The package identity comes from Partner Center (*Product management → Product identity*) and lives
in `apps/desktop/store.json`:

```json
{ "identityName": "…", "publisher": "CN=…", "publisherDisplayName": "…" }
```

Without `store.json` a test package with a placeholder identity is built; it can't be uploaded.
Tile images are generated from the brand icon with `npm run store-assets -w @otto/desktop`.
The Store version skips Otto's own update check: the Store updates it.

## One-command release

```bash
npm run release -- 0.1.9 --store --publish
```

Add the version's entry to `apps/web/lib/changelog.ts` first: it becomes the GitHub release notes
and the "What's new" list in the app. The script bumps the three `package.json` versions, runs the
tests, builds the installer (and with `--store` the `.appx` for Partner Center). With `--publish` it
commits the version bump, tags, pushes to `main` and creates the GitHub release. Without `--publish`
nothing leaves your machine. Commit your feature changes before running it. To publish a version that is already bumped and built: `npm run release -- 0.1.8 --publish --no-bump`. Works from PowerShell, cmd and Git Bash.
