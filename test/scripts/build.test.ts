import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, rewriteImports } from "../../scripts/build.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

test("rewriteImports: relative .ts specifiers become .js; packages, node: and plain strings stay", () => {
  const src = [
    `import { a } from "./a.ts";`,
    `import type { T } from "../types.ts";`,
    `export * from "../b.ts";`,
    `export { c } from './c.ts';`,
    `import "./side.ts";`,
    `const d = await import("./d.ts");`,
    `import { readFile } from "node:fs/promises";`,
    `const label = "./not-an-import.ts";`,
  ].join("\n");
  const out = rewriteImports(src);
  assert.match(out, /from "\.\/a\.js"/);
  assert.match(out, /from "\.\.\/types\.js"/);
  assert.match(out, /from "\.\.\/b\.js"/);
  assert.match(out, /from '\.\/c\.js'/);
  assert.match(out, /import "\.\/side\.js"/);
  assert.match(out, /import\("\.\/d\.js"\)/);
  assert.match(out, /from "node:fs\/promises"/);
  assert.match(out, /"\.\/not-an-import\.ts"/);
});

test("build: every src/*.ts becomes a .js with no TypeScript and no .ts import left, without the typescript package", (t) => {
  const out = mkdtempSync(join(tmpdir(), "t3sm-build-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(REPO, "src"), out);
  const want = files(join(REPO, "src"), ".ts").map((f) => relative(join(REPO, "src"), f).replace(/\.ts$/, ".js")).sort();
  const got = files(out, ".js").map((f) => relative(out, f)).sort();
  assert.deepEqual(got, want);
  for (const f of files(out, ".js")) {
    const js = readFileSync(f, "utf8");
    assert.doesNotMatch(js, /(from\s*|import\s*\(\s*|import\s+)["']\.{1,2}\/[^"']+\.ts["']/, `${f}: a relative .ts import is left`);
  }
});

test("build output runs as an installed package (under node_modules, where Node will not strip types)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3sm-build-pkg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, "node_modules", "t3code-session-manager");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(join(REPO, "bin"), join(pkgDir, "bin"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(pkgDir, "package.json"));
  cpSync(join(REPO, "CHANGELOG.md"), join(pkgDir, "CHANGELOG.md"));
  build(join(REPO, "src"), join(pkgDir, "dist"));
  const run = (args: string[]) => spawnSync(process.execPath, [join(pkgDir, "bin", "t3sm.mjs"), ...args], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, T3SM_HOME: join(root, "state") },
  });
  const v = run(["--version"]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `${pkg.version}\n`);
  const h = run(["--help", "--lang", "en"]);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /t3sm update/);
  // Commands that need no network (`update --dry-run` looks up the releases): the package reads its own files.
  const c = run(["changelog", "--since", "0.2.0", "--lang", "en"]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^\[0\.2\.1\]/m);
  const u = run(["update", "--auto", "off", "--dry-run", "--lang", "en"]);
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /Would turn automatic updates off/);
  // The help topics ship in dist/help, in both languages.
  const help = run(["help", "not-imported", "--lang", "en"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /t3sm apply/);
  const pt = run(["help", "held", "--lang", "pt"]);
  assert.equal(pt.status, 0, pt.stderr);
  assert.match(pt.stdout, /projeto/);
});

test("build copies docs/help into dist/help (every topic, English and Portuguese)", (t) => {
  const out = mkdtempSync(join(tmpdir(), "t3sm-build-help-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(REPO, "src"), out);
  const want = readdirSync(join(REPO, "docs", "help")).filter((f) => f.endsWith(".md")).sort();
  assert.ok(want.length >= 26, `${want.length} topic files`);
  assert.deepEqual(readdirSync(join(out, "help")).sort(), want);
  for (const f of want) assert.equal(readFileSync(join(out, "help", f), "utf8"), readFileSync(join(REPO, "docs", "help", f), "utf8"));
});

test("build writes dist/build.json: {version, builtAt}", (t) => {
  const out = mkdtempSync(join(tmpdir(), "t3sm-build-stamp-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const before = Date.now();
  build(join(REPO, "src"), out);
  const stamp = JSON.parse(readFileSync(join(out, "build.json"), "utf8")) as { version: string; builtAt: string };
  assert.deepEqual(Object.keys(stamp).sort(), ["builtAt", "version"]);
  assert.equal(stamp.version, pkg.version);
  const at = Date.parse(stamp.builtAt);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, stamp.builtAt);
  assert.equal(new Date(at).toISOString(), stamp.builtAt);
  build(join(REPO, "src"), out, { builtAt: "2026-11-15T10:00:00.000Z" });
  assert.equal((JSON.parse(readFileSync(join(out, "build.json"), "utf8")) as { builtAt: string }).builtAt, "2026-11-15T10:00:00.000Z");
  // The package the Release workflow publishes to npm says so: an install from it then updates from the registry.
  build(join(REPO, "src"), out, { channel: "npm" });
  assert.equal((JSON.parse(readFileSync(join(out, "build.json"), "utf8")) as { channel?: string }).channel, "npm");
});
