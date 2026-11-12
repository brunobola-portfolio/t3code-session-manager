// scripts/release.js against a synthetic project root (T3SM_RELEASE_ROOT): never the real repository files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "release.js");
const REPO = "brunobola-portfolio/t3code-session-manager";
const URL_ = `https://github.com/${REPO}`;
// Built at run time: this file must not itself carry a stale project URL (the real --check scans tracked files).
const GH = "github" + ".com";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "t3sm-release-"));
  const w = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
  w("package.json", json({ name: "t3code-session-manager", version: "0.1.0", repository: { type: "git", url: `${URL_}.git` }, homepage: `${URL_}#readme`, bugs: { url: `${URL_}/issues` } }));
  w("package-lock.json", json({ name: "t3code-session-manager", version: "0.1.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "t3code-session-manager", version: "0.1.0" }, "node_modules/typescript": { version: "5.9.3" } } }));
  w(".claude-plugin/plugin.json", json({ name: "t3sm", version: "0.1.0", repository: URL_ }));
  w(".claude-plugin/marketplace.json", json({ plugins: [{ name: "t3sm", version: "0.1.0" }] }));
  w("README.md", `[![CI](${URL_}/actions/workflows/ci.yml/badge.svg)](${URL_}/actions)\n\nnpx -y github:${REPO}#v0.1.0 doctor\n\nSee also https://github.com/someone/other-project.\n`);
  w("SECURITY.md", `Report at ${URL_}/security.\n`);
  w(".github/ISSUE_TEMPLATE/config.yml", `contact_links:\n  - url: ${URL_}/discussions\n`);
  w("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-11\n\n### Added\n\n- First release.\n");
  return root;
}

const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, T3SM_RELEASE_ROOT: root }, timeout: 30_000 });

test("release --check: a consistent project passes", () => {
  const root = fixture();
  try {
    const r = run(root, "--check");
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --check: flags a package-lock version mismatch (top level and the root package entry)", () => {
  const root = fixture();
  try {
    const p = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(p, "utf8"));
    lock.version = "0.0.9";
    lock.packages[""].version = "0.0.8";
    writeFileSync(p, JSON.stringify(lock, null, 2) + "\n");
    const r = run(root, "--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package-lock\.json version is 0\.0\.9, expected 0\.1\.0/);
    assert.match(r.stderr, /package-lock\.json packages\[""\]\.version is 0\.0\.8, expected 0\.1\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --check: flags any github.com/<owner>/<name> of this project that is not REPO (badges, SECURITY, issue config); other projects are fine", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "README.md"), readFileSync(join(root, "README.md"), "utf8").replace(`${URL_}/actions)`, `https://${GH}/old-owner/t3code-session-manager/actions)`));
    writeFileSync(join(root, "SECURITY.md"), `Report at https://${GH}/Old-Owner/T3code-Session-Manager/security.\n`);
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/config.yml"), `contact_links:\n  - url: https://${GH}/old-owner/t3code-session-manager.git\n`);
    const r = run(root, "--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /README\.md links github\.com\/old-owner\/t3code-session-manager, expected github\.com\/brunobola-portfolio\/t3code-session-manager/);
    assert.match(r.stderr, /SECURITY\.md links github\.com\/Old-Owner\/T3code-Session-Manager/);
    assert.match(r.stderr, /\.github\/ISSUE_TEMPLATE\/config\.yml links github\.com\/old-owner\/t3code-session-manager/);
    assert.ok(!/other-project/.test(r.stderr), r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release <X.Y.Z>: bumps the package-lock top-level versions too, never a dependency's", () => {
  const root = fixture();
  try {
    run(root, "0.2.0");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.2.0");
    assert.equal(lock.packages[""].version, "0.2.0");
    assert.equal(lock.packages["node_modules/typescript"].version, "5.9.3");
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.2.0");
    const r = run(root, "--check");
    assert.ok(!/package-lock/.test(r.stderr), r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
