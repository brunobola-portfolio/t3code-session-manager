#!/usr/bin/env node
/**
 * Release helper. Zero dependencies.
 *
 *   node scripts/release.js --check   every version (package-lock.json included), install pin, github.com URL of this
 *                                     project and the top CHANGELOG entry agree (CI runs this)
 *   node scripts/release.js --notes   print the CHANGELOG section of the current version (the Release workflow uses it)
 *   node scripts/release.js 0.2.0     bump every version and install pin, date or stub the CHANGELOG entry, and
 *                                     print the git commands to run next (it never runs git itself)
 *
 * The version lives in package.json, .claude-plugin/plugin.json and .claude-plugin/marketplace.json. The docs pin it
 * in install snippets as `github:<REPO>#vX.Y.Z`. REPO below is the one place the GitHub owner/name is defined (the
 * other is package.json's repository/homepage/bugs, which --check compares with it).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** GitHub owner/name. Change it here (and in package.json) if the repository is renamed; --check finds the rest. */
export const REPO = "brunobola-portfolio/t3code-session-manager";

const ROOT = process.env.T3SM_RELEASE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const MANIFESTS = ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
/** Any `github:<owner>/<name>#vX.Y.Z` install pin. */
const PIN_RE = /github:([\w.-]+\/[\w.-]+)#v(\d+\.\d+\.\d+)/g;
/** Folders whose Markdown is history, not instructions: never rewritten, never checked. */
const SKIP_DIRS = new Set(["superpowers", "spikes", "node_modules", "assets"]);

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const write = (rel, text) => writeFileSync(join(ROOT, rel), text);

/** Markdown files that may carry an install pin. */
export function pinnedDocs() {
  const out = ["README.md", "README.pt.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "ROADMAP.md", "AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(ROOT, f)));
  const walk = (rel) => {
    if (!existsSync(join(ROOT, rel))) return;
    for (const ent of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = posix.join(rel, ent.name);
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(child); }
      else if (ent.name.endsWith(".md")) out.push(child);
    }
  };
  walk("docs");
  walk("skills");
  walk(".github");
  return out;
}

