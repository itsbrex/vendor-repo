import { describe, expect, test } from "bun:test";
import {
  editJsonText,
  editLibrariesSection,
  insertSectionLineText,
  planDoctorFix,
  compareVersions,
  goModuleRepo,
  normalizeGoVersion,
  normalizeRepoUrl,
  parseBunLock,
  parseGoImportMeta,
  parseGoMod,
  parsePackageLock,
  parsePnpmLock,
  parseRequirements,
  parseTomlLock,
  parseYarnLock,
  pickRepoUrl,
  stripJsonComments,
  tagCandidates,
  tomlSection,
  webUrlToRepo,
} from "./vendor-repo.ts";

describe("normalizeRepoUrl", () => {
  test.each([
    ["vercel/ms", "https://github.com/vercel/ms.git"],
    ["github:vercel/ms", "https://github.com/vercel/ms.git"],
    ["gitlab:group/proj", "https://gitlab.com/group/proj.git"],
    ["git+https://github.com/Effect-TS/effect.git", "https://github.com/Effect-TS/effect.git"],
    ["git://github.com/foo/bar.git", "https://github.com/foo/bar.git"],
    ["git+ssh://git@github.com/foo/bar.git", "https://github.com/foo/bar.git"],
    ["git@github.com:foo/bar.git", "https://github.com/foo/bar.git"],
    ["https://github.com/foo/bar#main", "https://github.com/foo/bar.git"],
  ])("%s", (input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });
});

describe("webUrlToRepo", () => {
  test("strips tree path into a directory", () => {
    expect(webUrlToRepo("https://github.com/tokio-rs/tokio/tree/master/tokio-util")).toEqual({
      url: "https://github.com/tokio-rs/tokio.git",
      directory: "tokio-util",
    });
  });
  test("strips trailing slash and issues paths", () => {
    expect(webUrlToRepo("https://github.com/encode/httpx/")).toEqual({ url: "https://github.com/encode/httpx.git" });
    expect(webUrlToRepo("https://github.com/encode/httpx/issues")).toEqual({ url: "https://github.com/encode/httpx.git" });
  });
  test("passes non-forge URLs through normalizeRepoUrl", () => {
    expect(webUrlToRepo("https://go.googlesource.com/sync")).toEqual({ url: "https://go.googlesource.com/sync.git" });
  });
});

describe("tagCandidates", () => {
  test("plain package tries v-prefixed then bare version first", () => {
    expect(tagCandidates("ms", "2.1.3").slice(0, 2)).toEqual(["v2.1.3", "2.1.3"]);
  });
  test("scoped package includes changesets-style tags", () => {
    const tags = tagCandidates("@effect/schema", "0.75.0");
    expect(tags).toContain("@effect/schema@0.75.0");
    expect(tags).toContain("schema@0.75.0");
  });
  test("cargo workspace crates include name-version tags", () => {
    expect(tagCandidates("tokio", "1.37.0")).toContain("tokio-1.37.0");
  });
  test("go submodule tag comes first", () => {
    expect(tagCandidates("github.com/aws/aws-sdk-go-v2/service/s3", "1.50.0", "service/s3")[0]).toBe("service/s3/v1.50.0");
  });
  test("no package yields only version-shaped tags", () => {
    expect(tagCandidates(undefined, "1.0.0")).toEqual(["v1.0.0", "1.0.0", "release-1.0.0"]);
  });
});

describe("compareVersions", () => {
  test("numeric, not lexical", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });
  test("release beats prerelease", () => {
    expect(compareVersions("2.0.0", "2.0.0-beta.1")).toBeGreaterThan(0);
  });
  test("equal", () => {
    expect(compareVersions("3.12.0", "3.12.0")).toBe(0);
  });
});

