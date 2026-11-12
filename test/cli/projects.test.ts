import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { main, type Io } from "../../src/cli/main.ts";
import { projectsCommand, type ProjectsDeps } from "../../src/cli/commands/projects.ts";
import { Journal } from "../../src/core/journal.ts";
import { normalizeCwd } from "../../src/core/paths.ts";
import { rollbackRun } from "../../src/ops/rollback.ts";
import { normalizeFolder, otherFoldersChanged, setRoute, unsetRoute } from "../../src/ops/projects.ts";
import { defaultConfig, routeAccount } from "../../src/core/config.ts";
import { T3NotRunning } from "../../src/t3/errors.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { fakeT3, inst, type FakeT3 } from "../apply/fake-t3.ts";
import { sess } from "../plan/helpers.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const down = async (): Promise<never> => { throw new T3NotRunning(); };

function adapter(sessions: DiscoveredSession[]): SourceAdapter {
  return { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { for (const s of sessions) yield s; } } as SourceAdapter;
}

function setup(o: { routes?: { match: string; account: string }[]; noConfig?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "t3sm-projects-"));
  temps.push(home);
  const state = join(home, "state");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude-work", "projects"), { recursive: true });
  const demo = normalizeCwd(join(home, "work", "demo"));
  const other = normalizeCwd(join(home, "work", "other"));
  mkdirSync(demo, { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(state, { recursive: true });
  if (!o.noConfig) {
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      accounts: [
        { id: "claudeAgent", home: "~/.claude", displayName: "Claude · Personal", accentColor: null },
        { id: "claude-work", home: "~/.claude-work", displayName: "Claude · Work", accentColor: null },
      ],
      defaultAccount: "claudeAgent",
      routes: o.routes ?? [],
    }, null, 2) + "\n");
  }
  const old = Date.now() - 40 * 86_400_000;
  const sessions = [sess({ cwd: demo, mtimeMs: old, path: join(home, ".claude", "projects", "x", "a.jsonl") }), sess({ cwd: demo, mtimeMs: old, path: join(home, ".claude", "projects", "x", "b.jsonl") })];
  const t3 = fakeT3({ instances: [inst("claudeAgent", join(home, ".claude")), inst("claude-work", join(home, ".claude-work"))] });
  const out: string[] = [];
  const err: string[] = [];
  const answers: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false,
    prompt: async () => answers.shift() ?? "", env: { T3SM_HOME: state },
  };
  const deps = (connect: ProjectsDeps["connect"] = async () => t3.api): ProjectsDeps => ({ home, adapters: [adapter(sessions)], connect, now: () => Date.now() });
  return { home, state, demo, other, t3, io, out: () => out.join(""), err: () => err.join(""), answers, deps, config: () => readFileSync(join(state, "config.json"), "utf8") };
}

function project(t3: FakeT3, root: string, instanceId: string | null, archived = false): void {
  t3.projects.push({ id: `p${t3.projects.length + 1}`, title: root.split("/").pop()!, workspaceRoot: root, defaultModelSelection: instanceId === null ? null : { instanceId, model: "m" } as never, archived, deleted: false });
}

test("setRoute: inserts the exact-folder route right before the first glob matching it, replaces an existing one in place, never reorders", () => {
  const c = { ...defaultConfig([{ id: "a", home: "/h/a", displayName: "A", accentColor: null }, { id: "b", home: "/h/b", displayName: "B", accentColor: null }]),
    routes: [{ match: "/w/**", account: "a" }, { match: "/x", account: "a" }, { match: "/w/c*", account: "b" }] };
  const r = setRoute(c, "/w/demo", "b", "linux");
  assert.deepEqual(r.config.routes, [{ match: "/w/demo", account: "b" }, { match: "/w/**", account: "a" }, { match: "/x", account: "a" }, { match: "/w/c*", account: "b" }]);
  assert.equal(r.previous, null);
  const again = setRoute(r.config, "/w/demo/", "a", "linux");
  assert.equal(again.previous, "b");
  assert.equal(again.config.routes.filter((x) => x.match === "/w/demo").length, 1);
  assert.equal(again.config.routes.find((x) => x.match === "/w/demo")!.account, "a");
  assert.equal(setRoute(again.config, "/w/demo", "a", "linux").changed, false);
  const u = unsetRoute(again.config, "/w/demo", "linux");
  assert.equal(u.removed, "a");
  assert.deepEqual(u.config.routes, [{ match: "/w/**", account: "a" }, { match: "/x", account: "a" }, { match: "/w/c*", account: "b" }], "globs untouched");
  assert.equal(unsetRoute(u.config, "/w/**", "linux").removed, null, "unset never removes a glob");
  assert.deepEqual(setRoute(c, "/elsewhere", "b", "linux").config.routes.at(-1), { match: "/elsewhere", account: "b" }, "no glob matches: appended");
});

