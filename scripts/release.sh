#!/usr/bin/env bash
# Build a zeithub.otto release.
#
#   scripts/release.sh 0.1.9                 bump, test, build the installer (local only)
#   scripts/release.sh 0.1.9 --store         … and the Microsoft Store package (.appx)
#   scripts/release.sh 0.1.9 --publish       … then commit, tag, push to main and create the GitHub release
#   scripts/release.sh 0.1.9 --store --publish
#
# Before running: add the version's entry to apps/web/lib/changelog.ts (it becomes the release notes
# and the "What's new" list in the app). Run from Git Bash in the repository root.
set -euo pipefail

VERSION="${1:-}"
shift || true
STORE=0
PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --store) STORE=1 ;;
    --publish) PUBLISH=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release.sh <version, e.g. 0.1.9> [--store] [--publish]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
REPO="zeithub-team/otto"
TAG="v$VERSION"
DESKTOP="apps/desktop"
OUT="$DESKTOP/release/$TAG"
EXE="$OUT/zeithub-otto-setup-$VERSION.exe"
APPX="$OUT/zeithub-otto-$VERSION.appx"
step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

step "Checks"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then echo "Tag $TAG already exists." >&2; exit 1; fi
# the release notes come from the changelog entry of this version
NOTES="$(node -e '
  const src = require("fs").readFileSync("apps/web/lib/changelog.ts", "utf8");
  const v = process.argv[1];
  const at = src.indexOf(`version: '"'"'${v}'"'"'`);
  if (at < 0) process.exit(2);
  const block = src.slice(at, src.indexOf("],", at));
  const items = [...block.matchAll(/^\s*'"'"'(.*)'"'"',?\s*$/gm)].map((m) => "- " + m[1].replace(/\\'"'"'/g, "'"'"'"));
  console.log(items.join("\n"));
' "$VERSION")" || { echo "No entry for $VERSION in apps/web/lib/changelog.ts — add it first (version, date, items)." >&2; exit 1; }
echo "$NOTES"
if [[ $PUBLISH == 1 ]]; then
  gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login" >&2; exit 1; }
fi

step "Version $VERSION"
for f in package.json "$DESKTOP/package.json" apps/web/package.json; do
  node -e '
    const fs = require("fs"); const [f, v] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, s.replace(/"version": "[^"]+"/, `"version": "${v}"`));
  ' "$f" "$VERSION"
done
npm install --no-audit --no-fund >/dev/null

step "Tests"
(cd "$DESKTOP" && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|✖' || true)
(cd "$DESKTOP" && node --test "dist/server/__tests__/*.test.js" >/dev/null 2>&1) || { echo "Tests failed: cd $DESKTOP && npm test" >&2; exit 1; }

step "Installer"
npm run dist:local -w @otto/desktop
[[ -f "$EXE" ]] || { echo "Installer not found: $EXE" >&2; exit 1; }

if [[ $STORE == 1 ]]; then
  step "Microsoft Store package"
  (cd "$DESKTOP" && node scripts/dist-store.mjs)
  [[ -f "$APPX" ]] || { echo "Store package not found: $APPX" >&2; exit 1; }
fi

if [[ $PUBLISH == 0 ]]; then
  step "Done (not published)"
  echo "Installer: $EXE"
  [[ $STORE == 1 ]] && echo "Store:     $APPX"
  echo "Publish later with: scripts/release.sh $VERSION --publish   (re-runs the build)"
  exit 0
fi

step "Commit, tag, push"
git add package.json package-lock.json "$DESKTOP/package.json" apps/web/package.json apps/web/lib/changelog.ts
git commit -q -m "v$VERSION" || echo "(nothing to commit)"
git tag "$TAG"
git push -q origin HEAD:main
git push -q origin "$TAG"

step "GitHub release"
NOTES_FILE="$(mktemp)"
{
  echo "### What's new"
  echo "$NOTES"
  echo
  echo "---"
  echo
  echo "**Install:** download \`zeithub-otto-setup-$VERSION.exe\` and run it. The installer isn't code-signed yet — if SmartScreen warns you, choose *More info → Run anyway*."
} > "$NOTES_FILE"
gh release create "$TAG" "$EXE" --repo "$REPO" --title "zeithub.otto $VERSION" --notes-file "$NOTES_FILE" --latest
rm -f "$NOTES_FILE"

step "Done"
echo "Release: https://github.com/$REPO/releases/tag/$TAG"
[[ $STORE == 1 ]] && echo "Store package for Partner Center: $APPX"