/** Every "version" string in a manifest, as [jsonPath, value]. */
function manifestVersions(rel) {
  const found = [];
  const visit = (node, where) => {
    if (Array.isArray(node)) node.forEach((v, i) => visit(v, `${where}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "version" && typeof v === "string") found.push([`${where}.${k}`, v]);
        else visit(v, `${where}.${k}`);
      }
    }
  };
  visit(JSON.parse(read(rel)), rel);
  return found;
}

const LOCK = "package-lock.json";
/** Folders never scanned for repository URLs (build output, dependencies, local scratch, history). */
const URL_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".spike", ".superpowers", "superpowers", "spikes"]);
const TEXT_EXT = /\.(md|json|ya?ml|js|mjs|cjs|ts|mts|svg|txt|html)$/i;

/** Text files to scan: the tracked ones (`git ls-files`) in a checkout, else a walk of ROOT. */
function textFiles() {
  let files = null;
  if (existsSync(join(ROOT, ".git"))) {
    try { files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean); } catch { files = null; }
  }
  if (files === null) {
    files = [];
    const walk = (rel) => {
      for (const ent of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const child = rel ? posix.join(rel, ent.name) : ent.name;
        if (ent.isDirectory()) { if (!URL_SKIP_DIRS.has(ent.name)) walk(child); }
        else files.push(child);
      }
    };
    walk("");
  }
  return files.filter((f) => (TEXT_EXT.test(f) || /^[A-Z]+$/.test(posix.basename(f))) && !f.split("/").some((s) => URL_SKIP_DIRS.has(s)) && existsSync(join(ROOT, f)));
}

/** Every `github.com/<owner>/<this project's name>` that is not exactly REPO, as problems. */
export function repoUrlProblems() {
  const name = REPO.split("/")[1];
  const re = new RegExp(`github\\.com/([\\w.-]+)/(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w-])`, "gi");
  const problems = [];
  for (const rel of textFiles()) {
    for (const m of read(rel).matchAll(re)) {
      if (`${m[1]}/${m[2]}` !== REPO) problems.push(`${rel} links github.com/${m[1]}/${m[2]}, expected github.com/${REPO}`);
    }
  }
  return problems;
}

/** The `## [X.Y.Z] - YYYY-MM-DD` section of CHANGELOG.md, or null. */
export function changelogSection(version) {
  const text = read("CHANGELOG.md").replace(/\r\n/g, "\n");
  const head = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m");
  const m = head.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## \[/m);
  return { date: m[1], body: (next === -1 ? rest : rest.slice(0, next)).trim() };
}

/** The first released `## [X.Y.Z]` heading (skipping `## [Unreleased]`). */
function topChangelogVersion() {
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(read("CHANGELOG.md"));
  return m ? m[1] : null;
}

/** @returns {string[]} problems; empty when everything agrees. */
export function check() {
  const pkg = JSON.parse(read("package.json"));
  const version = pkg.version;
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" is not X.Y.Z`);
  for (const rel of MANIFESTS) {
    for (const [where, v] of manifestVersions(rel)) if (v !== version) problems.push(`${where} is ${v}, expected ${version}`);
  }
  const repoUrl = `https://github.com/${REPO}`;
  for (const [field, value] of [["repository.url", pkg.repository?.url], ["homepage", pkg.homepage], ["bugs.url", pkg.bugs?.url]]) {
    if (typeof value !== "string" || !value.startsWith(repoUrl)) problems.push(`package.json ${field} should start with ${repoUrl}`);
  }
  for (const rel of [".claude-plugin/plugin.json"]) {
    const m = JSON.parse(read(rel));
    if (m.repository !== repoUrl) problems.push(`${rel} repository is ${m.repository}, expected ${repoUrl}`);
  }
  if (existsSync(join(ROOT, LOCK))) {
    const lock = JSON.parse(read(LOCK));
    if (lock.version !== version) problems.push(`${LOCK} version is ${lock.version}, expected ${version}`);
    const rootPkg = lock.packages?.[""];
    if (rootPkg && rootPkg.version !== version) problems.push(`${LOCK} packages[""].version is ${rootPkg.version}, expected ${version}`);
  }
  problems.push(...repoUrlProblems());
  let pins = 0;
  for (const rel of pinnedDocs()) {
    for (const m of read(rel).matchAll(PIN_RE)) {
      pins++;
      if (m[1] !== REPO) problems.push(`${rel} pins github:${m[1]}, expected github:${REPO}`);
      if (m[2] !== version) problems.push(`${rel} pins v${m[2]}, expected v${version}`);
    }
  }
  if (!existsSync(join(ROOT, "README.md")) || ![...read("README.md").matchAll(PIN_RE)].length) problems.push("README.md has no `github:<repo>#vX.Y.Z` install snippet");
  const top = topChangelogVersion();
  if (top !== version) problems.push(`CHANGELOG.md top entry is ${top ?? "missing"}, expected ${version}`);
  const section = changelogSection(version);
  if (!section) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry`);
  else if (!section.body) problems.push(`CHANGELOG.md entry for ${version} is empty`);
  else if (/\bTODO\b/.test(section.body)) problems.push(`CHANGELOG.md entry for ${version} still says TODO`);
  if (pins === 0) problems.push("no `github:<repo>#vX.Y.Z` install pin found in the docs");
  return problems;
}

export function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function bump(next, today = new Date().toISOString().slice(0, 10)) {
  const current = JSON.parse(read("package.json")).version;
  if (!SEMVER.test(next)) throw new Error(`"${next}" is not a version like 0.2.0`);
  if (cmpSemver(next, current) <= 0) throw new Error(`${next} must be greater than the current ${current}`);

  const changed = [];
  for (const rel of MANIFESTS) {
    const before = read(rel);
    const after = before.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/g, `$1${next}$2`);
    if (after !== before) { write(rel, after); changed.push(rel); }
  }
  if (existsSync(join(ROOT, LOCK))) {
    // Only this package's own versions (top level and packages[""]), never a dependency's.
    const before = read(LOCK);
    const lock = JSON.parse(before);
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const after = JSON.stringify(lock, null, 2).replace(/\n/g, eol) + eol;
    if (after !== before) { write(LOCK, after); changed.push(LOCK); }
  }
  for (const rel of pinnedDocs()) {
    if (rel === "CHANGELOG.md") continue; // history keeps the versions it names
    const before = read(rel);
    const after = before.replace(PIN_RE, (_m, repo) => `github:${repo}#v${next}`);
    if (after !== before) { write(rel, after); changed.push(rel); }
  }

  let log = read("CHANGELOG.md");
  const eol = log.includes("\r\n") ? "\r\n" : "\n";
  const unreleased = /^## \[Unreleased\][ \t]*$/m;
  const u = unreleased.exec(log);
  const afterU = u ? log.slice(u.index + u[0].length) : "";
  const unreleasedBody = u ? afterU.slice(0, afterU.search(/^## \[/m) === -1 ? undefined : afterU.search(/^## \[/m)).trim() : "";
  if (changelogSection(next)) {
    // already written by hand
  } else if (u && unreleasedBody) {
    // the Unreleased notes become this release
    log = log.replace(unreleased, `## [Unreleased]${eol}${eol}## [${next}] - ${today}`);
    write("CHANGELOG.md", log);
    changed.push("CHANGELOG.md");
  } else {
    // nothing written yet: add a stub under Unreleased (or at the top) for the maintainer to fill in
    const stub = `## [${next}] - ${today}${eol}${eol}### Changed${eol}${eol}- TODO: describe this release.${eol}${eol}`;
    const first = u ? u.index + u[0].length + (afterU.length - afterU.trimStart().length) : log.search(/^## \[/m);
    log = first === -1 ? `${log.trimEnd()}${eol}${eol}${stub}` : log.slice(0, first) + stub + log.slice(first);
    write("CHANGELOG.md", log);
    changed.push("CHANGELOG.md (stub: replace the TODO line)");
  }
  return { current, next, changed };
}

function main(argv) {
  const [arg] = argv;
  if (arg === "--check") {
    const problems = check();
    if (problems.length) {
      process.stderr.write(`Release check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`OK: everything is at ${JSON.parse(read("package.json")).version} (github:${REPO})\n`);
    return 0;
  }
  if (arg === "--notes") {
    const version = JSON.parse(read("package.json")).version;
    const section = changelogSection(version);
    if (!section) { process.stderr.write(`No changelog entry for ${version}\n`); return 1; }
    process.stdout.write(`${section.body}\n`);
    return 0;
  }
  if (arg === "--repo") { process.stdout.write(`${REPO}\n`); return 0; }
  if (!arg || arg === "-h" || arg === "--help") {
    process.stdout.write("Usage: node scripts/release.js <X.Y.Z> | --check | --notes | --repo\n");
    return arg ? 0 : 1;
  }
  try {
    const { current, next, changed } = bump(arg);
    const problems = check();
    process.stdout.write(`Bumped ${current} -> ${next}:\n${changed.map((c) => `  ${c}`).join("\n")}\n`);
    if (problems.length) process.stdout.write(`\nStill to fix before tagging:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.stdout.write(`
Next steps (not run for you):
  git switch -c release/v${next}
  git commit -am "chore: release ${next}"
  git push -u origin release/v${next} && gh pr create --fill
  # after the PR is merged into main:
  git switch main && git pull && git tag -a v${next} -m v${next} && git push origin v${next}
  # the Release workflow checks the tag, runs the tests and publishes the GitHub release.
`);
    return problems.length ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