describe("npm lockfiles", () => {
  test("package-lock v3", () => {
    const text = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/effect": { version: "3.12.0" }, "node_modules/foo/node_modules/effect": { version: "3.1.0" } } });
    expect(parsePackageLock(text, "effect")).toBe("3.12.0");
  });
  test("package-lock v1", () => {
    expect(parsePackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: { ms: { version: "2.1.3" } } }), "ms")).toBe("2.1.3");
  });
  test("bun.lock top-level entry, not nested", () => {
    const text = `{
  "lockfileVersion": 1,
  "packages": {
    "effect": ["effect@3.12.0", "", { "dependencies": {} }, "sha512-x"],
    "other/effect": ["effect@3.1.0", "", {}, "sha512-y"],
    "@effect/schema": ["@effect/schema@0.75.0", "", {}, "sha512-z"],
  }
}`;
    expect(parseBunLock(text, "effect")).toBe("3.12.0");
    expect(parseBunLock(text, "@effect/schema")).toBe("0.75.0");
    expect(parseBunLock(text, "schema")).toBeUndefined();
  });
  test("pnpm v9 picks highest of package keys", () => {
    const text = `lockfileVersion: '9.0'

packages:

  '@effect/schema@0.75.0':
    resolution: {integrity: sha512-x}

  effect@3.12.0:
    resolution: {integrity: sha512-y}

  effect@3.9.1:
    resolution: {integrity: sha512-z}

snapshots:

  effect@3.12.0(react@18.3.1): {}
`;
    expect(parsePnpmLock(text, "effect")).toBe("3.12.0");
    expect(parsePnpmLock(text, "@effect/schema")).toBe("0.75.0");
  });
  test("pnpm v6 slash keys", () => {
    expect(parsePnpmLock("packages:\n\n  /ms@2.1.3:\n    resolution: {}\n", "ms")).toBe("2.1.3");
  });
  test("yarn classic", () => {
    const text = `ms@^2.1.1, ms@^2.1.3:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"

"@effect/schema@^0.75.0":
  version "0.75.0"
`;
    expect(parseYarnLock(text, "ms")).toBe("2.1.3");
    expect(parseYarnLock(text, "@effect/schema")).toBe("0.75.0");
    expect(parseYarnLock(text, "schema")).toBeUndefined();
  });
  test("yarn berry", () => {
    expect(parseYarnLock(`"effect@npm:^3.12.0":\n  version: 3.12.0\n  resolution: "effect@npm:3.12.0"\n`, "effect")).toBe("3.12.0");
  });
});

describe("TOML lockfiles", () => {
  test("uv.lock with PEP 503 name normalization", () => {
    const text = `version = 1

[[package]]
name = "pydantic-core"
version = "2.23.4"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "httpx"
version = "0.27.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "anyio" },
]
`;
    expect(parseTomlLock(text, "Pydantic_Core", "pypi")).toBe("2.23.4");
    expect(parseTomlLock(text, "httpx", "pypi")).toBe("0.27.2");
  });
  test("poetry.lock ignores sub-table keys", () => {
    const text = `[[package]]
name = "requests"
version = "2.32.3"

[package.dependencies]
version = "nope"
`;
    expect(parseTomlLock(text, "requests", "pypi")).toBe("2.32.3");
  });
  test("Cargo.lock picks highest of duplicates", () => {
    const text = `[[package]]
name = "syn"
version = "1.0.109"

[[package]]
name = "syn"
version = "2.0.66"
`;
    expect(parseTomlLock(text, "syn", "cargo")).toBe("2.0.66");
  });
});

describe("requirements.txt", () => {
  test("pinned, extras, markers, comments", () => {
    const text = "# deps\nhttpx[http2]==0.27.2 ; python_version >= '3.9'\nRequests == 2.32.3  # pinned\nanyio>=4\n";
    expect(parseRequirements(text, "httpx")).toBe("0.27.2");
    expect(parseRequirements(text, "requests")).toBe("2.32.3");
    expect(parseRequirements(text, "anyio")).toBeUndefined();
  });
});

