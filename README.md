# vendor-repo

Vendor a dependency's source as a squashed git subtree under `repos/`, pinned to the version you have installed, so coding agents read real library code instead of guessing from docs or compiled `node_modules`.

Works with npm, PyPI, Go modules, and Cargo crates.

```bash
npx vendor-repo add effect
# or: bunx vendor-repo add effect
```

## Commands

```bash
vendor-repo init [--ci|--no-ci] [--dry-run] [--json]
vendor-repo add <package> [--ecosystem npm|pypi|go|cargo] [--ref <tag|branch|sha>] [--name <dir>] [--latest] [--dry-run]
vendor-repo add <name> --url <git-url> --ref <tag|branch|sha>
vendor-repo update <name> [--ref <tag|branch|sha>] [--latest] [--dry-run]
vendor-repo update --all [--dry-run]
vendor-repo remove <name> [--yes]
vendor-repo list [--json]
vendor-repo check [--hook]
vendor-repo doctor [--json]
```

- **`init`** sets a project up in one commit: an empty `repos/vendored.json`, a "Vendored Repositories" section (with a "### Libraries" list) in `CLAUDE.md` / `AGENTS.md`, every tooling exclude it can write safely (text, JSON, and TOML files), and `.github/workflows/vendored-repos.yml` when the project is on GitHub. Fixes that live in JavaScript configs (flat ESLint, Vitest, Jest, Knip) or need judgment (workspace globs) are printed as `manual` lines instead. It never reformats JSONC. Re-running it is a no-op.
- **`add`** finds the installed version, resolves the upstream repo, matches the version to a git tag, runs `git subtree add --squash`, and records everything in `repos/vendored.json`. When `CLAUDE.md` / `AGENTS.md` has the "### Libraries" list, it adds the repo's line there too. It lands as two commits.
- **`update`** re-pins to the newly installed version after a dependency bump. `--all` does this for every drifted repo, and stops if a subtree pull leaves conflicts.
- **`remove`** deletes the subtree, its manifest entry, and its "### Libraries" line in one commit. It asks first unless you pass `--yes`, and the code stays in git history.
- **`list --json`** prints each vendored repo with its manifest fields, status, and installed version, for scripts and agents.
- **`check`** exits 1 when a vendored repo no longer matches the installed version. It emits annotations in GitHub Actions. With `--hook` it emits Claude Code SessionStart JSON and always exits 0.

- **`doctor`** checks that `repos/` is kept out of the project's tooling: .gitignore, TypeScript, ESLint, Biome, Prettier, Vitest, Jest, Bun test, Tailwind v4, Renovate, Knip, VS Code, .gitattributes, workspace globs, Go, Cargo, pytest, Ruff, mypy, and Pyright. It only checks the tools the project uses, prints a one-line fix for each gap, and exits 1 if anything is missing. It never edits files.

Every command that writes requires a clean working tree.

## Where versions come from

| Ecosystem | Installed version | Upstream repo |
|---|---|---|
| npm | `node_modules`, `package-lock.json`, `npm-shrinkwrap.json`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, then the `package.json` range | `repository` field, including monorepo `directory` |
| PyPI | `uv.lock`, `poetry.lock`, `pdm.lock`, `requirements*.txt` pins | PyPI `project_urls` |
| Go | `go.mod` `require` | Module path, or the `go-get=1` `go-import` meta tag |
| Cargo | `Cargo.lock` | crates.io `repository` |

Tags are tried in this order: `v1.2.3`, `1.2.3`, `pkg@1.2.3`, `name@1.2.3`, `name-v1.2.3`, `name-1.2.3`, and so on. Go submodules try `sub/dir/v1.2.3` first. Go pseudo-versions need `--ref <full sha>`.

## Claude Code hook

Add to `~/.claude/settings.json` to get a vendored-repo summary at session start, plus a warning when one has drifted:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [{ "type": "command", "command": "if command -v vendor-repo >/dev/null 2>&1; then vendor-repo check --hook; else bunx vendor-repo@0 check --hook; fi 2>/dev/null || true", "timeout": 20 }]
      }
    ]
  }
}
```

## CI

`vendor-repo init` writes `.github/workflows/vendored-repos.yml`, which runs on pull requests that touch `repos/` or a lockfile. The core of it:

```yaml
- uses: actions/checkout@v4
- uses: oven-sh/setup-bun@v2
- run: bunx vendor-repo@0 check
- run: bunx vendor-repo@0 doctor   # optional; add continue-on-error: true to keep it advisory
```

No install step is needed, because the check reads lockfiles directly.

## Requirements

- Node 20+ or Bun
- git with `git subtree`

## Development

```bash
bun install
bun run typecheck
bun test        # unit tests and offline integration tests against a local bare repo
bun run build   # dist/vendor-repo.js
bun run test:dist  # integration tests against the built bundle under Node
```

First release: `bash publish.sh` verifies everything, then asks before creating the GitHub repo, publishing to npm, and pushing the tag. Later releases: `npm version patch && git push --follow-tags`, published from CI through npm trusted publishing (configure it once under the package's Settings on npmjs.com; no token needed).

## License

MIT