test("setRoute never changes another folder's account (an exact route shadowed by an earlier glob stays shadowed)", () => {
  const c = { ...defaultConfig([{ id: "a", home: "D:/h/a", displayName: "A", accentColor: null }, { id: "b", home: "D:/h/b", displayName: "B", accentColor: null }]),
    routes: [{ match: "D:/w/**", account: "a" }, { match: "D:/w/x", account: "b" }] };
  const roots = ["D:/w/x", "D:/w/y", "D:/other"];
  assert.equal(routeAccount("D:/w/x", c, "win32"), "a");
  for (const [folder, acct] of [["D:/other", "a"], ["D:/w/y", "b"], ["d:/W/Y/", "a"]] as const) {
    const r = setRoute(c, folder, acct, "win32");
    assert.equal(routeAccount("D:/w/x", r.config, "win32"), "a", `setting ${folder}`);
    assert.deepEqual(otherFoldersChanged(c, r.config, roots, folder, "win32"), [], `setting ${folder}`);
    assert.equal(routeAccount(folder, r.config, "win32"), acct);
  }
  assert.deepEqual(setRoute(c, "D:/w/y", "b", "win32").config.routes, [{ match: "D:/w/y", account: "b" }, { match: "D:/w/**", account: "a" }, { match: "D:/w/x", account: "b" }]);
  const moved = { ...c, routes: [c.routes[1]!, c.routes[0]!] };
  assert.deepEqual(otherFoldersChanged(c, moved, roots, "D:/other", "win32"), ["D:/w/x"], "the guard sees a reorder");
});

test("setRoute: the folder always ends on the account asked for (shadowed own route, odd spellings, case on macOS)", () => {
  const base = defaultConfig([{ id: "A", home: "D:/h/a", displayName: "A", accentColor: null }, { id: "B", home: "D:/h/b", displayName: "B", accentColor: null }, { id: "C", home: "D:/h/c", displayName: "C", accentColor: null }]);
  const at = (routes: { match: string; account: string }[], folder: string, platform: NodeJS.Platform) => {
    const r = setRoute({ ...base, routes }, folder, "A", platform);
    return { r, got: routeAccount(folder, r.config, platform) };
  };
  const shadowed = at([{ match: "C:/work/**", account: "B" }, { match: "C:/work/demo", account: "C" }], "C:/work/demo", "win32");
  assert.equal(shadowed.got, "A");
  assert.deepEqual(shadowed.r.config.routes, [{ match: "C:/work/demo", account: "A" }, { match: "C:/work/**", account: "B" }]);
  assert.equal(shadowed.r.before, "B", "the account it had (through the glob)");
  assert.equal(shadowed.r.previous, "C", "its own route's account");
  assert.equal(routeAccount("C:/work/x", shadowed.r.config, "win32"), "B");
  for (const spelled of ["C:/work/demo/", "C:/work/x/../demo", "C:\\work\\demo", "c:/WORK/Demo"]) {
    const s = at([{ match: spelled, account: "C" }, { match: "C:/work/**", account: "B" }], "C:/work/demo", "win32");
    assert.equal(s.got, "A", spelled);
    assert.deepEqual(s.r.config.routes, [{ match: "C:/work/demo", account: "A" }, { match: "C:/work/**", account: "B" }], spelled);
  }
  const mac = at([{ match: "/Users/u/Work/demo", account: "C" }, { match: "/Users/u/**", account: "B" }], "/Users/u/work/demo", "darwin");
  assert.equal(mac.got, "A");
  assert.equal(routeAccount("/Users/u/x", mac.r.config, "darwin"), "B");
  const linux = at([{ match: "/home/u/Work/demo", account: "C" }], "/home/u/work/demo", "linux");
  assert.equal(linux.got, "A");
  assert.equal(routeAccount("/home/u/Work/demo", linux.r.config, "linux"), "C", "another folder on a case-sensitive system");
  assert.equal(at([{ match: "C:/work/demo", account: "A" }], "C:/work/demo", "win32").r.changed, false);
  assert.throws(() => setRoute(base, "/home/u/a*b", "A", "linux"), /contains \* or \?/);
  assert.throws(() => setRoute(base, "/home/u/what?", "A", "linux"), /contains \* or \?/);
});

