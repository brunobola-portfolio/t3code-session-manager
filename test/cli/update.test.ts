import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { updateCommand, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { installKind, npmEnv, releaseSpec } from "../../src/ops/update.ts";
import { acquireLock } from "../../src/core/lock.ts";

function fakeIo(o: { tty?: boolean; answer?: string; env?: NodeJS.ProcessEnv } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    isTTY: o.tty ?? false,
    prompt: async (q) => { asked.push(q); return o.answer ?? ""; },
    env: o.env ?? {},
  };
  return { io, out: () => out.join(""), err: () => err.join(""), asked };
}

const SPEC = "github:brunobola-portfolio/t3code-session-manager#semver:*";
const GLOBAL_ROOT = "C:/Users/demo/AppData/Roaming/npm/node_modules/t3code-session-manager";

async function harness(t: { after: (fn: () => Promise<void>) => void }, o: Partial<UpdateDeps> & { versions?: string[]; npmCode?: number } = {}) {
  const state = await mkdtemp(join(tmpdir(), "t3sm-update-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const npmCalls: string[][] = [];
  const versions = [...(o.versions ?? ["0.1.0", "0.2.0"])];
  const deps: UpdateDeps = {
    root: o.root ?? GLOBAL_ROOT,
    home: state,
    readVersion: o.readVersion ?? (() => (versions.length > 1 ? versions.shift()! : versions[0]!)),
    runNpm: o.runNpm ?? (async (args) => { npmCalls.push(args); return o.npmCode ?? 0; }),
    scheduleAdvice: o.scheduleAdvice ?? (async () => []),
  };
  return { deps, npmCalls, env: { T3SM_HOME: join(state, "state") } as NodeJS.ProcessEnv, state };
}

test("installKind: a checkout, a global npm install and the npx cache", () => {
  assert.equal(installKind("C:/work/t3code-session-manager"), "checkout");
  assert.equal(installKind("/home/demo/code/t3code-session-manager"), "checkout");
  assert.equal(installKind("C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\t3code-session-manager"), "global");
  assert.equal(installKind("/usr/local/lib/node_modules/t3code-session-manager"), "global");
  assert.equal(installKind("C:\\Users\\demo\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\t3code-session-manager"), "npx");
  assert.equal(installKind("/home/demo/.npm/_npx/1a2b3c/node_modules/t3code-session-manager"), "npx");
});

test("releaseSpec: the newest release tag of the repository in package.json", () => {
  assert.equal(releaseSpec("https://github.com/brunobola-portfolio/t3code-session-manager.git"), SPEC);
  assert.equal(releaseSpec("git+https://github.com/brunobola-portfolio/t3code-session-manager"), SPEC);
  assert.throws(() => releaseSpec("https://example.com/x.git"));
});

test("npmEnv: npm never inherits CLAUDE_CONFIG_DIR", () => {
  const env = npmEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/demo/.claude-work", claude_config_dir: "x" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("update in a checkout explains git and installs nothing", async (t) => {
  const h = await harness(t, { root: "C:/work/t3code-session-manager" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 0);
  assert.equal(h.npmCalls.length, 0);
  assert.match(f.out(), /git checkout/);
  assert.match(f.out(), /git -C "C:\/work\/t3code-session-manager" pull/);
});

test("update from the npx cache explains how to install once and installs nothing", async (t) => {
  const h = await harness(t, { root: "/home/demo/.npm/_npx/1a2b3c/node_modules/t3code-session-manager" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 0);
  assert.equal(h.npmCalls.length, 0);
  assert.match(f.out(), new RegExp(`npm install -g ${SPEC.replace(/[*]/g, "\\*")}`));
});

test("update off a terminal without --yes refuses (exit 2) and installs nothing", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 2);
  assert.equal(h.npmCalls.length, 0);
  assert.match(f.err(), /--yes/);
});

test("update --dry-run prints the npm command and installs nothing", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--dry-run"], f.io, h.deps), 0);
  assert.equal(h.npmCalls.length, 0);
  assert.match(f.out(), /Would run: npm install -g github:brunobola-portfolio\/t3code-session-manager#semver:\*/);
});

test("update on a terminal asks first; Enter means no", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ tty: true, answer: "", env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 0);
  assert.equal(h.npmCalls.length, 0);
  assert.equal(f.asked.length, 1);
  assert.match(f.out(), /Nothing changed/);
});

test("update --yes installs the newest release and reports the versions", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmCalls, [["install", "-g", SPEC]]);
  assert.match(f.out(), /Updated t3sm 0\.1\.0 -> 0\.2\.0/);
});

test("update --yes when already on the newest release says so", async (t) => {
  const h = await harness(t, { versions: ["0.1.0"] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.match(f.out(), /already the newest release \(0\.1\.0\)/);
});

test("update prints the background-sync advice after installing", async (t) => {
  const h = await harness(t, { scheduleAdvice: async () => ["Run `t3sm schedule install` again."] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.match(f.out(), /Run `t3sm schedule install` again\./);
});

test("a failed npm install exits 1 and says the old version stays", async (t) => {
  const h = await harness(t, { npmCode: 1 });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 1);
  assert.match(f.err(), /still 0\.1\.0/);
});

test("npm not found (127) says to install Node.js with npm", async (t) => {
  const h = await harness(t, { npmCode: 127 });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 1);
  assert.match(f.err(), /npm was not found/);
});

test("update waits for a running t3sm: lock taken -> nothing installed, exit 0", async (t) => {
  const h = await harness(t);
  const lock = await acquireLock(h.env["T3SM_HOME"]!);
  assert.ok(lock);
  t.after(() => lock.release());
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.equal(h.npmCalls.length, 0);
  assert.match(f.out(), /Another t3sm run is in progress/);
});

test("update rejects unknown options and --yes with --dry-run", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--force"], f.io, h.deps), 2);
  assert.equal(await updateCommand(["--yes", "--dry-run"], f.io, h.deps), 2);
  assert.equal(h.npmCalls.length, 0);
});

test("t3sm update --help and the main usage list the command", async () => {
  const f = fakeIo();
  assert.equal(await main(["update", "--help"], f.io), 0);
  assert.match(f.out(), /Usage: t3sm update/);
  const g = fakeIo();
  assert.equal(await main(["--help"], g.io), 0);
  assert.match(g.out(), /t3sm update/);
});
