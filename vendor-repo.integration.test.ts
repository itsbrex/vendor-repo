/**
 * End-to-end tests against a local bare upstream repo – no network needed.
 * Tests run in order and share one project, mirroring a real add -> drift -> update -> remove lifecycle.
 * Set VENDOR_REPO_BIN=dist/vendor-repo.js to run the same suite against the built Node bundle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUILT = process.env.VENDOR_REPO_BIN;
const COMMAND: [string, string] = BUILT ? ["node", join(import.meta.dir, BUILT)] : [process.execPath, join(import.meta.dir, "vendor-repo.ts")];
const TIMEOUT = 30_000;

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

type RunResult = { status: number | null; stdout: string; stderr: string };

let tmp = "";
let project = "";
let upstreamUrl = "";

function sh(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function run(args: string[], env: Record<string, string> = {}, cwd = project): RunResult {
  const result = spawnSync(COMMAND[0], [COMMAND[1], ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function setInstalled(version: string): void {
  writeFileSync(join(project, "node_modules/lib/package.json"), JSON.stringify({ name: "lib", version, repository: upstreamUrl }));
}

function manifest(): { repos: Record<string, Record<string, string>> } {
  return JSON.parse(readFileSync(join(project, "repos/vendored.json"), "utf8"));
}

function subjects(count: number): string[] {
  return sh("git", ["log", `-${count}`, "--format=%s"], project).split("\n");
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "vendor-repo-it-"));

  // Upstream with two tagged releases (one annotated, one lightweight), published as a bare repo.
  const work = join(tmp, "upstream");
  mkdirSync(work);
  sh("git", ["init", "-q", "-b", "main"], work);
  writeFileSync(join(work, "index.js"), "export const version = '1.0.0';\n");
  sh("git", ["add", "-A"], work);
  sh("git", ["commit", "-qm", "1.0.0"], work);
  sh("git", ["tag", "-a", "v1.0.0", "-m", "release 1.0.0"], work);
  writeFileSync(join(work, "index.js"), "export const version = '1.1.0';\n");
  sh("git", ["commit", "-qam", "1.1.0"], work);
  sh("git", ["tag", "v1.1.0"], work);
  sh("git", ["clone", "-q", "--bare", work, join(tmp, "upstream.git")], tmp);
  upstreamUrl = `file://${join(tmp, "upstream.git")}`;

  // Consumer project with lib@1.0.0 "installed".
  project = join(tmp, "project");
  mkdirSync(join(project, "node_modules/lib"), { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], project);
  writeFileSync(join(project, ".gitignore"), "node_modules\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: { lib: "^1.0.0" } }));
  setInstalled("1.0.0");
  sh("git", ["add", "-A"], project);
  sh("git", ["commit", "-qm", "init"], project);
});

afterAll(() => {
  if (tmp.startsWith(tmpdir())) rmSync(tmp, { recursive: true, force: true });
});

describe("vendor-repo lifecycle", () => {
  test("hook is silent before anything is vendored", () => {
    const result = run(["check", "--hook"], { CLAUDE_PROJECT_DIR: project });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("add pins to the installed version's tag and records it", () => {
    const result = run(["add", "lib"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(project, "repos/upstream/index.js"), "utf8")).toContain("1.0.0");
    const entry = manifest().repos.upstream;
    expect(entry).toMatchObject({ package: "lib", ecosystem: "npm", ref: "v1.0.0", packageVersion: "1.0.0" });
    // v1.0.0 is an annotated tag: the manifest must record the commit it points at, not the tag object.
    expect(entry?.commit).toBe(sh("git", ["rev-parse", "v1.0.0^{commit}"], join(tmp, "upstream")));
    expect(subjects(2)).toEqual(["📌 chore(repos): record repos/upstream in vendored.json", "➕ chore(repos): vendor lib@1.0.0 under repos/upstream"]);
  }, TIMEOUT);

  test("unknown options print usage instead of a stack trace", () => {
    const result = run(["list", "--bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--bogus");
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).not.toContain("    at ");
  });

  test("add refuses an existing name", () => {
    const result = run(["add", "lib"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  }, TIMEOUT);

  test("check and list report a match", () => {
    expect(run(["check"]).status).toBe(0);
    const list = JSON.parse(run(["list", "--json"]).stdout) as { repos: Record<string, unknown>[] };
    expect(list.repos).toHaveLength(1);
    expect(list.repos[0]).toMatchObject({ name: "upstream", status: "match", package: "lib", ref: "v1.0.0", installedVersion: "1.0.0", installedSource: "node_modules" });
  });

  test("a dependency bump is reported as drift in check, CI, and the hook", () => {
    setInstalled("1.1.0");
    const check = run(["check"], { GITHUB_ACTIONS: "true" });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("drift");
    expect(check.stdout).toContain("::error file=repos/vendored.json");

    const hook = JSON.parse(run(["check", "--hook"], { CLAUDE_PROJECT_DIR: project }).stdout) as { systemMessage?: string };
    expect(hook.systemMessage).toContain("vendor-repo update upstream");
  });

  test("update refuses a dirty tree", () => {
    writeFileSync(join(project, "scratch.txt"), "dirty");
    const result = run(["update", "upstream"]);
    rmSync(join(project, "scratch.txt"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uncommitted changes");
  }, TIMEOUT);

  test("update re-pins to the new tag", () => {
    const result = run(["update", "upstream"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(project, "repos/upstream/index.js"), "utf8")).toContain("1.1.0");
    expect(manifest().repos.upstream).toMatchObject({ ref: "v1.1.0", packageVersion: "1.1.0" });
    expect(run(["check"]).status).toBe(0);
  }, TIMEOUT);

  test("update rejects --url", () => {
    const result = run(["update", "upstream", "--url", upstreamUrl]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remove the repo and add it again");
  });

  test("add with --url and no package records a plain repo", () => {
    const result = run(["add", "plain", "--url", upstreamUrl, "--ref", "v1.0.0"]);
    expect(result.status).toBe(0);
    expect(manifest().repos.plain).toMatchObject({ ref: "v1.0.0" });
    expect(manifest().repos.plain?.package).toBeUndefined();
  }, TIMEOUT);

  test("an unreadable manifest blocks writes but not the hook", () => {
    const path = join(project, "repos/vendored.json");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, "{bad");
    const add = run(["add", "lib", "--name", "again", "--dry-run"]);
    const hook = run(["check", "--hook"], { CLAUDE_PROJECT_DIR: project });
    writeFileSync(path, original);
    expect(add.status).toBe(1);
    expect(add.stderr).toContain("not valid JSON");
    expect(hook.status).toBe(0);
    expect((JSON.parse(hook.stdout) as { systemMessage: string }).systemMessage).toContain("vendor-repo check failed");
  });

  test("remove requires confirmation when not interactive", () => {
    const result = run(["remove", "plain"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(existsSync(join(project, "repos/plain"))).toBe(true);
  });

  test("remove --yes deletes the subtree, leftover files, and manifest entry in one commit", () => {
    writeFileSync(join(project, ".git/info/exclude"), "repos/plain/scratch.log\n");
    writeFileSync(join(project, "repos/plain/scratch.log"), "ignored file left behind by some tool");
    const result = run(["remove", "repos/plain/", "--yes"]); // the path form is accepted too
    expect(result.status).toBe(0);
    expect(existsSync(join(project, "repos/plain"))).toBe(false);
    expect(manifest().repos.plain).toBeUndefined();
    expect(subjects(1)).toEqual(["🔥 chore(repos): remove repos/plain"]);
    expect(sh("git", ["status", "--porcelain"], project)).toBe("");
  }, TIMEOUT);

  test("remove refuses unknown names", () => {
    const result = run(["remove", "nope", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nope");
  });

  test("names can't escape repos/", () => {
    const result = run(["remove", "../package.json", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a valid repo name");
    expect(existsSync(join(project, "package.json"))).toBe(true);
  });
});

describe("update --all", () => {
  function setPackage(name: string, version: string): void {
    mkdirSync(join(project, "node_modules", name), { recursive: true });
    writeFileSync(join(project, "node_modules", name, "package.json"), JSON.stringify({ name, version, repository: upstreamUrl }));
  }

  beforeAll(() => {
    // Publish v1.2.0 upstream.
    const work = join(tmp, "upstream");
    writeFileSync(join(work, "index.js"), "export const version = '1.2.0';\n");
    sh("git", ["commit", "-qam", "1.2.0"], work);
    sh("git", ["tag", "v1.2.0"], work);
    sh("git", ["push", "-q", join(tmp, "upstream.git"), "main", "v1.2.0"], work);
  });

  test("requires a name or --all", () => {
    const result = run(["update"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--all");
  });

  test("re-pins every drifted repo in one command", () => {
    setPackage("lib2", "1.1.0");
    expect(run(["add", "lib2", "--name", "lib2"]).status).toBe(0);
    setInstalled("1.2.0");
    setPackage("lib2", "1.2.0");
    expect(run(["check"]).status).toBe(1);

    const dryRun = run(["update", "--all", "--dry-run"]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("repos/upstream");
    expect(dryRun.stdout).toContain("repos/lib2");
    expect(manifest().repos.upstream?.ref).toBe("v1.1.0");

    const result = run(["update", "--all"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 updated");
    expect(manifest().repos.upstream).toMatchObject({ ref: "v1.2.0", packageVersion: "1.2.0" });
    expect(manifest().repos.lib2).toMatchObject({ ref: "v1.2.0", packageVersion: "1.2.0" });
    expect(run(["check"]).status).toBe(0);
  }, TIMEOUT);

  test("reports when nothing has drifted", () => {
    const result = run(["update", "--all"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing to update");
  }, TIMEOUT);
});

describe("doctor", () => {
  let dir = "";
  type Check = { id: string; status: "ok" | "missing" | "warn"; fix?: string };
  const doctor = (): { status: number | null; checks: Check[] } => {
    const result = run(["doctor", "--json"], {}, dir);
    return { status: result.status, checks: (JSON.parse(result.stdout) as { checks: Check[] }).checks };
  };
  const statusOf = (checks: Check[], id: string): string | undefined => checks.find((c) => c.id === id)?.status;

  beforeAll(() => {
    dir = join(tmp, "doctor");
    mkdirSync(join(dir, "repos"), { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], dir);
    writeFileSync(join(dir, "repos/vendored.json"), JSON.stringify({ version: 1, repos: {} }));
    writeFileSync(join(dir, ".gitignore"), "node_modules\nrepos/\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", workspaces: ["*"], devDependencies: { tailwindcss: "^4.1.0" } }));
    writeFileSync(join(dir, "tsconfig.json"), '{\n  // comment\n  "compilerOptions": { "strict": true },\n}\n');
    writeFileSync(join(dir, "eslint.config.js"), "export default [{ rules: {} }];\n");
    writeFileSync(join(dir, ".prettierrc"), "{}\n");
    writeFileSync(join(dir, "vitest.config.ts"), "export default { test: {} };\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/app.css"), '@import "tailwindcss";\n');
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(join(dir, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "app"\n\n[tool.ruff]\nline-length = 100\n');
  });

  test("flags every unprotected tool and exits 1", () => {
    const { status, checks } = doctor();
    expect(status).toBe(1);
    for (const id of ["gitignore", "tsconfig", "eslint", "prettier", "vitest", "tailwind", "go", "cargo", "ruff"]) {
      expect(statusOf(checks, id)).toBe("missing");
    }
    expect(statusOf(checks, "workspaces")).toBe("warn");
    expect(statusOf(checks, "gitattributes")).toBe("warn");
    expect(statusOf(checks, "jest")).toBeUndefined(); // not used by this project
    expect(checks.find((c) => c.id === "tsconfig")?.fix).toContain('"exclude"');
  });

  test("passes once the excludes are in place", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", workspaces: ["packages/*"], devDependencies: { tailwindcss: "^4.1.0" } }));
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": {}, "exclude": ["node_modules", "repos"] }\n');
    writeFileSync(join(dir, "eslint.config.js"), 'export default [{ ignores: ["repos/**"] }];\n');
    writeFileSync(join(dir, ".prettierignore"), "/repos/\n");
    writeFileSync(join(dir, "vitest.config.ts"), 'export default { test: { exclude: ["repos/**"] } };\n');
    writeFileSync(join(dir, "src/app.css"), '@import "tailwindcss";\n@source not "../repos";\n');
    writeFileSync(join(dir, "repos/go.mod"), "module vendored-repos\n");
    writeFileSync(join(dir, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\nexclude = ["repos"]\n');
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "app"\n\n[tool.ruff]\nextend-exclude = ["repos"]\n');
    writeFileSync(join(dir, ".gitattributes"), "repos/** linguist-vendored linguist-generated\n");

    const { status, checks } = doctor();
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(status).toBe(0);
  });
});