test("normalizeFolder expands ~ before resolving", () => {
  assert.equal(normalizeFolder("~/work/x", "win32", "C:\\Users\\demo"), "C:/Users/demo/work/x");
  assert.equal(normalizeFolder("~", "linux", "/home/demo"), "/home/demo");
  assert.equal(normalizeFolder("d:\\Work\\X\\", "win32", "C:\\Users\\demo"), "D:/Work/X");
});

test("projects --json lists each project with account, reason, pending sessions and T3 state", async () => {
  const s = setup();
  project(s.t3, s.demo, "claudeAgent");
  assert.equal(await projectsCommand(["--json"], s.io, s.deps()), 0, s.err());
  const rows = JSON.parse(s.out()) as { folder: string; account: string; accountName: string; reason: string; pending: number; inT3: string; held: boolean }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.folder, s.demo);
  assert.equal(rows[0]!.account, "claudeAgent");
  assert.equal(rows[0]!.accountName, "Claude · Personal");
  assert.equal(rows[0]!.reason, "recent-activity");
  assert.equal(rows[0]!.pending, 2);
  assert.equal(rows[0]!.inT3, "yes");
  assert.equal(rows[0]!.held, false);
  assert.ok(s.t3.calls.includes("close"), "the T3 session is closed");
  assert.ok(!s.t3.calls.some((c) => c.startsWith("default:") || c.startsWith("create:")), "read-only");
});

test("projects table: header, one line per project; an archived project says so", async () => {
  const s = setup();
  project(s.t3, s.demo, null, true);
  assert.equal(await projectsCommand([], s.io, s.deps()), 0, s.err());
  assert.match(s.out(), /Folder\s+Account\s+Reason\s+Pending\s+In T3 Code\s+In use/);
  assert.match(s.out(), /demo\s+Claude · Personal\s+recent-activity\s+2\s+archived\s+no/);
});

test("projects with T3 Code not running shows the local columns, says so and exits 0", async () => {
  const s = setup();
  assert.equal(await projectsCommand([], s.io, s.deps(down)), 0, s.err());
  assert.match(s.out(), /T3 Code is not running/);
  assert.match(s.out(), /demo\s+Claude · Personal\s+recent-activity\s+2/);
  assert.doesNotMatch(s.out(), /In T3 Code/);
});

test("projects set writes an exact-folder route before the globs (T3 Code down: route only, says so)", async () => {
  const s = setup({ routes: [{ match: "~/work/**", account: "claudeAgent" }] });
  assert.equal(await projectsCommand(["set", s.demo, "claude-work", "--yes"], s.io, s.deps(down)), 0, s.err());
  const c = JSON.parse(s.config());
  assert.deepEqual(c.routes, [{ match: s.demo, account: "claude-work" }, { match: "~/work/**", account: "claudeAgent" }], "glob kept as written, exact first");
  assert.equal(c.accounts[0].home, "~/.claude", "the file's own spelling is kept");
  assert.match(s.out(), /T3 Code is not running/);
  assert.match(s.out(), /already in T3 Code keep their account/);
});

test("projects set: ~ is the home folder; a folder t3sm does not know as a project gets a note; the result says what the route decides", async () => {
  const s = setup();
  project(s.t3, s.demo, "claudeAgent");
  assert.equal(await projectsCommand(["set", "~/work/demo", "claude-work", "--yes"], s.io, s.deps(down)), 0, s.err());
  assert.deepEqual(JSON.parse(s.config()).routes, [{ match: s.demo, account: "claude-work" }]);
  assert.match(s.out(), /New threads here start on Claude · Work, and OpenCode \/ compressed Codex sessions not imported yet go to it; Claude Code sessions keep the account they were recorded in\./);
  const known = setup();
  project(known.t3, known.demo, "claudeAgent");
  assert.equal(await projectsCommand(["set", known.demo, "claude-work", "--yes"], known.io, known.deps()), 0, known.err());
  assert.doesNotMatch(known.out(), /not a project folder t3sm knows/);
  assert.equal(await projectsCommand(["set", known.other, "claude-work", "--yes"], known.io, known.deps()), 0, known.err());
  assert.match(known.out(), /Note: .*other is not a project folder t3sm knows \(not in T3 Code or in the latest plan\)\. A route applies to that exact folder only, not to its sub-folders\./);
  const unset = setup();
  assert.equal(await projectsCommand(["unset", "~/work/demo"], unset.io, unset.deps(down)), 0);
  assert.match(unset.out(), /No route for .*work\/demo/);
});

