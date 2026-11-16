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
  w("package.json", json({ name: "t3code-session-manager", version: "0.1.0", repository: { type: "git", url: `${URL_}.git` }, homepage: `${URL_}#readme`, bugs: { url: `${URL_}/issues` }, publishConfig: { access: "public" } }));
  w("package-lock.json", json({ name: "t3code-session-manager", version: "0.1.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "t3code-session-manager", version: "0.1.0" }, "node_modules/typescript": { version: "5.9.3" } } }));
  w(".claude-plugin/plugin.json", json({ name: "t3sm", version: "0.1.0", repository: URL_ }));
  w(".claude-plugin/marketplace.json", json({ plugins: [{ name: "t3sm", version: "0.1.0" }] }));
  for (const n of ["status", "sync", "organize", "import"]) w(`commands/${n}.md`, `---\ndescription: Demo ${n} command for the fixture\n---\nRun the dry run first; write only after the user says yes.\n`);
  w("README.md", `[![CI](${URL_}/actions/workflows/ci.yml/badge.svg)](${URL_}/actions)\n\nnpm install -g t3code-session-manager\n\nnpx -y github:${REPO}#v0.1.0 doctor\n\nSee also https://github.com/someone/other-project.\n`);
  w("SECURITY.md", `Report at ${URL_}/security.\n`);
  w(".github/ISSUE_TEMPLATE/config.yml", `contact_links:\n  - url: ${URL_}/discussions\n`);
  w("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-11\n\n### Added\n\n- **First release.**\n");
  w("docs/help/held.md", "# Held: a project waits\n");
  w("docs/help/held.pt.md", "# À espera: um projeto espera\n");
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

test("release --check: flags a missing command file and package.json files without commands/", () => {
  const root = fixture();
  try {
    rmSync(join(root, "commands", "sync.md"));
    const p = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    pkg.files = ["dist/"];
    writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    const r = run(root, "--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commands\/sync\.md is missing/);
    assert.match(r.stderr, /"files" does not include "commands\/"/);
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

test("release check: every help topic in docs/help has its English file and its Portuguese twin (they ship in dist/help)", async (t) => {
  const { helpTopicProblems } = await import("../../scripts/release.js");
  assert.deepEqual(helpTopicProblems(), [], "the repository's own topics");
  const root = mkdtempSync(join(tmpdir(), "t3sm-help-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(helpTopicProblems(root), ["docs/help is missing (the help topics ship in dist/help)"]);
  mkdirSync(join(root, "docs", "help"), { recursive: true });
  writeFileSync(join(root, "docs", "help", "held.md"), "# Held\n");
  writeFileSync(join(root, "docs", "help", "errors.pt.md"), "# Erros\n");
  assert.deepEqual(helpTopicProblems(root).sort(), ["docs/help/errors.md is missing (the English topic)", "docs/help/held.pt.md is missing (the Portuguese twin)"]);
});

// The changelog style (docs/changelog-style.md) is checked on `## [Unreleased]` and on every release after 0.3.1.
const withLog = (body: string) => {
  const root = fixture();
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n${body}\n## [0.1.0] - 2026-11-11\n\n### Added\n\n- **First release.**\n`);
  return root;
};

test("release --check: a changelog entry in the house style passes", () => {
  const root = withLog([
    "One clear sentence on what this release means for you.",
    "",
    "### Added",
    "",
    "- **`t3sm demo` shows a sample run.** It writes nothing; see `t3sm help demo`.",
    "",
    "### Fixed",
    "",
    "- **Enter now keeps your answer.** Before, it saved nothing.",
    "  The next run asks again only if you quit first.",
    "",
  ].join("\n"));
  try {
    const r = run(root, "--check");
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --check: flags a changelog entry out of the house style (bold lead, length, sections, order, nesting)", () => {
  const long = "word ".repeat(80).trim();
  const root = withLog([
    "First sentence. Second sentence. A third sentence makes the summary too long.",
    "",
    "### Fixed",
    "",
    "- No bold headline here.",
    `- **Too long.** ${long}`,
    "  - a nested bullet",
    "",
    "### Added",
    "",
    "- **Added after Fixed.** Wrong order.",
    "",
    "### Improvements",
    "",
    "- **Unknown section.** Not a Keep a Changelog heading.",
    "",
  ].join("\n"));
  try {
    const r = run(root, "--check");
    assert.equal(r.status, 1);
    for (const want of [/Unreleased: the summary/, /starts without a \*\*bold headline\*\*/, /is \d+ characters/, /nested/, /"### Added" comes after/, /"### Improvements" is not one of/]) {
      assert.match(r.stderr, want);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --check: the style applies to every release, not only Unreleased; link references are ignored", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-11\n\n### Fixed\n\n- an old entry without its bold headline.\n\n[0.1.0]: https://example.com/v0.1.0\n");
    const r = run(root, "--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0\.1\.0: .*bold headline/);
    assert.doesNotMatch(r.stderr, /example\.com/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --notes: soft-wrapped paragraphs and bullets come out one line each (GitHub keeps every line break)", () => {
  const root = fixture();
  const body = [
    "A summary that the editor",
    "wrapped at 120 columns.",
    "",
    "### Fixed",
    "",
    "- **A bullet.** Its text goes on",
    "  on a second line.",
    "- **Another.** One line.",
    "",
    "```bash",
    "t3sm doctor",
    "t3sm plan",
    "```",
  ].join("\n");
  try {
    writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-11\n\n${body}\n`);
    const r = run(root, "--notes");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [
      "A summary that the editor wrapped at 120 columns.",
      "",
      "### Fixed",
      "",
      "- **A bullet.** Its text goes on on a second line.",
      "- **Another.** One line.",
      "",
      "```bash",
      "t3sm doctor",
      "t3sm plan",
      "```",
      "",
    ].join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release --check: the package can be published to npm, and the README shows the npm install line", () => {
  const root = fixture();
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  try {
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, private: true }, null, 2) + "\n");
    assert.match(run(root, "--check").stderr, /package\.json is "private"/);
    const { publishConfig: _drop, ...noAccess } = pkg;
    writeFileSync(pkgPath, JSON.stringify(noAccess, null, 2) + "\n");
    assert.match(run(root, "--check").stderr, /publishConfig\.access/);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    writeFileSync(join(root, "README.md"), readFileSync(join(root, "README.md"), "utf8").replace("npm install -g t3code-session-manager\n", ""));
    assert.match(run(root, "--check").stderr, /README\.md has no `npm install -g t3code-session-manager`/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
