#!/usr/bin/env bun
/**
 * vendor-repo – vendor external git repositories as squashed subtrees under `repos/`
 * so coding agents can read real library source instead of guessing.
 *
 * Usage:
 *   vendor-repo add <package> [--ecosystem npm|pypi|go|cargo] [--ref <tag|branch|sha>] [--name <dir>] [--latest] [--dry-run]
 *   vendor-repo add <name> --url <git-url> --ref <tag|branch|sha> [--dry-run]
 *   vendor-repo update <name> [--ref <tag|branch|sha>] [--latest] [--dry-run]
 *   vendor-repo update --all [--dry-run]
 *   vendor-repo remove <name> [--yes]
 *   vendor-repo list [--json]
 *   vendor-repo check [--hook]
 *   vendor-repo doctor [--json]
 *
 * `add` finds the installed version of a package (npm, PyPI, Go modules, or Cargo), resolves the
 * upstream repo, matches the version to a git tag, runs `git subtree add --squash`, and records the
 * result in `repos/vendored.json`.
 *
 * `remove` deletes a vendored repo and its manifest entry in one commit (asks first unless `--yes`).
 * `list --json` prints manifest entries with their current status for scripts and agents.
 * `update --all` re-pins every drifted repo. `doctor` checks that repos/ is excluded from the project's tooling.
 *
 * `check` compares every vendored repo against the installed version and exits 1 on drift. In GitHub
 * Actions it also emits annotations. With `--hook` it emits Claude Code SessionStart JSON and always exits 0.
 *
 * Runs with Bun (`bun vendor-repo.ts …`) or Node 22.6+ (`node --experimental-strip-types vendor-repo.ts …`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPOS_DIR = "repos";
const MANIFEST_FILE = "vendored.json";
const USER_AGENT = "vendor-repo (+https://github.com/itsbrex/vendor-repo)";
const FETCH_TIMEOUT_MS = 30_000;
const ECOSYSTEMS = ["npm", "pypi", "go", "cargo"] as const;

type Ecosystem = (typeof ECOSYSTEMS)[number];

type VendoredRepo = {
  package?: string;
  ecosystem?: Ecosystem;
  url: string;
  ref: string;
  commit: string;
  packageVersion?: string;
  directory?: string;
  vendoredAt: string;
};

type Manifest = {
  version: 1;
  repos: Record<string, VendoredRepo>;
};

type ResolvedVersion = {
  version: string;
  source: string;
  declared: boolean;
  pseudoCommit?: string;
};

type RepoLocation = {
  url: string;
  directory?: string;
};

type PackageJson = {
  version?: string;
  repository?: string | { url?: string; directory?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type DriftStatus = "match" | "drift" | "unpinned" | "unverified" | "not-installed" | "missing-dir" | "unmanaged" | "no-package";

type DriftReport = {
  name: string;
  status: DriftStatus;
  vendored?: string;
  installed?: string;
  installedSource?: string;
  ref?: string;
};

class CliError extends Error {}

// ---------- shell helpers ----------

function git(args: string[], cwd: string, inherit = false): string {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return typeof out === "string" ? out.trim() : "";
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new CliError(`git ${args.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
  }
}

function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

function assertCleanTree(root: string): void {
  if (git(["status", "--porcelain"], root) !== "") {
    throw new CliError("Working tree has uncommitted changes. Commit or stash them first (git subtree requires a clean tree).");
  }
}

function assertSubtreeAvailable(root: string): void {
  try {
    execFileSync("git", ["subtree", "-h"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    // `git subtree -h` exits 129 after printing usage (stdout or stderr by git version); only a missing command is fatal.
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    if (!`${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`.includes("usage: git subtree")) {
      throw new CliError("`git subtree` is not available. Install git's contrib subtree command first.");
    }
  }
}

// ---------- file helpers ----------

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function readJson<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function manifestPath(root: string): string {
  return join(root, REPOS_DIR, MANIFEST_FILE);
}

function readManifest(root: string): Manifest {
  const path = manifestPath(root);
  if (!existsSync(path)) return { version: 1, repos: {} };
  const manifest = readJson<Manifest>(path);
  if (!manifest?.repos) throw new CliError(`${REPOS_DIR}/${MANIFEST_FILE} is not valid JSON. Fix or restore it before continuing.`);
  return manifest;
}

function writeManifest(root: string, manifest: Manifest): void {
  const sorted = Object.fromEntries(Object.entries(manifest.repos).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath(root), `${JSON.stringify({ version: 1, repos: sorted }, null, 2)}\n`);
}

function today(): string {
  // YYYY-MM-DD in local time, without depending on ICU locale data being present.
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A directory name under repos/. Accepts `repos/<name>` and a trailing slash, rejects anything that would escape the directory. */
function vendoredName(raw: string): string {
  const name = raw.trim().replace(new RegExp(`^${REPOS_DIR}/`), "").replace(/\/+$/, "");
  if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new CliError(`"${raw}" is not a valid repo name. Use a single directory name under ${REPOS_DIR}/, such as effect.`);
  }
  return name;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

async function fetchText(url: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new CliError(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return response.ok ? response.text() : undefined;
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const text = await fetchText(url);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(`Unexpected non-JSON response from ${url}.`);
  }
}

// ---------- versions ----------

export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split(/-(.*)/s);
  const [coreB = "", preB] = b.split(/-(.*)/s);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}

function highest(versions: string[]): string | undefined {
  return [...versions].sort(compareVersions).pop();
}

// ---------- lockfile parsers (pure, exported for tests) ----------

export function parsePackageLock(text: string, pkg: string): string | undefined {
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    return lock.packages?.[`node_modules/${pkg}`]?.version ?? lock.dependencies?.[pkg]?.version;
  } catch {
    return undefined;
  }
}

export function parseBunLock(text: string, pkg: string): string | undefined {
  const name = escapeRegex(pkg);
  return text.match(new RegExp(`^\\s*"${name}":\\s*\\[\\s*"${name}@([^"]+)"`, "m"))?.[1];
}

export function parsePnpmLock(text: string, pkg: string): string | undefined {
  const name = escapeRegex(pkg);
  const pattern = new RegExp(`^ {2}['"]?/?${name}[@/](\\d[^:'"(\\s]*)`, "gm");
  return highest([...text.matchAll(pattern)].map((m) => m[1] ?? "").filter(Boolean));
}

export function parseYarnLock(text: string, pkg: string): string | undefined {
  const header = new RegExp(`(^|[\\s,"])${escapeRegex(pkg)}@`);
  const versions: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const first = block.trimStart().split("\n")[0] ?? "";
    if (first.startsWith("#") || !header.test(first)) continue;
    const version = block.match(/^\s+version:?\s+"?([^"\s]+)"?/m)?.[1];
    if (version) versions.push(version);
  }
  return highest(versions);
}