test("projects set: a folder whose own route was shadowed by an earlier glob really changes account; the message says what it was", async () => {
  const s = setup();
  const c0 = JSON.parse(s.config());
  c0.routes = [{ match: "~/work/**", account: "claude-work" }, { match: `${s.demo}/`, account: "claudeAgent" }];
  writeFileSync(join(s.state, "config.json"), JSON.stringify(c0));
  assert.equal(await projectsCommand(["set", s.demo, "claudeAgent", "--yes"], s.io, s.deps(down)), 0, s.err());
  assert.deepEqual(JSON.parse(s.config()).routes, [{ match: s.demo, account: "claudeAgent" }, { match: "~/work/**", account: "claude-work" }]);
  assert.match(s.out(), /was Claude · Work/);
});

test("projects set replaces the folder's route; the folder may be given in any spelling", async () => {
  const s = setup({ routes: [{ match: "X", account: "claudeAgent" }] });
  const c0 = JSON.parse(s.config());
  c0.routes = [{ match: s.demo, account: "claudeAgent" }];
  writeFileSync(join(s.state, "config.json"), JSON.stringify(c0));
  const spelled = join(s.demo, "..", "demo") + "/";
  assert.equal(await projectsCommand(["set", spelled, "claude-work", "--yes"], s.io, s.deps(down)), 0, s.err());
  assert.deepEqual(JSON.parse(s.config()).routes, [{ match: s.demo, account: "claude-work" }]);
  assert.match(s.out(), /was Claude · Personal/);
});

test("projects set: unknown account, missing folder (without --force) and a non-TTY without --yes exit 2 and write nothing", async () => {
  const s = setup();
  const before = s.config();
  assert.equal(await projectsCommand(["set", s.demo, "nobody", "--yes"], s.io, s.deps(down)), 2);
  assert.match(s.err(), /No account "nobody"/);
  const ghost = join(s.home, "work", "ghost");
  assert.equal(await projectsCommand(["set", ghost, "claude-work", "--yes"], s.io, s.deps(down)), 2);
  assert.match(s.err(), /does not exist.*--force/s);
  assert.equal(await projectsCommand(["set", s.demo, "claude-work"], s.io, s.deps(down)), 2);
  assert.match(s.err(), /--yes/);
  assert.equal(s.config(), before);
  assert.equal(await projectsCommand(["set", ghost, "claude-work", "--yes", "--force"], s.io, s.deps(down)), 0, s.err());
  assert.equal(JSON.parse(s.config()).routes[0].match, normalizeCwd(ghost));
});

test("projects set --dry-run prints the change and writes nothing (T3 Code only read)", async () => {
  const s = setup();
  project(s.t3, s.demo, "claudeAgent");
  const before = s.config();
  assert.equal(await projectsCommand(["set", s.demo, "claude-work", "--dry-run"], s.io, s.deps()), 0, s.err());
  assert.equal(s.config(), before);
  assert.match(s.out(), /Would add a route/);
  assert.match(s.out(), /Would set .*Claude · Work/);
  assert.match(s.out(), /Dry run: nothing was written/);
  assert.ok(!s.t3.calls.some((c) => c.startsWith("default:")));
  assert.ok(!existsJournal(s.state));
});

function existsJournal(state: string): boolean {
  try { readFileSync(join(state, "journal.jsonl")); return true; } catch { return false; }
}

test("projects set with T3 Code running sets the project's default (journaled) and rollback undoes it", async () => {
  const s = setup();
  project(s.t3, s.demo, "claudeAgent");
  assert.equal(await projectsCommand(["set", s.demo, "claude-work", "--yes"], s.io, s.deps()), 0, s.err());
  assert.ok(s.t3.calls.includes("default:p1:claude-work"), s.t3.calls.join(","));
  const j = new Journal(join(s.state, "journal.jsonl"));
  const entries = await j.readAll();
  const start = entries.find((e) => e.t === "run-start");
  assert.ok(start && start.t === "run-start" && start.command === "projects set");
  assert.ok(entries.some((e) => e.t === "project-default-set" && e.projectId === "p1"));
  assert.ok(entries.some((e) => e.t === "run-end" && e.status === "ok"));
  assert.match(s.out(), /rollback --run /);
  const r = await rollbackRun(start.runId, { journal: j, accountHomes: [], connect: async () => s.t3.api, now: () => Date.now() });
  assert.deepEqual(r.defaultsRestored, ["p1"]);
  assert.equal((s.t3.projects[0]!.defaultModelSelection as unknown as { instanceId: string }).instanceId, "claudeAgent");
});

