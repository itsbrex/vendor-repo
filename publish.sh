#!/usr/bin/env bash
# First release of vendor-repo: verifies the package, creates the GitHub repo, pushes, and publishes to npm.
# Every step that is visible to others asks first. Safe to re-run: finished steps are skipped.
#
# Usage: ./publish.sh [--owner itsbrex] [--private] [--skip-npm]
# Needs: git, gh (logged in), bun, node, npm
set -euo pipefail

OWNER="itsbrex"
VISIBILITY="public"
SKIP_NPM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --private) VISIBILITY="private"; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")"
REPO="$OWNER/vendor-repo"

step() { printf '\n== %s\n' "$1"; }
confirm() { local answer; read -r -p "$1 [y/N] " answer; [[ "$answer" =~ ^[Yy](es)?$ ]]; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }

for cmd in git gh bun node npm; do need "$cmd"; done
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI isn't logged in. Run: gh auth login" >&2; exit 1; }

step "Pointing package.json at github.com/$REPO"
# shellcheck disable=SC2016 # the ${...} below is a JavaScript template literal, not shell
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.repository = { type: "git", url: `git+https://github.com/${process.argv[1]}.git` };
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$REPO"
NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"
echo "$NAME@$VERSION"

step "Verifying (install, typecheck, tests, dist tests, pack)"
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:dist
npm pack --dry-run

step "Git"
if [[ ! -d .git ]]; then
  git init -q -b main
  git add -A
  git commit -q -m "🎉 feat: initial release of vendor-repo v$VERSION" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  echo "Created the initial commit."
elif [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -q -m "🔧 chore: point repository at github.com/$REPO"
  echo "Committed pending changes."
else
  echo "Repository already initialized and clean."
fi

step "GitHub: $REPO"
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "github.com/$REPO already exists."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  if confirm "Push main to github.com/$REPO?"; then git push -u origin main; fi
elif confirm "Create a $VISIBILITY repo at github.com/$REPO and push main?"; then
  gh repo create "$REPO" "--$VISIBILITY" --source . --remote origin --push \
    --description "Vendor dependency source as squashed git subtrees under repos/, pinned to the installed version, so coding agents read real library code."
else
  echo "Skipped GitHub."
fi

if [[ "$SKIP_NPM" -eq 1 ]]; then
  echo "Skipping npm (--skip-npm)."
  exit 0
fi

step "npm: $NAME@$VERSION"
npm whoami >/dev/null 2>&1 || npm login
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "$NAME@$VERSION is already published."
else
  if npm view "$NAME" name >/dev/null 2>&1; then
    echo "Warning: $NAME already exists on npm. If it isn't yours, rename to @$OWNER/vendor-repo in package.json and re-run." >&2
  fi
  if confirm "Publish $NAME@$VERSION to npm as a public package?"; then
    npm publish --access public
  else
    echo "Skipped npm publish."
  fi
fi

step "Tag and future releases"
if ! git rev-parse "v$VERSION" >/dev/null 2>&1; then git tag "v$VERSION"; fi
if git remote get-url origin >/dev/null 2>&1 && confirm "Push tag v$VERSION? (release.yml skips versions already on npm)"; then
  git push origin "v$VERSION"
fi
if git remote get-url origin >/dev/null 2>&1 && confirm "Store an npm automation token as the NPM_TOKEN secret so future tags publish from CI?"; then
  gh secret set NPM_TOKEN --repo "$REPO"
fi

echo
echo "Done. Next releases: npm version patch && git push --follow-tags"