describe("go", () => {
  const gomod = `module example.com/app

go 1.22

require github.com/spf13/cobra v1.8.0

require (
\tgolang.org/x/sync v0.7.0
\tgithub.com/pkg/errors v0.9.1+incompatible // indirect
\tgithub.com/foo/bar/v2 v2.3.4
)

replace (
\tgithub.com/old/thing v1.0.0 => ../thing
)
`;
  test("parses single and block requires", () => {
    expect(parseGoMod(gomod, "github.com/spf13/cobra")).toBe("v1.8.0");
    expect(parseGoMod(gomod, "golang.org/x/sync")).toBe("v0.7.0");
    expect(parseGoMod(gomod, "github.com/pkg/errors")).toBe("v0.9.1+incompatible");
  });
  test("ignores replace directives", () => {
    expect(parseGoMod(gomod, "github.com/old/thing")).toBeUndefined();
  });
  test("normalizes versions and flags pseudo-versions", () => {
    expect(normalizeGoVersion("v0.9.1+incompatible")).toEqual({ version: "0.9.1" });
    expect(normalizeGoVersion("v0.0.0-20240101120000-abcdef123456")).toEqual({ version: "0.0.0-20240101120000-abcdef123456", pseudoCommit: "abcdef123456" });
    expect(normalizeGoVersion("v1.2.4-0.20240101120000-abcdef123456").pseudoCommit).toBe("abcdef123456");
    expect(normalizeGoVersion("v1.2.3-pre.0.20240101120000-abcdef123456").pseudoCommit).toBe("abcdef123456");
    expect(normalizeGoVersion("v1.2.3-beta.1").pseudoCommit).toBeUndefined();
  });
  test("maps forge module paths to repo and subdirectory", () => {
    expect(goModuleRepo("github.com/spf13/cobra")).toEqual({ url: "https://github.com/spf13/cobra.git" });
    expect(goModuleRepo("github.com/foo/bar/v2")).toEqual({ url: "https://github.com/foo/bar.git" });
    expect(goModuleRepo("github.com/aws/aws-sdk-go-v2/service/s3")).toEqual({ url: "https://github.com/aws/aws-sdk-go-v2.git", directory: "service/s3" });
    expect(goModuleRepo("golang.org/x/sync")).toBeUndefined();
  });
  test("parses go-import meta, longest matching prefix", () => {
    const html = `<html><head>
<meta name="go-import" content="golang.org/x/sync git https://go.googlesource.com/sync">
<meta name="go-source" content="golang.org/x/sync https://github.com/golang/sync/ x y">
</head></html>`;
    expect(parseGoImportMeta(html, "golang.org/x/sync")).toEqual({ url: "https://go.googlesource.com/sync.git" });
    expect(parseGoImportMeta(html, "golang.org/x/sync/errgroup")).toEqual({ url: "https://go.googlesource.com/sync.git", directory: "errgroup" });
  });
});

describe("pickRepoUrl", () => {
  test("prefers Source over Homepage", () => {
    expect(pickRepoUrl({ Homepage: "https://www.python-httpx.org/", Source: "https://github.com/encode/httpx" })).toEqual({ url: "https://github.com/encode/httpx.git" });
  });
  test("falls back to any forge URL", () => {
    expect(pickRepoUrl({ Documentation: "https://docs.pydantic.dev", Changelog: "https://github.com/pydantic/pydantic/releases" })).toEqual({ url: "https://github.com/pydantic/pydantic.git" });
  });
  test("undefined when nothing looks like a repo", () => {
    expect(pickRepoUrl({ Homepage: "https://example.com" })).toBeUndefined();
  });
});

describe("doctor helpers", () => {
  test("stripJsonComments handles comments, trailing commas, and slashes in strings", () => {
    const text = '{\n  // line\n  "a": "http://x/*not*/", /* block */\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "http://x/*not*/", b: [1, 2] });
  });
  test("tomlSection stops at the next table", () => {
    const text = '[workspace]\nmembers = ["a"]\nexclude = ["repos"]\n\n[workspace.dependencies]\nserde = "1"\n';
    expect(tomlSection(text, "workspace")).toContain("exclude");
    expect(tomlSection(text, "workspace")).not.toContain("serde");
    expect(tomlSection(text, "package")).toBeUndefined();
  });
});

