import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAccountHomes, nodeDiscoveryEnv, type DiscoveredHome } from "../../src/ops/discoverAccounts.ts";
import { detectAccounts } from "../../src/core/config.ts";
import { sameCwd } from "../../src/core/paths.ts";
import type { InstanceSpec } from "../../src/core/types.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

/** <root>/home is the user home; <root>/elsewhere is outside it. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "t3sm-disc-"));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const acct = (p: string, withProjects = true) => { mkdirSync(withProjects ? join(p, "projects") : p, { recursive: true }); return p; };
  const file = (rel: string, text: string) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  return { root, home, acct, file };
}

const fwd = (p: string) => p.replace(/\\/g, "/");
function find(found: DiscoveredHome[], p: string): DiscoveredHome | undefined {
  return found.find((f) => sameCwd(f.home, p));
}
const run = (home: string, extra: { env?: NodeJS.ProcessEnv; instanceHomes?: string[]; projectRoots?: string[] } = {}) =>
  discoverAccountHomes(nodeDiscoveryEnv({ home, platform: process.platform, env: extra.env ?? {}, instanceHomes: extra.instanceHomes, projectRoots: extra.projectRoots }));

test("PowerShell function alias: home found via folder and shell profile, alias captured", async () => {
  const w = world();
  w.acct(join(w.home, ".claude"));
  w.acct(join(w.home, ".claude-work"));
  w.file("Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
    "# Claude Code - work account\r\nfunction claude-work {\r\n    $env:CLAUDE_CONFIG_DIR = \"$HOME\\.claude-work\"\r\n    claude $args\r\n}\r\n");
  const found = await run(w.home);
  const def = find(found, join(w.home, ".claude"));
  assert.deepEqual(def?.sources, ["default"]);
  const work = find(found, join(w.home, ".claude-work"));
  assert.ok(work, JSON.stringify(found));
  assert.deepEqual(work.sources, ["folder", "shell-profile"]);
  assert.equal(work.alias, "claude-work");
  assert.equal(found[0]!.sources[0], "default", "default first");
});

test("bash alias with unquoted ~ path, outside ~/.claude-*; also the current env: merged sources", async () => {
  const w = world();
  const work = w.acct(join(w.home, "accts", "work"));
  w.file(".bashrc", "alias cw=\"CLAUDE_CONFIG_DIR=~/accts/work claude\"\n");
  const found = await run(w.home, { env: { CLAUDE_CONFIG_DIR: work } });
  const f = find(found, work);
  assert.ok(f, JSON.stringify(found));
  assert.deepEqual(f.sources, ["shell-profile", "env"]);
  assert.equal(f.alias, "cw");
});

test("export with $HOME (unquoted) and ${HOME} (quoted) in zsh/bash profiles; no enclosing alias -> alias null", async () => {
  const w = world();
  const zed = w.acct(join(w.home, "accts", "zed"));
  const bp = w.acct(join(w.home, "accts", "bp"));
  w.file(".zshrc", "export CLAUDE_CONFIG_DIR=$HOME/accts/zed\n");
  w.file(".bash_profile", "export CLAUDE_CONFIG_DIR=\"${HOME}/accts/bp\"\n");
  const found = await run(w.home);
  assert.equal(find(found, zed)?.alias, null);
  assert.deepEqual(find(found, zed)?.sources, ["shell-profile"]);
  assert.ok(find(found, bp), JSON.stringify(found));
});

test("bash function forms name() { ... } capture the function name; CLAUDE_SECURESTORAGE_CONFIG_DIR is not evidence", async () => {
  const w = world();
  const fn = w.acct(join(w.home, "accts", "fn"));
  const sec = w.acct(join(w.home, "accts", "secure"));
  w.file(".bashrc", [
    "code-fn() {",
    "    CLAUDE_SECURESTORAGE_CONFIG_DIR=~/accts/secure CLAUDE_CONFIG_DIR=~/accts/fn code \"$@\"",
    "}",
    "export CLAUDE_SECURESTORAGE_CONFIG_DIR=~/accts/secure",
  ].join("\n"));
  const found = await run(w.home);
  assert.equal(find(found, fn)?.alias, "code-fn");
  assert.equal(find(found, sec), undefined);
});

test("fish set -x inside function ... end captures the function name", async () => {
  const w = world();
  const fishy = w.acct(join(w.home, "accts", "fishy"));
  const one = w.acct(join(w.home, "accts", "one"));
  w.file(".config/fish/config.fish", [
    "function cf --wraps claude",
    "    if true",
    "        set -gx CLAUDE_CONFIG_DIR $HOME/accts/fishy",
    "    end",
    "    claude $argv",
    "end",
    "function c1; set -lx CLAUDE_CONFIG_DIR '~/accts/one'; claude $argv; end",
  ].join("\n"));
  const found = await run(w.home);
  assert.equal(find(found, fishy)?.alias, "cf");
  assert.equal(find(found, one)?.alias, "c1");
});

test("PowerShell: $env:USERPROFILE and %USERPROFILE%, one-line function, OneDrive-redirected Windows PowerShell profile", async () => {
  const w = world();
  const a = w.acct(join(w.home, "accts", "ps2"));
  const b = w.acct(join(w.home, "accts", "od"));
  w.file("Documents/PowerShell/profile.ps1", "function claude-ps2 { $env:CLAUDE_CONFIG_DIR = \"$env:USERPROFILE\\accts\\ps2\"; claude @args }\n");
  w.file("OneDrive/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1", "function Claude-OD {\n  $Env:CLAUDE_CONFIG_DIR='%USERPROFILE%/accts/od'\n  claude\n}\n");
  const found = await run(w.home);
  assert.equal(find(found, a)?.alias, "claude-ps2");
  assert.equal(find(found, b)?.alias, "Claude-OD");
});

test("a variable mentioned only in comments is ignored (# lines, trailing #, PowerShell <# #> blocks)", async () => {
  const w = world();
  const c1 = w.acct(join(w.home, "accts", "c1"));
  const c2 = w.acct(join(w.home, "accts", "c2"));
  const c3 = w.acct(join(w.home, "accts", "c3"));
  w.file(".bashrc", "# export CLAUDE_CONFIG_DIR=~/accts/c1\n   # alias x=\"CLAUDE_CONFIG_DIR=~/accts/c1 claude\"\necho hi # CLAUDE_CONFIG_DIR=~/accts/c2\n");
  w.file("Documents/PowerShell/Microsoft.PowerShell_profile.ps1", "<#\n$env:CLAUDE_CONFIG_DIR = \"$HOME\\accts\\c3\"\n#>\n");
  const found = await run(w.home);
  for (const p of [c1, c2, c3]) assert.equal(find(found, p), undefined, p);
});

test("a candidate without projects/ (or missing) is not an account; a home outside the user profile is kept", async () => {
  const w = world();
  w.acct(join(w.home, "accts", "empty"), false);
  const outside = w.acct(join(w.root, "elsewhere", "acct"));
  w.file(".bashrc", [
    "alias e1='CLAUDE_CONFIG_DIR=~/accts/empty claude'",
    "alias e2='CLAUDE_CONFIG_DIR=~/accts/missing claude'",
    `alias out='CLAUDE_CONFIG_DIR="${fwd(outside)}" claude'`,
    "alias rel='CLAUDE_CONFIG_DIR=relative/dir claude'",
    "alias unk='CLAUDE_CONFIG_DIR=$SOMEVAR/x claude'",
  ].join("\n"));
  const found = await run(w.home);
  assert.deepEqual(found.map((f) => f.alias), ["out"]);
  assert.ok(sameCwd(found[0]!.home, outside));
});

test("vscode pin of a known project root (~/.claude.json projects) and a T3 instance home are sources", async () => {
  const w = world();
  const pinned = w.acct(join(w.home, "accts", "pinned"));
  const t3 = w.acct(join(w.root, "t3acct"));
  const proj = join(w.root, "work", "demo");
  mkdirSync(join(proj, ".vscode"), { recursive: true });
  writeFileSync(join(proj, ".vscode", "settings.json"), `{\n  // pin\n  "claudeCode.environmentVariables": [{ "name": "CLAUDE_CONFIG_DIR", "value": "~/accts/pinned" }],\n}\n`);
  w.file(".claude.json", JSON.stringify({ projects: { [fwd(proj)]: {} } }));
  const found = await run(w.home, { instanceHomes: [t3] });
  assert.deepEqual(find(found, pinned)?.sources, ["vscode-pin"]);
  assert.deepEqual(find(found, t3)?.sources, ["t3-instance"]);
});

test("detectAccounts with discovered extras: ids from instance, claudeAgent, alias, folder; unique with -2", async () => {
  const w = world();
  w.acct(join(w.home, ".claude"));
  w.acct(join(w.home, ".claude-org"));
  const work = w.acct(join(w.home, "accts", "work"));
  const t3 = w.acct(join(w.root, "t3acct"));
  const dup = w.acct(join(w.home, "accts", "dup"));
  const existing: InstanceSpec[] = [{ id: "mine", driver: "claudeAgent", displayName: "Mine", accentColor: "#112233", homePath: fwd(t3), environment: [] }];
  const accs = await detectAccounts(w.home, existing, [
    { home: fwd(work), alias: "cw" },
    { home: fwd(t3), alias: "ignored" },
    { home: fwd(dup), alias: "claude-org" },
    { home: fwd(join(w.home, "accts", "nope")), alias: "nope" },
  ]);
  const byHome = (p: string) => accs.find((a) => sameCwd(a.home, p));
  assert.equal(byHome(join(w.home, ".claude"))?.id, "claudeAgent");
  assert.equal(byHome(join(w.home, ".claude-org"))?.id, "claude-org");
  assert.equal(byHome(work)?.id, "cw");
  assert.equal(byHome(t3)?.id, "mine");
  assert.equal(byHome(t3)?.displayName, "Mine");
  assert.equal(byHome(dup)?.id, "claude-org-2");
  assert.equal(accs.length, 5, "no account for a missing home");
  for (const a of accs) assert.ok(!JSON.stringify(a).includes("@"));
});

test("heredoc / here-string bodies and echo-like lines are not evidence; Remove-Item Env: is ignored", async () => {
  const w = world();
  const names = ["h1", "h2", "h3", "e1", "e2", "e3", "r1", "ok"];
  const d = Object.fromEntries(names.map((n) => [n, w.acct(join(w.home, "accts", n))]));
  w.file(".bashrc", [
    "cat > /tmp/x <<EOF",
    "export CLAUDE_CONFIG_DIR=~/accts/h1",
    "EOF",
    "cat <<-'END'",
    "\tCLAUDE_CONFIG_DIR=~/accts/h2 claude",
    "\tEND",
    "echo \"export CLAUDE_CONFIG_DIR=~/accts/e1\"",
    String.raw`  printf 'CLAUDE_CONFIG_DIR=~/accts/e2 claude\n'`,
    "grep x <<< \"a\"",
    "export CLAUDE_CONFIG_DIR=~/accts/ok",
  ].join("\n"));
  w.file("Documents/PowerShell/Microsoft.PowerShell_profile.ps1", [
    "$help = @\"",
    "$env:CLAUDE_CONFIG_DIR = \"$HOME/accts/h3\"",
    "\"@",
    "Write-Host '$env:CLAUDE_CONFIG_DIR = \"$HOME/accts/e3\"'",
    "Remove-Item Env:CLAUDE_CONFIG_DIR",
    String.raw`Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue`,
  ].join("\n"));
  const found = await run(w.home);
  for (const n of ["h1", "h2", "h3", "e1", "e2", "e3", "r1"]) assert.equal(find(found, d[n]!), undefined, n);
  assert.ok(find(found, d["ok"]!), "assignment after the heredoc is still read");
});

test("PowerShell: Join-Path with quoted arguments containing spaces; backtick (not backslash) escapes inside double quotes", async () => {
  const w = world();
  const sp = w.acct(join(w.home, "My Accounts", "claude work"));
  const c = w.acct(join(w.home, "accts", "commented"));
  const after = w.acct(join(w.home, "accts", "after"));
  w.file("Documents/PowerShell/Microsoft.PowerShell_profile.ps1", [
    String.raw`function claude-sp { $env:CLAUDE_CONFIG_DIR = (Join-Path -Path "$HOME\My Accounts" -ChildPath 'claude work'); claude @args }`,
    String.raw`$tmp = "C:\temp\" # $env:CLAUDE_CONFIG_DIR = "$HOME\accts\commented"`,
    String.raw`$q = "say ` + "`\"hi`\"" + String.raw` # not a comment"; $env:CLAUDE_CONFIG_DIR = "$HOME\accts\after"`,
  ].join("\n"));
  const found = await run(w.home);
  assert.equal(find(found, sp)?.alias, "claude-sp");
  assert.equal(find(found, c), undefined, "a comment after a string ending in a backslash is a comment");
  assert.ok(find(found, after), "a backtick-escaped quote does not end the string");
});

test("resolveAccounts = discovery + detectAccounts: an alias-only home gets its alias id", async () => {
  const { resolveAccounts } = await import("../../src/ops/discoverAccounts.ts");
  const w = world();
  w.acct(join(w.home, ".claude"));
  const work = w.acct(join(w.home, "accts", "work"));
  w.file(".bashrc", "alias cw='CLAUDE_CONFIG_DIR=~/accts/work claude'\n");
  const accs = await resolveAccounts(w.home, [], {});
  assert.deepEqual(accs.map((a) => a.id), ["claudeAgent", "cw"]);
  assert.ok(sameCwd(accs[1]!.home, work));
});