function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function parseTomlLock(text: string, name: string, ecosystem: "pypi" | "cargo"): string | undefined {
  const same = ecosystem === "pypi" ? (a: string) => normalizePyName(a) === normalizePyName(name) : (a: string) => a === name;
  const versions: string[] = [];
  for (const chunk of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const table = chunk.split(/^\[/m)[0] ?? "";
    const pkgName = table.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = table.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (pkgName && version && same(pkgName)) versions.push(version);
  }
  return highest(versions);
}

export function parseRequirements(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/);
    if (match?.[1] && match[2] && normalizePyName(match[1]) === normalizePyName(name)) return match[2];
  }
  return undefined;
}

export function parseGoMod(text: string, modulePath: string): string | undefined {
  const pattern = new RegExp(`^\\s*(?:require\\s+)?${escapeRegex(modulePath)}\\s+(v\\S+)(?=\\s|$)`, "m");
  // Ignore anything inside replace/exclude directives.
  const withoutReplace = text.replace(/^(replace|exclude)\s*\([\s\S]*?^\)/gm, "").replace(/^(replace|exclude)\s+.*$/gm, "");
  return withoutReplace.match(pattern)?.[1];
}

export function normalizeGoVersion(raw: string): { version: string; pseudoCommit?: string } {
  const version = raw.replace(/^v/, "").replace(/\+incompatible$/, "");
  // Pseudo-versions end in <timestamp>-<12 hex>, whatever precedes them: vX.0.0-, vX.Y.Z-0., or vX.Y.Z-pre.0.
  const pseudo = version.match(/\d{14}-([0-9a-f]{12})$/)?.[1];
  return pseudo ? { version, pseudoCommit: pseudo } : { version };
}

function stripGoMajorSuffix(path: string | undefined): string | undefined {
  const stripped = path?.replace(/(^|\/)v\d+$/, "");
  return stripped ? stripped : undefined;
}

export function goModuleRepo(modulePath: string): RepoLocation | undefined {
  const match = modulePath.match(/^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/([^/]+)\/([^/]+)(?:\/(.+))?$/);
  if (!match) return undefined;
  const directory = stripGoMajorSuffix(match[4]);
  return { url: `https://${match[1]}/${match[2]}/${match[3]}.git`, ...(directory ? { directory } : {}) };
}