describe("init helpers", () => {
  test("editJsonText keeps the file's indent and refuses JSONC", () => {
    const tabbed = editJsonText('{\n\t"a": 1\n}\n', (data) => {
      data.b = [2];
      return true;
    });
    expect(tabbed).toBe('{\n\t"a": 1,\n\t"b": [\n\t\t2\n\t]\n}\n');
    expect(editJsonText(undefined, (data) => {
      data.a = 1;
      return true;
    })).toBe('{\n  "a": 1\n}\n');
    expect(editJsonText('{ // comment\n "a": 1 }', () => true)).toBeUndefined();
    expect(editJsonText("[1]", () => true)).toBeUndefined();
    expect(editJsonText("{}", () => false)).toBeUndefined();
  });

  test("insertSectionLineText adds after the header, appends a missing section, and leaves an existing key alone", () => {
    expect(insertSectionLineText("[a]\nx = 1\n\n[b]\ny = 2\n", "b", "z", "z = 3")).toBe("[a]\nx = 1\n\n[b]\nz = 3\ny = 2\n");
    expect(insertSectionLineText("[a]\nx = 1\n", "test", "k", 'k = ["v"]')).toBe('[a]\nx = 1\n\n[test]\nk = ["v"]\n');
    expect(insertSectionLineText(undefined, "test", "k", "k = 1")).toBe("[test]\nk = 1\n");
    expect(insertSectionLineText("[b]\nz = 0\n", "b", "z", "z = 3")).toBeUndefined();
  });

  test("editLibrariesSection edits only the Libraries list and restores the placeholder when it empties", () => {
    const doc = "# App\n\n## Vendored Repositories\n\nIntro.\n\n### Libraries\n\n- **a**: see `repos/a/`\n\n### Pattern files\n\n- `agent-patterns/x.md`\n";
    const added = editLibrariesSection(doc, (bullets) => [...bullets, "- **b**: see `repos/b/`"]);
    expect(added).toBe("# App\n\n## Vendored Repositories\n\nIntro.\n\n### Libraries\n\n- **a**: see `repos/a/`\n- **b**: see `repos/b/`\n\n### Pattern files\n\n- `agent-patterns/x.md`\n");
    const emptied = editLibrariesSection(doc, () => []);
    expect(emptied).toContain("### Libraries\n\n- (none yet");
    expect(emptied).toContain("### Pattern files\n\n- `agent-patterns/x.md`\n");
    expect(editLibrariesSection(doc, (bullets) => bullets)).toBeUndefined();
    expect(editLibrariesSection("# App\n\n### Libraries\n", (bullets) => [...bullets, "- x"])).toBeUndefined(); // no Vendored Repositories section
    expect(editLibrariesSection("## Vendored Repositories\n\ntext\n", (bullets) => [...bullets, "- x"])).toBeUndefined(); // no Libraries list
  });

  test("planDoctorFix leaves JavaScript configs and workspace globs to a human", () => {
    const current = (): string | undefined => undefined;
    const plan = (id: string, file: string, status: "missing" | "warn" = "missing") => planDoctorFix("/project", { id, tool: id, status, file, message: "" }, current);
    expect(plan("eslint", "eslint.config.js")).toBeUndefined();
    expect(plan("eslint", ".eslintrc.json")).toEqual({ file: ".eslintignore", content: "repos/\n" });
    expect(plan("vitest", "vitest.config.ts")).toBeUndefined();
    expect(plan("workspaces", "package.json", "warn")).toBeUndefined();
    expect(plan("knip", "knip.config.ts")).toBeUndefined();
    expect(plan("knip", "knip.json")?.content).toContain('"!repos/**"');
    expect(plan("ruff", ".ruff.toml")).toEqual({ file: ".ruff.toml", content: 'extend-exclude = ["repos"]\n' });
    expect(plan("pytest", "pytest.ini")?.content).toBe("[pytest]\nnorecursedirs = *.egg .* _darcs build CVS dist node_modules venv {arch} repos\n");
  });

  test("planDoctorFix puts the Tailwind @source line next to the import, relative to the stylesheet", () => {
    const current = (file: string): string | undefined => (file === "src/styles/app.css" ? '@import "tailwindcss";\n\nbody {}\n' : undefined);
    const fix = planDoctorFix("/project", { id: "tailwind", tool: "Tailwind CSS", status: "missing", file: "src/styles/app.css", message: "" }, current);
    expect(fix?.content).toBe('@import "tailwindcss";\n@source not "../../repos";\n\nbody {}\n');
  });
});