test("projects set on a terminal asks first: no changes nothing, yes writes", async () => {
  const s = setup();
  project(s.t3, s.demo, "claudeAgent");
  const before = s.config();
  s.answers.push("no");
  assert.equal(await projectsCommand(["set", s.demo, "claude-work"], { ...s.io, isTTY: true }, s.deps()), 0);
  assert.match(s.out(), /Nothing changed/);
  assert.equal(s.config(), before);
  assert.ok(!s.t3.calls.some((c) => c.startsWith("default:")));
  s.answers.push("yes");
  assert.equal(await projectsCommand(["set", s.demo, "claude-work"], { ...s.io, isTTY: true }, s.deps()), 0);
  assert.equal(JSON.parse(s.config()).routes.length, 1);
  assert.ok(s.t3.calls.includes("default:p1:claude-work"));
});

test("projects set when everything is already so changes nothing and does not ask", async () => {
  const s = setup();
  project(s.t3, s.demo, "claude-work");
  const c0 = JSON.parse(s.config());
  c0.routes = [{ match: s.demo, account: "claude-work" }];
  writeFileSync(join(s.state, "config.json"), JSON.stringify(c0));
  let asked = 0;
  assert.equal(await projectsCommand(["set", s.demo, "claude-work"], { ...s.io, isTTY: true, prompt: async () => { asked++; return "yes"; } }, s.deps()), 0);
  assert.match(s.out(), /Nothing to change/);
  assert.equal(asked, 0);
  assert.ok(!existsJournal(s.state));
});

test("projects set while another run holds the lock touches nothing (exit 0)", async () => {
  const s = setup();
  writeFileSync(join(s.state, "lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }));
  const before = s.config();
  let signalled = 0;
  assert.equal(await projectsCommand(["set", s.demo, "claude-work", "--yes"], { ...s.io, onLockBusy: () => { signalled++; } }, s.deps()), 0);
  assert.match(s.out(), /Another t3sm run is in progress/);
  assert.equal(signalled, 1, "the structured lock-busy signal");
  assert.equal(s.config(), before);
});

test("projects unset removes the exact-folder route only and says T3 Code is unchanged; --dry-run writes nothing", async () => {
  const s = setup({ routes: [{ match: "X", account: "claudeAgent" }] });
  const c0 = JSON.parse(s.config());
  c0.routes = [{ match: s.demo, account: "claude-work" }, { match: "~/work/**", account: "claudeAgent" }];
  writeFileSync(join(s.state, "config.json"), JSON.stringify(c0));
  const before = s.config();
  assert.equal(await projectsCommand(["unset", s.demo, "--dry-run"], s.io, s.deps(down)), 0);
  assert.equal(s.config(), before);
  assert.match(s.out(), /Would remove/);
  assert.equal(await projectsCommand(["unset", s.demo], s.io, s.deps(down)), 0);
  assert.deepEqual(JSON.parse(s.config()).routes, [{ match: "~/work/**", account: "claudeAgent" }]);
  assert.match(s.out(), /T3 Code was not changed/);
  assert.equal(await projectsCommand(["unset", s.demo], s.io, s.deps(down)), 0);
  assert.match(s.out(), /No route for/);
});

test("projects: usage errors exit 2; help is per command and the main usage lists projects", async () => {
  const s = setup();
  assert.equal(await projectsCommand(["set", s.demo], s.io, s.deps(down)), 2);
  assert.equal(await projectsCommand(["bogus"], s.io, s.deps(down)), 2);
  assert.equal(await projectsCommand(["--nope"], s.io, s.deps(down)), 2);
  const h = setup();
  assert.equal(await main(["projects", "--help"], h.io), 0);
  assert.match(h.out(), /^Usage: t3sm projects \[--json\]/);
  assert.match(h.out(), /projects set "<folder>" <account>/);
  const u = setup();
  assert.equal(await main(["--help"], u.io), 0);
  assert.match(u.out(), /\n  projects /);
});

test("projects set without config.json exits 2 and says how to create it", async () => {
  const s = setup({ noConfig: true });
  assert.equal(await projectsCommand(["set", s.demo, "claude-work", "--yes"], s.io, s.deps(down)), 2);
  assert.match(s.err(), /t3sm plan/);
});