export function parseGoImportMeta(html: string, modulePath: string): RepoLocation | undefined {
  const metas = [...html.matchAll(/<meta\s+name=["']go-import["']\s+content=["']([^"']+)["']/gi)]
    .map((m) => (m[1] ?? "").trim().split(/\s+/))
    .filter(([prefix, vcs]) => vcs === "git" && prefix !== undefined && (modulePath === prefix || modulePath.startsWith(`${prefix}/`)))
    .sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0));
  const [prefix, , repo] = metas[0] ?? [];
  if (!prefix || !repo) return undefined;
  const directory = stripGoMajorSuffix(modulePath.slice(prefix.length + 1));
  return { url: normalizeRepoUrl(repo), ...(directory ? { directory } : {}) };
}

// ---------- repo URL helpers ----------

export function normalizeRepoUrl(raw: string): string {
  let url = raw.trim().replace(/^git\+/, "").replace(/#.*$/, "");
  const shorthand = url.match(/^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    const host = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" }[shorthand[1] ?? "github"];
    url = `https://${host}/${shorthand[2]}/${shorthand[3]}`;
  }
  url = url
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\/+$/, "");
  return url.endsWith(".git") ? url : `${url}.git`;
}

const FORGE_URL = /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/([^/#?]+)\/([^/#?]+)(\/[^#?]*)?/;

export function webUrlToRepo(raw: string): RepoLocation {
  const match = raw.trim().match(FORGE_URL);
  if (!match) return { url: normalizeRepoUrl(raw) };
  const repo = (match[3] ?? "").replace(/\.git$/, "");
  const directory = match[4]?.match(/^\/(?:-\/)?tree\/[^/]+\/(.+?)\/?$/)?.[1];
  return { url: `https://${match[1]}/${match[2]}/${repo}.git`, ...(directory ? { directory } : {}) };
}

export function pickRepoUrl(urls: Record<string, string>): RepoLocation | undefined {
  const entries = Object.entries(urls).filter(([, value]) => typeof value === "string" && value !== "");
  const preferred = entries.find(([key, value]) => /^(source|source ?code|repository|repo|code|github|gitlab)$/i.test(key.trim()) && FORGE_URL.test(value));
  const anyForge = entries.find(([, value]) => FORGE_URL.test(value));
  const chosen = preferred ?? anyForge;
  return chosen ? webUrlToRepo(chosen[1]) : undefined;
}

function repoNameFromUrl(url: string): string {
  return url.replace(/\.git$/, "").split("/").pop() ?? "repo";
}

// ---------- installed version resolution ----------

function resolveNpm(root: string, pkg: string): ResolvedVersion | undefined {
  const installed = readJson<PackageJson>(join(root, "node_modules", pkg, "package.json"));
  if (installed?.version) return { version: installed.version, source: "node_modules", declared: false };

  const lockfiles: [string, (text: string, pkg: string) => string | undefined][] = [
    ["package-lock.json", parsePackageLock],
    ["npm-shrinkwrap.json", parsePackageLock],
    ["bun.lock", parseBunLock],
    ["pnpm-lock.yaml", parsePnpmLock],
    ["yarn.lock", parseYarnLock],
  ];
  for (const [file, parse] of lockfiles) {
    const text = readText(join(root, file));
    const version = text === undefined ? undefined : parse(text, pkg);
    if (version) return { version, source: file, declared: false };
  }

  const manifest = readJson<PackageJson>(join(root, "package.json"));
  const range =
    manifest?.dependencies?.[pkg] ??
    manifest?.devDependencies?.[pkg] ??
    manifest?.peerDependencies?.[pkg] ??
    manifest?.optionalDependencies?.[pkg];
  const match = range?.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
  return match ? { version: match[0], source: "package.json", declared: true } : undefined;
}

function resolvePypi(root: string, pkg: string): ResolvedVersion | undefined {
  for (const file of ["uv.lock", "poetry.lock", "pdm.lock"]) {
    const text = readText(join(root, file));
    const version = text === undefined ? undefined : parseTomlLock(text, pkg, "pypi");
    if (version) return { version, source: file, declared: false };
  }
  const requirements = existsSync(root) ? readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f)).sort() : [];
  for (const file of requirements) {
    const version = parseRequirements(readText(join(root, file)) ?? "", pkg);
    if (version) return { version, source: file, declared: false };
  }
  return undefined;
}

function resolveGo(root: string, modulePath: string): ResolvedVersion | undefined {
  const raw = parseGoMod(readText(join(root, "go.mod")) ?? "", modulePath);
  if (!raw) return undefined;
  const { version, pseudoCommit } = normalizeGoVersion(raw);
  return { version, source: "go.mod", declared: false, ...(pseudoCommit ? { pseudoCommit } : {}) };
}

function resolveCargo(root: string, crate: string): ResolvedVersion | undefined {
  const version = parseTomlLock(readText(join(root, "Cargo.lock")) ?? "", crate, "cargo");
  return version ? { version, source: "Cargo.lock", declared: false } : undefined;
}

const RESOLVERS: Record<Ecosystem, (root: string, pkg: string) => ResolvedVersion | undefined> = {
  npm: resolveNpm,
  pypi: resolvePypi,
  go: resolveGo,
  cargo: resolveCargo,
};

/** The resolver for a manifest entry, guarding against a hand-edited `ecosystem` value. */
function resolverFor(name: string, entry: VendoredRepo): (root: string, pkg: string) => ResolvedVersion | undefined {
  const ecosystem = entry.ecosystem ?? "npm";
  const resolver = (RESOLVERS as Partial<Record<string, (typeof RESOLVERS)[Ecosystem]>>)[ecosystem];
  if (!resolver) throw new CliError(`${REPOS_DIR}/${name} has unknown ecosystem "${ecosystem}" in ${MANIFEST_FILE}. Use one of: ${ECOSYSTEMS.join(", ")}.`);
  return resolver;
}

function detectEcosystem(root: string, pkg: string, explicit?: Ecosystem): { ecosystem: Ecosystem; resolved: ResolvedVersion } | undefined {
  const order: Ecosystem[] = explicit ? [explicit] : [...ECOSYSTEMS];
  let declaredHit: { ecosystem: Ecosystem; resolved: ResolvedVersion } | undefined;
  for (const ecosystem of order) {
    const resolved = RESOLVERS[ecosystem](root, pkg);
    if (resolved && !resolved.declared) return { ecosystem, resolved };
    if (resolved && !declaredHit) declaredHit = { ecosystem, resolved };
  }
  return declaredHit;
}

// ---------- upstream repo resolution ----------

async function resolveRepository(root: string, ecosystem: Ecosystem, pkg: string, version?: string): Promise<RepoLocation> {
  switch (ecosystem) {
    case "npm": {
      const local = readJson<PackageJson>(join(root, "node_modules", pkg, "package.json"));
      const registryName = pkg.startsWith("@") ? pkg.replace("/", "%2f") : pkg;
      const fromRegistry = async (): Promise<PackageJson["repository"]> => {
        // Ask for the installed version's metadata first: a package can move repos or monorepo directories between releases.
        const exact = version ? await fetchJson<PackageJson>(`https://registry.npmjs.org/${registryName}/${encodeURIComponent(version)}`) : undefined;
        return exact?.repository ?? (await fetchJson<PackageJson>(`https://registry.npmjs.org/${registryName}/latest`))?.repository;
      };
      const repository = local?.repository ?? (await fromRegistry());
      const rawUrl = typeof repository === "string" ? repository : repository?.url;
      if (!rawUrl) break;
      const directory = typeof repository === "object" ? repository.directory : undefined;
      return { ...webUrlToRepo(normalizeRepoUrl(rawUrl).replace(/\.git$/, "")), ...(directory ? { directory } : {}) };
    }
    case "pypi": {
      const data = await fetchJson<{ info?: { project_urls?: Record<string, string> | null; home_page?: string | null } }>(
        `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
      );
      const urls = { ...(data?.info?.project_urls ?? {}), ...(data?.info?.home_page ? { "Home page": data.info.home_page } : {}) };
      const location = pickRepoUrl(urls);
      if (location) return location;
      break;
    }
    case "go": {
      const forge = goModuleRepo(pkg);
      if (forge) return forge;
      const html = await fetchText(`https://${pkg}?go-get=1`);
      const location = html ? parseGoImportMeta(html, pkg) : undefined;
      if (location) return location;
      break;
    }
    case "cargo": {
      const data = await fetchJson<{ crate?: { repository?: string | null } }>(`https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`);
      if (data?.crate?.repository) return webUrlToRepo(data.crate.repository);
      break;
    }
  }
  throw new CliError(`Could not find the source repository for ${ecosystem} package ${pkg}. Pass --url.`);
}

// ---------- remote ref resolution ----------

function listRemoteTags(root: string, url: string): Map<string, string> {
  const out = git(["ls-remote", "--tags", url], root);
  const tags = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref) continue;
    const name = ref.replace("refs/tags/", "");
    // An annotated tag is listed twice: the tag object, then the peeled commit as `<tag>^{}`. Record the commit.
    if (name.endsWith("^{}")) tags.set(name.slice(0, -3), sha);
    else if (!tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

export function tagCandidates(pkg: string | undefined, version: string, goSubdir?: string): string[] {
  const candidates = goSubdir ? [`${goSubdir}/v${version}`] : [];
  candidates.push(`v${version}`, version);
  if (pkg) {
    const bare = pkg.replace(/^@[^/]+\//, "").split("/").pop() ?? pkg;
    candidates.push(`${pkg}@${version}`, `${pkg}@v${version}`, `${bare}@${version}`, `${bare}-v${version}`, `${bare}-${version}`, `${bare}/v${version}`);
  }
  candidates.push(`release-${version}`);
  return [...new Set(candidates)];
}

function matchVersionTag(root: string, url: string, pkg: string | undefined, version: string, goSubdir?: string): { ref: string; commit: string } {
  const tags = listRemoteTags(root, url);
  for (const candidate of tagCandidates(pkg, version, goSubdir)) {
    const sha = tags.get(candidate);
    if (sha) return { ref: candidate, commit: sha };
  }
  const near = [...tags.keys()].filter((tag) => tag.includes(version)).slice(0, 8);
  throw new CliError(
    `No upstream tag matches version ${version} in ${url}.` +
      (near.length > 0 ? `\nTags containing ${version}: ${near.join(", ")}` : "") +
      "\nPass --ref <tag|branch|sha> explicitly, or --latest for the default branch.",
  );
}

function resolveRef(root: string, url: string, ref: string): { ref: string; commit: string } {
  if (/^[0-9a-f]{40}$/.test(ref)) return { ref, commit: ref };
  const out = git(["ls-remote", url, ref, `refs/tags/${ref}^{}`], root);
  const lines = out.split("\n").filter(Boolean);
  // Prefer the peeled commit for annotated tags.
  const line = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
  if (!line) throw new CliError(`Ref ${ref} not found in ${url}.`);
  return { ref, commit: line.split("\t")[0] ?? "" };
}

function defaultBranch(root: string, url: string): { ref: string; commit: string } {
  const out = git(["ls-remote", "--symref", url, "HEAD"], root);
  const branch = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  const commit = out.match(/^([0-9a-f]{40})\s+HEAD/m)?.[1];
  if (!branch || !commit) throw new CliError(`Could not determine the default branch of ${url}.`);
  return { ref: branch, commit };
}

// ---------- commands ----------

type CommandOptions = {
  ref?: string;
  url?: string;
  name?: string;
  ecosystem?: Ecosystem;
  latest: boolean;
  dryRun: boolean;
};

function chooseRef(
  root: string,
  url: string,
  pkg: string | undefined,
  ecosystem: Ecosystem | undefined,
  directory: string | undefined,
  resolved: ResolvedVersion | undefined,
  options: CommandOptions,
): { ref: string; commit: string } {
  if (options.ref) return resolveRef(root, url, options.ref);
  if (options.latest) return defaultBranch(root, url);
  if (!resolved) throw new CliError(`Could not find an installed or declared version${pkg ? ` of ${pkg}` : ""}. Pass --ref or --latest.`);
  if (resolved.pseudoCommit) {
    throw new CliError(
      `${pkg} is pinned to a Go pseudo-version (commit ${resolved.pseudoCommit}), which has no tag. Pass --ref <full 40-char commit sha>.`,
    );
  }
  return matchVersionTag(root, url, pkg, resolved.version, ecosystem === "go" ? directory : undefined);
}

function isPinned(pkg: string | undefined, resolved: ResolvedVersion | undefined, options: CommandOptions): resolved is ResolvedVersion {
  if (pkg === undefined || resolved === undefined || options.latest) return false;
  if (!options.ref) return true;
  // A full sha that matches a Go pseudo-version's commit is the installed version.
  return resolved.pseudoCommit !== undefined && options.ref.startsWith(resolved.pseudoCommit);
}

function commitManifest(root: string, message: string): void {
  git(["add", join(REPOS_DIR, MANIFEST_FILE)], root);
  git(["commit", "-m", message], root);
}

async function addCommand(target: string, options: CommandOptions): Promise<void> {
  const root = repoRoot(process.cwd());
  const detected = detectEcosystem(root, target, options.ecosystem);
  // With --url and no installed match, the target is just a directory name.
  const pkg = detected || !options.url ? target : undefined;
  const ecosystem = pkg ? (detected?.ecosystem ?? options.ecosystem ?? "npm") : undefined;
  const resolved = detected?.resolved;

  const location: RepoLocation = options.url
    ? { url: normalizeRepoUrl(options.url) }
    : await resolveRepository(root, ecosystem ?? "npm", target, resolved?.version);
  const { url, directory } = location;

  const name = vendoredName(options.name ?? (pkg ? repoNameFromUrl(url) : target));
  const prefix = `${REPOS_DIR}/${name}`;
  const manifest = readManifest(root);
  if (existsSync(join(root, prefix)) || manifest.repos[name]) {
    throw new CliError(`${prefix} already exists. Use \`vendor-repo update ${name}\` instead.`);
  }

  const { ref, commit } = chooseRef(root, url, pkg, ecosystem, directory, resolved, options);
  const pinned = isPinned(pkg, resolved, options);
  const label = pinned ? `${pkg}@${resolved.version}` : `${name}@${ref}`;

  console.log(`Vendoring ${url} @ ${ref} (${commit.slice(0, 12)}) into ${prefix}`);
  if (pkg && resolved) console.log(`${ecosystem} package ${pkg} ${resolved.version} (from ${resolved.source})`);
  if (resolved?.declared) console.log(`Note: ${pkg} is not installed or locked; matched the version declared in package.json.`);
  if (directory) console.log(`Package source lives at ${prefix}/${directory}`);
  if (options.dryRun) return;

  assertSubtreeAvailable(root);
  assertCleanTree(root);
  git(["subtree", "add", `--prefix=${prefix}`, url, ref, "--squash", "-m", `➕ chore(repos): vendor ${label} under ${prefix}`], root, true);

  manifest.repos[name] = {
    ...(pkg ? { package: pkg } : {}),
    ...(ecosystem ? { ecosystem } : {}),
    url,
    ref,
    commit,
    ...(pinned ? { packageVersion: resolved.version } : {}),
    ...(directory ? { directory } : {}),
    vendoredAt: today(),
  };
  writeManifest(root, manifest);
  commitManifest(root, `📌 chore(repos): record ${prefix} in ${MANIFEST_FILE}`);

  const source = directory ? `repos/${name}/${directory}/` : `repos/${name}/`;
  console.log(`\nDone. Suggested line for the project's CLAUDE.md / AGENTS.md:\n`);
  console.log(`- When writing code that uses \`${pkg ?? name}\`, inspect \`${source}\` for idiomatic usage, tests, and API design. Treat it as the source of truth for its patterns.`);
}

async function updateCommand(rawName: string, options: CommandOptions, root = repoRoot(process.cwd())): Promise<void> {
  const name = vendoredName(rawName);
  const manifest = readManifest(root);
  const entry = manifest.repos[name];
  if (!entry) throw new CliError(`${name} is not in ${REPOS_DIR}/${MANIFEST_FILE}. Use \`vendor-repo add\` first.`);

  const prefix = `${REPOS_DIR}/${name}`;
  const ecosystem = entry.package ? (entry.ecosystem ?? "npm") : undefined;
  const resolved = entry.package ? resolverFor(name, entry)(root, entry.package) : undefined;
  const { ref, commit } = chooseRef(root, entry.url, entry.package, ecosystem, entry.directory, resolved, options);
  if (commit === entry.commit) {
    const repin = isPinned(entry.package, resolved, options) && entry.packageVersion !== resolved?.version;
    console.log(`${prefix} is already at ${ref} (${commit.slice(0, 12)}).${repin ? ` Recording it as ${resolved?.version}.` : ""}`);
    if (repin && resolved && !options.dryRun) {
      assertCleanTree(root);
      manifest.repos[name] = { ...entry, packageVersion: resolved.version, vendoredAt: today() };
      writeManifest(root, manifest);
      commitManifest(root, `📌 chore(repos): pin ${prefix} to ${resolved.version}`);
    }
    return;
  }

  console.log(`Updating ${prefix}: ${entry.ref} -> ${ref} (${commit.slice(0, 12)})`);
  if (options.dryRun) return;

  assertSubtreeAvailable(root);
  assertCleanTree(root);
  git(["subtree", "pull", `--prefix=${prefix}`, entry.url, ref, "--squash", "-m", `⬆️ chore(repos): update ${prefix} to ${ref}`], root, true);

  const { packageVersion: _previous, ...rest } = entry;
  const pinned = isPinned(entry.package, resolved, options);
  manifest.repos[name] = {
    ...rest,
    ref,
    commit,
    ...(pinned ? { packageVersion: resolved.version } : {}),
    vendoredAt: today(),
  };
  writeManifest(root, manifest);
  commitManifest(root, `📌 chore(repos): record ${prefix} at ${ref}`);
}

async function updateAllCommand(options: CommandOptions): Promise<void> {
  if (options.ref || options.latest) {
    throw new CliError("--all re-pins each repo to its installed version, so it can't be combined with --ref or --latest.");
  }
  const root = repoRoot(process.cwd());
  const drifted = driftReport(root).filter((report) => report.status === "drift");
  if (drifted.length === 0) {
    console.log("Nothing to update – every pinned repo matches its installed version.");
    return;
  }
  if (!options.dryRun) {
    assertSubtreeAvailable(root);
    assertCleanTree(root);
  }

  let updated = 0;
  const failures: string[] = [];
  for (const [index, report] of drifted.entries()) {
    try {
      await updateCommand(report.name, options, root);
      updated++;
    } catch (error) {
      failures.push(`${REPOS_DIR}/${report.name}: ${error instanceof Error ? error.message : String(error)}`);
      // A failed subtree pull can leave a conflicted merge behind; stop rather than stack more commits on it.
      if (!options.dryRun && git(["status", "--porcelain"], root) !== "") {
        const skipped = drifted.slice(index + 1).map((r) => `${REPOS_DIR}/${r.name}`);
        if (skipped.length > 0) failures.push(`Stopped with a dirty tree; skipped ${skipped.join(", ")}. Resolve or run \`git merge --abort\`, then re-run.`);
        break;
      }
    }
  }

  const summary = options.dryRun ? `${drifted.length} to update (dry run)` : `${updated} updated`;
  console.log(`\n${summary}${failures.length > 0 ? `, ${failures.length} failed` : ""}.`);
  for (const failure of failures) console.error(`  ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

export function driftReport(root: string): DriftReport[] {
  const reposDir = join(root, REPOS_DIR);
  if (!existsSync(reposDir)) return [];

  const manifest = readManifest(root);
  const reports: DriftReport[] = [];

  for (const [name, entry] of Object.entries(manifest.repos)) {
    if (!existsSync(join(reposDir, name))) {
      reports.push({ name, status: "missing-dir", ref: entry.ref });
      continue;
    }
    if (!entry.package) {
      reports.push({ name, status: "no-package", ref: entry.ref });
      continue;
    }
    const installed = resolverFor(name, entry)(root, entry.package);
    if (!installed) {
      reports.push({ name, status: "not-installed", vendored: entry.packageVersion, ref: entry.ref });
      continue;
    }
    // A version range from package.json alone can't prove drift (e.g. CI without a lockfile).
    const status: DriftStatus = !entry.packageVersion
      ? "unpinned"
      : entry.packageVersion === installed.version
        ? "match"
        : installed.declared
          ? "unverified"
          : "drift";
    reports.push({ name, status, vendored: entry.packageVersion, installed: installed.version, installedSource: installed.source, ref: entry.ref });
  }

  for (const dir of readdirSync(reposDir)) {
    if (!manifest.repos[dir] && statSync(join(reposDir, dir)).isDirectory()) {
      reports.push({ name: dir, status: "unmanaged" });
    }
  }
  return reports;
}

function shortRef(ref: string | undefined): string | undefined {
  return ref && /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

function describe(input: DriftReport): string {
  const report = { ...input, ref: shortRef(input.ref) };
  const path = `${REPOS_DIR}/${report.name}`;
  switch (report.status) {
    case "match":
      return `${path} (${report.ref}) matches installed ${report.installed}`;
    case "drift":
      return `${path} is vendored at ${report.vendored}${report.ref === report.vendored ? "" : ` (${report.ref})`} but ${report.installed} is installed`;
    case "unverified":
      return `${path} is vendored at ${report.vendored}; no lockfile or node_modules found to confirm the installed version`;
    case "unpinned":
      return `${path} tracks ${report.ref}, not pinned to installed ${report.installed}`;
    case "not-installed":
      return `${path} (${report.ref}) – package no longer installed`;
    case "missing-dir":
      return `${path} is listed in ${MANIFEST_FILE} but the directory is missing`;
    case "no-package":
      return `${path} (${report.ref}) – not tied to a package, version not checked`;
    case "unmanaged":
      return `${path} – not in ${MANIFEST_FILE}, version unknown`;
  }
}

function isProblem(report: DriftReport): boolean {
  return report.status === "drift" || report.status === "missing-dir";
}

function projectRoot(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd(); // treat an empty value as unset
  try {
    return repoRoot(projectDir);
  } catch {
    return projectDir;
  }
}

function hookOutput(reports: DriftReport[]): string | undefined {
  if (reports.length === 0) return undefined;
  const problems = reports.filter(isProblem);
  const context = [
    `Vendored reference repos in this project (read-only, never import from them):`,
    ...reports.map((r) => `- ${describe(r)}`),
    ...(problems.length > 0
      ? [
          "",
          "Version drift: patterns in drifted repos may not match the installed API. Verify against the installed package's types before relying on them, and suggest running `vendor-repo update <name>` to the user.",
        ]
      : []),
  ].join("\n");
  const output: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  };
  if (problems.length > 0) {
    const fixes = problems.filter((p) => p.status === "drift").map((p) => `vendor-repo update ${p.name}`);
    output.systemMessage = `Vendored repo drift: ${problems.map(describe).join("; ")}.${fixes.length > 0 ? ` Run: ${fixes.join(" && ")}` : ""}`;
  }
  return JSON.stringify(output);
}

function hookErrorOutput(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\.\s*$/, "");
  return JSON.stringify({
    systemMessage: `vendor-repo check failed: ${message}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `The vendored-repos check failed (${message}). Treat repos/ as read-only reference material, and don't trust repos/${MANIFEST_FILE} until it's fixed.`,
    },
  });
}

function githubAnnotation(report: DriftReport): string | undefined {
  const text = describe(report).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const file = `${REPOS_DIR}/${MANIFEST_FILE}`;
  if (isProblem(report)) return `::error file=${file},title=Vendored repo drift::${text}`;
  if (report.status === "unmanaged" || report.status === "not-installed" || report.status === "unverified") return `::warning file=${file},title=Vendored repo::${text}`;
  return undefined;
}

function checkCommand(hook: boolean): void {
  const root = projectRoot();

  if (hook) {
    let output: string | undefined;
    try {
      output = hookOutput(driftReport(root));
    } catch (error) {
      output = hookErrorOutput(error);
    }
    if (output) process.stdout.write(output);
    return;
  }

  const reports = driftReport(root);
  if (reports.length === 0) {
    console.log(`No vendored repos in ${root}.`);
    return;
  }
  const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
  for (const report of reports) {
    console.log(`${report.status.padEnd(13)} ${describe(report)}`);
    const annotation = inGitHubActions ? githubAnnotation(report) : undefined;
    if (annotation) console.log(annotation);
  }
  if (reports.some(isProblem)) process.exitCode = 1;
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

async function removeCommand(rawName: string, yes: boolean): Promise<void> {
  const name = vendoredName(rawName);
  const root = repoRoot(process.cwd());
  const manifest = readManifest(root);
  const prefix = `${REPOS_DIR}/${name}`;
  const tracked = git(["ls-files", "--", prefix], root);
  if (!manifest.repos[name] && tracked === "") throw new CliError(`${prefix} is not vendored here.`);

  assertCleanTree(root);
  const fileCount = tracked === "" ? 0 : tracked.split("\n").length;
  const question = `Remove ${prefix} (${fileCount} tracked files) and its ${MANIFEST_FILE} entry? It stays in git history.`;
  if (!yes) {
    if (!process.stdin.isTTY) throw new CliError(`Refusing to remove ${prefix} without confirmation. Re-run with --yes.`);
    if (!(await confirm(question))) {
      console.log("Cancelled.");
      return;
    }
  }

  if (tracked !== "") git(["rm", "-r", "-q", "--", prefix], root);
  // `git rm` leaves untracked and ignored files behind (e.g. a node_modules/ someone installed inside the subtree).
  rmSync(join(root, prefix), { recursive: true, force: true });
  if (manifest.repos[name]) {
    delete manifest.repos[name];
    writeManifest(root, manifest);
    git(["add", join(REPOS_DIR, MANIFEST_FILE)], root);
  }
  git(["commit", "-q", "-m", `🔥 chore(repos): remove ${prefix}`], root);
  console.log(`Removed ${prefix}. Remember to drop its line from the project's CLAUDE.md / AGENTS.md.`);
}

type ListEntry = Partial<VendoredRepo> & {
  name: string;
  status: DriftStatus;
  installedVersion?: string;
  installedSource?: string;
};

function listCommand(json: boolean): void {
  const root = projectRoot();
  const manifest = existsSync(join(root, REPOS_DIR)) ? readManifest(root) : { version: 1 as const, repos: {} };
  const repos: ListEntry[] = driftReport(root).map((report) => ({
    name: report.name,
    status: report.status,
    ...manifest.repos[report.name],
    ...(report.installed ? { installedVersion: report.installed } : {}),
    ...(report.installedSource ? { installedSource: report.installedSource } : {}),
  }));

  if (json) {
    process.stdout.write(`${JSON.stringify({ root, repos }, null, 2)}\n`);
    return;
  }
  if (repos.length === 0) {
    console.log(`No vendored repos in ${root}.`);
    return;
  }
  for (const repo of repos) {
    const what = repo.package ? `${repo.ecosystem ?? "npm"}:${repo.package}` : "-";
    console.log([repo.name.padEnd(20), what.padEnd(40), (shortRef(repo.ref) ?? "-").padEnd(16), repo.status].join(" "));
  }
}

// ---------- doctor ----------

type DoctorStatus = "ok" | "missing" | "warn";

type DoctorCheck = {
  id: string;
  tool: string;
  status: DoctorStatus;
  file: string;
  message: string;
  fix?: string;
};

const REPOS_MENTION = /(?:^|[\s"'`[(,!/^])\/?repos(?:\/\*\*|\/\*|\/)?(?=["'`\s,\])]|$)/m;

function mentionsRepos(text: string | undefined): boolean {
  return text !== undefined && REPOS_MENTION.test(text);
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        i++;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJsonc<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return undefined;
  }
}

export function tomlSection(text: string, header: string): string | undefined {
  const start = text.match(new RegExp(`^\\[${escapeRegex(header)}\\]\\s*$`, "m"));
  if (start?.index === undefined) return undefined;
  const rest = text.slice(start.index + start[0].length);
  return rest.split(/^\[/m)[0] ?? "";
}

function firstExisting(root: string, names: string[]): string | undefined {
  return names.find((name) => existsSync(join(root, name)));
}

function findFiles(root: string, match: (name: string) => boolean, depth = 4): string[] {
  const skip = new Set(["node_modules", REPOS_DIR, ".git", "dist", "build", ".next", ".turbo", "coverage", "vendor", "target", ".venv"]);
  const found: string[] = [];
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!skip.has(entry) && !entry.startsWith(".")) walk(path, level + 1);
      } else if (match(entry)) {
        found.push(relative(root, path));
      }
    }
  };
  walk(root, 0);
  return found;
}

type PackageManifest = PackageJson & {
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  prettier?: unknown;
  jest?: unknown;
  knip?: unknown;
  renovate?: unknown;
};

function dependsOn(pkg: PackageManifest | undefined, name: string): string | undefined {
  return pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name] ?? pkg?.peerDependencies?.[name] ?? pkg?.optionalDependencies?.[name];
}

export function doctorChecks(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => {
    checks.push(check);
  };
  const pkg = readJson<PackageManifest>(join(root, "package.json"));
  const pyproject = readText(join(root, "pyproject.toml"));

  // .gitignore must NOT hide repos/.
  const gitignore = readText(join(root, ".gitignore"));
  if (gitignore !== undefined) {
    const ignored = gitignore.split("\n").some((line) => /^\/?repos(\/(\*\*?)?)?\s*$/.test(line.trim()));
    add({
      id: "gitignore",
      tool: "git",
      file: ".gitignore",
      status: ignored ? "missing" : "ok",
      message: ignored ? "repos/ is gitignored, so agents skip it and the subtree can't be committed" : "repos/ is not ignored",
      ...(ignored ? { fix: "Remove the repos/ line from .gitignore" } : {}),
    });
  }

  // TypeScript
  if (existsSync(join(root, "tsconfig.json"))) {
    const tsconfig = readJsonc<{ files?: string[]; include?: string[]; exclude?: string[] }>(join(root, "tsconfig.json"));
    const include = tsconfig?.include;
    // Without `include`, TypeScript compiles `files` when present and everything (**/*) otherwise.
    const broad = include ? include.some((p) => /^(\.\/)?\*/.test(p) || p === "." || p === "./") : !tsconfig?.files;
    const excluded = (tsconfig?.exclude ?? []).some((p) => mentionsRepos(`"${p}"`));
    const ok = !broad || excluded;
    add({
      id: "tsconfig",
      tool: "TypeScript",
      file: "tsconfig.json",
      status: ok ? "ok" : "missing",
      message: ok ? (excluded ? "repos excluded" : "include or files is scoped") : "include is missing or broad and repos isn't excluded",
      ...(ok ? {} : { fix: '"exclude": ["node_modules", "repos"]' }),
    });
  }

  // ESLint
  const eslintFlat = firstExisting(root, ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"]);
  const eslintLegacy = firstExisting(root, [".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"]);
  if (eslintFlat || eslintLegacy) {
    const file = eslintFlat ?? eslintLegacy ?? "";
    const ok = mentionsRepos(readText(join(root, file))) || (!eslintFlat && mentionsRepos(readText(join(root, ".eslintignore"))));
    add({
      id: "eslint",
      tool: "ESLint",
      file,
      status: ok ? "ok" : "missing",
      message: ok ? "repos ignored" : "repos/ will be linted",
      ...(ok ? {} : { fix: eslintFlat ? 'Add { ignores: ["repos/**"] } as its own config object' : 'Add "repos/" to .eslintignore' }),
    });
  }

  // Biome
  const biome = firstExisting(root, ["biome.json", "biome.jsonc"]);
  if (biome) {
    const ok = /"!+[^"]*repos/.test(readText(join(root, biome)) ?? "");
    add({
      id: "biome",
      tool: "Biome",
      file: biome,
      status: ok ? "ok" : "missing",
      message: ok ? "repos ignored" : "repos/ will be linted, formatted, and indexed",
      ...(ok ? {} : { fix: '"files": { "includes": ["**", "!!**/repos"] }' }),
    });
  }

  // Prettier
  const prettierConfig = firstExisting(root, [".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts"]);
  if (prettierConfig || pkg?.prettier !== undefined || dependsOn(pkg, "prettier")) {
    const ok = mentionsRepos(readText(join(root, ".prettierignore")));
    add({
      id: "prettier",
      tool: "Prettier",
      file: ".prettierignore",
      status: ok ? "ok" : "missing",
      message: ok ? "repos ignored" : "repos/ will be formatted",
      ...(ok ? {} : { fix: "Add /repos/ to .prettierignore" }),
    });
  }

  // Vitest
  const vitestConfig =
    firstExisting(root, ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cts", "vitest.config.cjs"]) ??
    ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find((f) => /\btest\s*:/.test(readText(join(root, f)) ?? ""));
  if (vitestConfig || dependsOn(pkg, "vitest")) {
    const ok = vitestConfig !== undefined && mentionsRepos(readText(join(root, vitestConfig)));
    add({
      id: "vitest",
      tool: "Vitest",
      file: vitestConfig ?? "vitest.config.ts",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded" : "vendored test files will run",
      ...(ok ? {} : { fix: 'test: { exclude: [...configDefaults.exclude, "repos/**"] }' }),
    });
  }

  // Jest
  const jestConfig = firstExisting(root, ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json"]);
  if (jestConfig || pkg?.jest !== undefined) {
    const text = jestConfig ? readText(join(root, jestConfig)) : JSON.stringify(pkg?.jest);
    const tests = mentionsRepos(text);
    const modules = /modulePathIgnorePatterns[^\]]*repos/.test(text ?? "");
    add({
      id: "jest",
      tool: "Jest",
      file: jestConfig ?? "package.json",
      status: tests && modules ? "ok" : tests ? "warn" : "missing",
      message: tests && modules ? "repos ignored" : tests ? "tests ignored, but vendored package.json files can still cause haste-map collisions" : "vendored test files will run",
      ...(tests && modules ? {} : { fix: 'testPathIgnorePatterns: ["/node_modules/", "<rootDir>/repos/"], modulePathIgnorePatterns: ["<rootDir>/repos/"]' }),
    });
  }

  // Bun test
  const bunfig = readText(join(root, "bunfig.toml"));
  const bunTestSection = bunfig === undefined ? undefined : tomlSection(bunfig, "test");
  const usesBunTest = bunTestSection !== undefined || Object.values(pkg?.scripts ?? {}).some((script) => /\bbun test\b/.test(script));
  if (usesBunTest) {
    const ok = mentionsRepos(bunTestSection) || /^\s*root\s*=/m.test(bunTestSection ?? "");
    add({
      id: "bun-test",
      tool: "Bun test",
      file: "bunfig.toml",
      status: ok ? "ok" : "missing",
      message: ok ? "repos ignored or test root scoped" : "vendored test files will run",
      ...(ok ? {} : { fix: '[test]\npathIgnorePatterns = ["repos/**"]' }),
    });
  }

  // Tailwind v4
  const tailwindMajor = Number(dependsOn(pkg, "tailwindcss")?.match(/\d+/)?.[0] ?? 0);
  if (tailwindMajor >= 4) {
    const sheets = findFiles(root, (name) => name.endsWith(".css")).filter((file) => /@import\s+["']tailwindcss["']/.test(readText(join(root, file)) ?? ""));
    if (sheets.length > 0) {
      const ok = sheets.some((file) => /@source\s+not\s+["'][^"']*repos/.test(readText(join(root, file)) ?? ""));
      add({
        id: "tailwind",
        tool: "Tailwind CSS",
        file: sheets[0] ?? "",
        status: ok ? "ok" : "missing",
        message: ok ? "repos excluded from source detection" : "vendored repos will be scanned for class names",
        ...(ok ? {} : { fix: '@source not "<relative path to>/repos";' }),
      });
    }
  }

  // Renovate
  const renovate = firstExisting(root, ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".github/renovate.json", ".github/renovate.json5", ".gitlab/renovate.json"]);
  if (renovate || pkg?.renovate !== undefined) {
    const ok = mentionsRepos(renovate ? readText(join(root, renovate)) : JSON.stringify(pkg?.renovate));
    add({
      id: "renovate",
      tool: "Renovate",
      file: renovate ?? "package.json",
      status: ok ? "ok" : "missing",
      message: ok ? "repos ignored" : "Renovate will open PRs against vendored manifests",
      ...(ok ? {} : { fix: 'Add "repos/**" to ignorePaths (keep the config:recommended entries)' }),
    });
  }

  // Knip
  const knip = firstExisting(root, ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc", "knip.config.ts", "knip.config.js", "knip.ts"]);
  if (knip || pkg?.knip !== undefined) {
    const ok = /!\/?repos/.test(knip ? (readText(join(root, knip)) ?? "") : JSON.stringify(pkg?.knip));
    add({
      id: "knip",
      tool: "Knip",
      file: knip ?? "package.json",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded from project files" : "vendored files will be analyzed",
      ...(ok ? {} : { fix: 'Add "!repos/**" to project (not ignore)' }),
    });
  }

  // VS Code
  if (existsSync(join(root, ".vscode/settings.json"))) {
    const ok = mentionsRepos(readText(join(root, ".vscode/settings.json")));
    add({
      id: "vscode",
      tool: "VS Code",
      file: ".vscode/settings.json",
      status: ok ? "ok" : "warn",
      message: ok ? "repos excluded" : "search, file watching, and auto-imports will include repos/",
      ...(ok ? {} : { fix: '"search.exclude": { "repos/**": true }, "files.watcherExclude": { "repos/**": true }, "js/ts.preferences.autoImportFileExcludePatterns": ["repos/**"]' }),
    });
  }

  // .gitattributes
  const gitattributes = readText(join(root, ".gitattributes"));
  const linguist = /^\/?repos\S*\s+.*linguist-(vendored|generated)/m.test(gitattributes ?? "");
  add({
    id: "gitattributes",
    tool: "GitHub",
    file: ".gitattributes",
    status: linguist ? "ok" : "warn",
    message: linguist ? "repos marked vendored" : "subtree updates will show as huge diffs and skew language stats",
    ...(linguist ? {} : { fix: "repos/** linguist-vendored linguist-generated" }),
  });

  // Workspaces
  const pnpmWorkspace = readText(join(root, "pnpm-workspace.yaml"));
  const workspaceGlobs = [
    ...(Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? [])),
    ...[...(pnpmWorkspace ?? "").matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1] ?? ""),
  ];
  if (workspaceGlobs.length > 0) {
    const catchAll = workspaceGlobs.filter((glob) => /^(\.\/)?(\*|\*\*|\*\*\/\*)$/.test(glob.trim()) || /^(\.\/)?repos/.test(glob.trim()));
    add({
      id: "workspaces",
      tool: "Workspaces",
      file: pnpmWorkspace !== undefined ? "pnpm-workspace.yaml" : "package.json",
      status: catchAll.length === 0 ? "ok" : "warn",
      message: catchAll.length === 0 ? "workspace globs are explicit" : `glob ${catchAll.join(", ")} can pull vendored repos in as workspace packages`,
      ...(catchAll.length === 0 ? {} : { fix: 'Use explicit globs like "packages/*" and "apps/*"' }),
    });
  }

  // Go
  if (existsSync(join(root, "go.mod"))) {
    const ok = existsSync(join(root, REPOS_DIR, "go.mod"));
    add({
      id: "go",
      tool: "Go",
      file: "repos/go.mod",
      status: ok ? "ok" : "missing",
      message: ok ? "repos/ fenced off as its own module" : "vendored repos without their own go.mod are part of ./...",
      ...(ok ? {} : { fix: "Create repos/go.mod containing: module vendored-repos" }),
    });
  }

  // Rust
  const cargoToml = readText(join(root, "Cargo.toml"));
  const workspace = cargoToml === undefined ? undefined : tomlSection(cargoToml, "workspace");
  if (workspace !== undefined) {
    const ok = /^\s*exclude\s*=.*repos/m.test(workspace);
    add({
      id: "cargo",
      tool: "Cargo",
      file: "Cargo.toml",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded from the workspace" : "vendored crates can be picked up by the workspace",
      ...(ok ? {} : { fix: '[workspace]\nexclude = ["repos"]' }),
    });
  }

  // Python
  const pySection = (header: string): string | undefined => (pyproject === undefined ? undefined : tomlSection(pyproject, header));
  const pytest = pySection("tool.pytest.ini_options") ?? readText(join(root, "pytest.ini"));
  if (pytest !== undefined) {
    const ok = /norecursedirs[^\n]*repos/.test(pytest) || /^\s*testpaths\s*=/m.test(pytest);
    add({
      id: "pytest",
      tool: "pytest",
      file: pySection("tool.pytest.ini_options") !== undefined ? "pyproject.toml" : "pytest.ini",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded or testpaths scoped" : "vendored test suites will be collected",
      ...(ok ? {} : { fix: 'norecursedirs = ["*.egg", ".*", "_darcs", "build", "CVS", "dist", "node_modules", "venv", "{arch}", "repos"]' }),
    });
  }
  const ruff = pySection("tool.ruff") ?? readText(join(root, "ruff.toml")) ?? readText(join(root, ".ruff.toml"));
  if (ruff !== undefined) {
    const ok = /exclude[^\n]*repos/.test(ruff);
    add({
      id: "ruff",
      tool: "Ruff",
      file: pySection("tool.ruff") !== undefined ? "pyproject.toml" : "ruff.toml",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded" : "repos/ will be linted and formatted",
      ...(ok ? {} : { fix: 'extend-exclude = ["repos"]' }),
    });
  }
  const mypy = pySection("tool.mypy") ?? readText(join(root, "mypy.ini"));
  if (mypy !== undefined) {
    const ok = /exclude[^\n]*repos/.test(mypy);
    add({
      id: "mypy",
      tool: "mypy",
      file: pySection("tool.mypy") !== undefined ? "pyproject.toml" : "mypy.ini",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded" : "repos/ will be type-checked",
      ...(ok ? {} : { fix: 'exclude = ["^repos/"]' }),
    });
  }
  const pyright = pySection("tool.pyright") ?? readText(join(root, "pyrightconfig.json"));
  if (pyright !== undefined) {
    const ok = mentionsRepos(pyright);
    add({
      id: "pyright",
      tool: "Pyright",
      file: pySection("tool.pyright") !== undefined ? "pyproject.toml" : "pyrightconfig.json",
      status: ok ? "ok" : "missing",
      message: ok ? "repos excluded" : "repos/ will be type-checked",
      ...(ok ? {} : { fix: 'exclude = ["**/node_modules", "**/__pycache__", "**/.*", "repos"]' }),
    });
  }

  return checks;
}

function doctorCommand(json: boolean): void {
  const root = projectRoot();
  const checks = doctorChecks(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ root, checks }, null, 2)}\n`);
  } else {
    if (!existsSync(join(root, REPOS_DIR))) console.log(`Note: no ${REPOS_DIR}/ directory yet – these checks show what to set up before vendoring.\n`);
    for (const check of checks) {
      const label = check.status === "ok" ? "ok     " : check.status === "missing" ? "MISSING" : "warn   ";
      console.log(`${label} ${check.tool.padEnd(13)} ${check.file} – ${check.message}`);
      if (check.fix) console.log(`        fix: ${check.fix.replace(/\n/g, "\n             ")}`);
    }
    const missing = checks.filter((c) => c.status === "missing").length;
    const warnings = checks.filter((c) => c.status === "warn").length;
    console.log(`\n${checks.length} checks: ${missing} missing, ${warnings} warnings.`);
  }
  if (checks.some((c) => c.status === "missing")) process.exitCode = 1;
}

// ---------- entry ----------

const USAGE = `Usage:
  vendor-repo add <package> [--ecosystem npm|pypi|go|cargo] [--ref <tag|branch|sha>] [--name <dir>] [--latest] [--dry-run]
  vendor-repo add <name> --url <git-url> --ref <tag|branch|sha> [--dry-run]
  vendor-repo update <name> [--ref <tag|branch|sha>] [--latest] [--dry-run]
  vendor-repo update --all [--dry-run]
  vendor-repo remove <name> [--yes]
  vendor-repo list [--json]
  vendor-repo check [--hook]
  vendor-repo doctor [--json]`;

function parseEcosystem(value: string | undefined): Ecosystem | undefined {
  if (value === undefined) return undefined;
  if ((ECOSYSTEMS as readonly string[]).includes(value)) return value as Ecosystem;
  throw new CliError(`Unknown ecosystem "${value}". Use one of: ${ECOSYSTEMS.join(", ")}.`);
}

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        url: { type: "string" },
        name: { type: "string" },
        ecosystem: { type: "string" },
        latest: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        hook: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    // parseArgs throws on unknown or malformed options; report that as usage, not a stack trace.
    throw new CliError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseCli();
  const [command, target] = positionals;
  const options: CommandOptions = {
    ref: values.ref,
    url: values.url,
    name: values.name,
    ecosystem: parseEcosystem(values.ecosystem),
    latest: values.latest ?? false,
    dryRun: values["dry-run"] ?? false,
  };

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command === "check") return checkCommand(values.hook ?? false);
  if (command === "list") return listCommand(values.json ?? false);
  if (command === "doctor") return doctorCommand(values.json ?? false);
  if (command === "update" && options.url) {
    throw new CliError(`update always pulls from the URL recorded in ${REPOS_DIR}/${MANIFEST_FILE}. To change the upstream, remove the repo and add it again with --url.`);
  }
  if (command === "update" && values.all) return updateAllCommand(options);
  if (command === "update" && !target) throw new CliError("Pass a repo name, or --all to update every drifted repo.");
  if (!target) throw new CliError(USAGE);
  if (command === "add") return addCommand(target, options);
  if (command === "update") return updateCommand(target, options);
  if (command === "remove") return removeCommand(target, values.yes ?? false);
  throw new CliError(USAGE);
}

// Run as a CLI only when this file is the entrypoint (works under Bun, Node, a bundled dist, and symlinked bins).
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const isHook = process.argv.includes("--hook");
  main().catch((error: unknown) => {
    if (isHook) {
      process.stdout.write(hookErrorOutput(error)); // Report, but never block a session start.
      return;
    }
    console.error(error instanceof CliError ? error.message : error);
    process.exitCode = 1;
  });
}
