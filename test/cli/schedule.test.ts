import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../../src/cli/main.ts";
import { scheduleCommand, type ScheduleCommandDeps } from "../../src/cli/commands/schedule.ts";
import type { CommandRunner } from "../../src/ops/schedule.ts";
import { tempHome } from "../apply/fake-t3.ts";
import { memScheduleFs } from "../ops/helpers.ts";

type Stop = { how: "request" | "pid" | "none"; pid: number | null; running: boolean };

function setup(stop: Stop, opts: { installed?: boolean; platform?: NodeJS.Platform; command?: string } = {}) {
  const t = tempHome();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: t.state } };
  const events: string[] = [];
  let installed = opts.installed ?? false;
  const platform = opts.platform ?? "win32";
  const run: CommandRunner = async (cmd, args) => {
    events.push(`run:${[cmd.split(/[\/]/).pop(), ...args].join(" ")}`);
    if (args[0] === "/Create") { installed = true; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "/Query" && args[args.length - 1] === "/XML") return { code: 0, stdout: `<Command>cmd.exe</Command><Arguments>${opts.command ?? '/c start "" /min "C:/n/node.exe" "C:/t3sm/bin/t3sm.mjs" sync --watch --quiet'}</Arguments>`, stderr: "" };
    if (args[0] === "/Query") return installed ? { code: 0, stdout: `"/t3code-session-manager sync","N/A","Ready"`, stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    if (args[0] === "/Delete") { installed = false; return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "crontab" && args[0] === "-l") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: ScheduleCommandDeps = {
    runner: run, platform, home: t.home, nodePath: "C:/n/node.exe", binPath: "C:/t3sm/bin/t3sm.mjs", conhost: "C:/Windows/System32/conhost.exe",
    fs: memScheduleFs(),
    stopWatcher: async () => { events.push("stop"); return stop; },
    spawn: ((cmd: string) => { events.push(`spawn:${cmd}`); return { unref() {} }; }) as NonNullable<ScheduleCommandDeps["spawn"]>,
  };
  return { io, deps, events, out: () => out.join(""), err: () => err.join(""), state: t.state, join };
}

const idx = (events: string[], re: RegExp): number => events.findIndex((e) => re.test(e));

test("install --watch stops a running watcher, then recreates and starts the task", async () => {
  const s = setup({ how: "request", pid: 4242, running: false });
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, s.deps), 0);
  const stop = idx(s.events, /^stop$/), create = idx(s.events, /\/Create/), start = idx(s.events, /\/Run/);
  assert.ok(stop >= 0 && stop < create && create < start, s.events.join(" | "));
  assert.match(s.out(), /Stopped the running watcher \(pid 4242\) and started the new one\./);
});

test("install --watch with no watcher running says so", async () => {
  const s = setup({ how: "none", pid: null, running: false });
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, s.deps), 0);
  assert.match(s.out(), /No watcher was running; started it\./);
});

test("install --watch that cannot stop the watcher changes nothing and exits 1", async () => {
  const s = setup({ how: "pid", pid: 4242, running: true });
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, s.deps), 1);
  assert.match(s.err(), /still running \(pid 4242\)/);
  assert.equal(idx(s.events, /\/Create/), -1);
});

test("install --watch on cron starts the watcher with the detached spawn", async () => {
  const s = setup({ how: "none", pid: null, running: false }, { platform: "linux" });
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, { ...s.deps, nodePath: "/usr/bin/node", binPath: "/opt/t3sm/bin/t3sm.mjs" }), 0);
  assert.ok(idx(s.events, /^spawn:\/usr\/bin\/node$/) > idx(s.events, /^run:crontab -$/));
});

test("remove removes the schedule first, then stops the watcher (a keep-alive in between cannot start one that outlives it), and says so", async () => {
  const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
  assert.equal(await scheduleCommand(["remove", "--yes"], s.io, s.deps), 0);
  assert.ok(idx(s.events, /\/Delete/) >= 0 && idx(s.events, /\/Delete/) < idx(s.events, /^stop$/), s.events.join(" | "));
  assert.match(s.out(), /Stopped the running watcher \(pid 4242\)/);
  assert.match(s.out(), /Removed the scheduled sync/);
});

test("remove whose watcher survives says so with the pid and exits 1", async () => {
  const s = setup({ how: "pid", pid: 4242, running: true }, { installed: true });
  assert.equal(await scheduleCommand(["remove", "--yes"], s.io, s.deps), 1);
  assert.match(s.err(), /still running \(pid 4242\)/);
  assert.doesNotMatch(s.out(), /Stopped the running watcher/);
});

test("restart = stop + run the task, no reinstall; win32 also spawns the watcher (/Run may be dropped while the old task instance exits)", async () => {
  const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
  assert.equal(await scheduleCommand(["restart", "--yes"], s.io, s.deps), 0);
  assert.ok(idx(s.events, /^stop$/) < idx(s.events, /\/Run/), s.events.join(" | "));
  assert.ok(idx(s.events, /\/Run/) < idx(s.events, /^spawn:.*conhost\.exe$/), s.events.join(" | "));
  assert.equal(idx(s.events, /\/Create/), -1);
  assert.match(s.out(), /Stopped the running watcher \(pid 4242\) and started the new one\./);
});

test("restart without a schedule exits 2 and points at install --watch", async () => {
  const s = setup({ how: "none", pid: null, running: false }, { installed: false });
  assert.equal(await scheduleCommand(["restart", "--yes"], s.io, s.deps), 2);
  assert.match(s.err(), /run t3sm schedule install --watch/);
  assert.equal(idx(s.events, /^stop$/), -1);
});

test("restart refuses to leave the old watcher running", async () => {
  const s = setup({ how: "pid", pid: 4242, running: true }, { installed: true });
  assert.equal(await scheduleCommand(["restart", "--yes"], s.io, s.deps), 1);
  assert.equal(idx(s.events, /\/Run/), -1);
});

test("--dry-run stops nothing, starts nothing and writes nothing", async () => {
  for (const args of [["install", "--watch", "--dry-run"], ["remove", "--dry-run"], ["restart", "--dry-run"]]) {
    const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
    assert.equal(await scheduleCommand(args, s.io, s.deps), 0, args.join(" "));
    assert.equal(idx(s.events, /^stop$|\/Create|\/Run|\/Delete|^spawn:/), -1, `${args.join(" ")}: ${s.events.join(" | ")}`);
    assert.match(s.out(), /Would /);
  }
});

test("--dry-run is not accepted by status", async () => {
  const s = setup({ how: "none", pid: null, running: false });
  assert.equal(await scheduleCommand(["status", "--dry-run"], s.io, s.deps), 2);
});

test("gate: no --yes on a non-TTY exits 2 and does nothing; --yes with --dry-run is refused; status needs no --yes", async () => {
  for (const args of [["install", "--watch"], ["remove"], ["restart"]]) {
    const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
    assert.equal(await scheduleCommand(args, s.io, s.deps), 2, args.join(" "));
    assert.match(s.err(), /pass --yes/);
    assert.deepEqual(s.events, []);
  }
  const d = setup({ how: "none", pid: null, running: false });
  assert.equal(await scheduleCommand(["remove", "--yes", "--dry-run"], d.io, d.deps), 2);
  assert.equal(await scheduleCommand(["status"], d.io, d.deps), 0);
});

test("gate: on a TTY it asks; no answer cancels, yes proceeds", async () => {
  const no = setup({ how: "none", pid: null, running: false }, { installed: true });
  no.io.isTTY = true;
  no.io.prompt = async () => "n";
  assert.equal(await scheduleCommand(["remove"], no.io, no.deps), 0);
  assert.equal(no.events.length, 0);
  const yes = setup({ how: "none", pid: null, running: false }, { installed: true });
  yes.io.isTTY = true;
  yes.io.prompt = async () => "yes";
  assert.equal(await scheduleCommand(["remove"], yes.io, yes.deps), 0);
  assert.ok(idx(yes.events, /^stop$/) >= 0);
});

test("non-watch install over a running watcher reports it and stops nothing", async () => {
  const s = setup({ how: "request", pid: 4242, running: false });
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "sync-status.json"), JSON.stringify({ pid: 777, startedAt: "2026-11-11T10:00:00.000Z" }));
  assert.equal(await scheduleCommand(["install", "--yes"], s.io, { ...s.deps, isAlive: () => true }), 0);
  assert.match(s.out(), /A watcher is still running \(pid 777\); t3sm schedule restart or remove stops\s+it\./);
  assert.equal(idx(s.events, /^stop$/), -1);
});

test("restart --dry-run predicts exit 2 when nothing is installed", async () => {
  const s = setup({ how: "none", pid: null, running: false }, { installed: false });
  assert.equal(await scheduleCommand(["restart", "--dry-run"], s.io, s.deps), 2);
  assert.match(s.err(), /run t3sm schedule install --watch/);
});

test("an elevated shell (Administrator) gets one warning on install, never a refusal; tests never run net.exe by default", async () => {
  const { resetElevatedWarning } = await import("../../src/ops/elevated.ts");
  resetElevatedWarning();
  const s = setup({ how: "none", pid: null, running: false });
  assert.equal(await scheduleCommand(["install", "--yes"], s.io, { ...s.deps, elevated: async () => true }), 0);
  assert.match(s.err(), /Running as Administrator: the scheduled sync is registered for this user only/);
  assert.equal(s.err().split("Administrator").length, 2, "once");
  resetElevatedWarning();
  const quiet = setup({ how: "none", pid: null, running: false });
  assert.equal(await scheduleCommand(["status"], quiet.io, quiet.deps), 0);
  assert.doesNotMatch(quiet.err(), /Administrator/);
  assert.ok(!quiet.events.some((e) => /net/.test(e)), "no net session through the scheduler runner");
});

test("install --watch on win32 spawns the watcher after /Create and /Run (a dropped /Run never leaves no watcher)", async () => {
  const s = setup({ how: "request", pid: 4242, running: false });
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, s.deps), 0);
  assert.ok(idx(s.events, /\/Run/) >= 0 && idx(s.events, /\/Run/) < idx(s.events, /^spawn:/), s.events.join(" | "));
});

test("install --watch, remove and restart stop the watcher under the state lock: while a run holds it nothing is stopped or changed", async () => {
  for (const args of [["install", "--watch", "--yes"], ["remove", "--yes"], ["restart", "--yes"]]) {
    const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
    let busy = 0;
    s.io.onLockBusy = () => { busy++; };
    assert.equal(await scheduleCommand(args, s.io, { ...s.deps, lock: async () => null }), 0, args.join(" "));
    assert.equal(idx(s.events, /^stop$|\/Create|\/Run|\/Delete|^spawn:/), -1, `${args.join(" ")}: ${s.events.join(" | ")}`);
    assert.match(s.out(), /Another t3sm run is in progress\./);
    assert.equal(busy, 1);
  }
  // Held: the lock is taken before the stop and released after.
  const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
  const deps = { ...s.deps, lock: async () => { s.events.push("lock"); return { release: async () => void s.events.push("unlock") }; } };
  assert.equal(await scheduleCommand(["restart", "--yes"], s.io, deps), 0);
  assert.ok(idx(s.events, /^lock$/) < idx(s.events, /^stop$/) && idx(s.events, /^spawn:/) < idx(s.events, /^unlock$/), s.events.join(" | "));
});

test("install --watch and restart stop with a restart intent (the stopped heartbeat says a successor is due); remove does not", async () => {
  const intents: string[] = [];
  for (const args of [["install", "--watch", "--yes"], ["restart", "--yes"], ["remove", "--yes"]]) {
    const s = setup({ how: "request", pid: 4242, running: false }, { installed: true });
    await scheduleCommand(args, s.io, { ...s.deps, stopWatcher: async (o) => { intents.push(`${args[0]}:${o?.restart === true}`); return { how: "request", pid: 4242, running: false }; } });
  }
  assert.deepEqual(intents, ["install:true", "restart:true", "remove:false"]);
});

test("a crashed watcher's heartbeat (pid gone, no clean stop) is marked stopped by an interval install and by restart without a watch schedule", async () => {
  const crashed = JSON.stringify({ pid: 777, startedAt: "2026-11-11T10:00:00.000Z", lastCycleAt: "2026-11-11T10:05:00.000Z", lastResult: null, nextCycleAt: null, failures: 0 });
  const { readFileSync } = await import("node:fs");
  for (const [args, installed, code] of [[["install", "--yes"], false, 0], [["restart", "--yes"], false, 2]] as const) {
    const s = setup({ how: "none", pid: null, running: false }, { installed });
    mkdirSync(s.state, { recursive: true });
    writeFileSync(join(s.state, "sync-status.json"), crashed);
    assert.equal(await scheduleCommand([...args], s.io, { ...s.deps, isAlive: () => false }), code, args.join(" "));
    const hb = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8"));
    assert.equal(typeof hb.stoppedAt, "string", args.join(" "));
    assert.equal(hb.failures, 0, "what the cycles recorded stays");
  }
  // A live one is left alone.
  const live = setup({ how: "none", pid: null, running: false });
  mkdirSync(live.state, { recursive: true });
  writeFileSync(join(live.state, "sync-status.json"), crashed);
  await scheduleCommand(["install", "--yes"], live.io, { ...live.deps, isAlive: () => true });
  assert.equal(JSON.parse(readFileSync(join(live.state, "sync-status.json"), "utf8")).stoppedAt, undefined);
});

test("schedule status words the last sync.log line (time, outcome, imported, run) and hides the scheduler's normal state", async () => {
  const { loggedLine, renderScheduleStatus } = await import("../../src/cli/commands/schedule.ts");
  const { makeCliUi } = await import("../../src/i18n/cli.ts");
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);
  const ui = (lang: "en" | "pt") => makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 120 }, lang, () => now);
  const line = "2026-11-15T11:56:00.000Z ok run=R7 imported=2 failed=0 deferred=0 parked=0 held-in-use=0 held-dedupe=0 held-accounts=0 held-failed=0";
  assert.match(loggedLine(ui("en"), line), /^Nov 15, \d\d:\d\d \(4 min ago\): done, 2 imported, run R7$/);
  assert.match(loggedLine(ui("pt"), line), /^15\/11 às \d\d:\d\d \(há 4 min\): feito, 2 importadas, execução R7$/);
  assert.match(loggedLine(ui("en"), "2026-11-15T11:56:00.000Z t3-down"), /: T3 Code was closed$/);
  assert.equal(loggedLine(ui("en"), "garbage line"), "garbage line");
  const out = renderScheduleStatus(ui("en"), { kind: "schtasks", installed: true, nextRun: "N/A", detail: "Running", command: "x", missing: [], watch: true, watcher: null, lastLogged: line }).join("\n");
  assert.match(out, /installed \(schtasks\)\n/);
  assert.doesNotMatch(out, /N\/A|Running|2026-11-15T|imported=/);
  const odd = renderScheduleStatus(ui("en"), { kind: "schtasks", installed: true, nextRun: null, detail: "Disabled", command: "x", missing: [], watch: true, watcher: null, lastLogged: null }).join("\n");
  assert.match(odd, /the scheduler says Disabled/);
});

test("schedule status words the watcher's restart, update and start-up lines too, never the raw log word", async () => {
  const { loggedLine } = await import("../../src/cli/commands/schedule.ts");
  const { makeCliUi } = await import("../../src/i18n/cli.ts");
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);
  const ui = (lang: "en" | "pt") => makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 120 }, lang, () => now);
  const at = "2026-11-15T11:56:00.000Z";
  const cases: [string, RegExp, RegExp][] = [
    [`${at} restart from=0.3.0 to=0.3.1`, /: the watcher restarted into t3sm 0\.3\.1$/, /: o vigilante voltou a arrancar no t3sm 0\.3\.1$/],
    [`${at} update installed from=0.3.0 to=0.3.1`, /: update to 0\.3\.1 installed$/, /: atualização para o t3sm 0\.3\.1 instalada$/],
    [`${at} update rolled-back from=0.3.0 to=0.3.1`, /: update to 0\.3\.1 rolled back \(t3sm went back to 0\.3\.0\)$/, /: atualização para o t3sm 0\.3\.1 desfeita \(voltou o 0\.3\.0\)$/],
    [`${at} update failed from=0.3.0 to=0.3.1`, /: update to 0\.3\.1 failed$/, /: a atualização para o t3sm 0\.3\.1 falhou$/],
    [`${at} update busy to=0.3.1`, /: update to 0\.3\.1 waited: another t3sm run was busy$/, /: a atualização para o t3sm 0\.3\.1 esperou/],
    [`${at} update-check unavailable`, /: update check: the releases could not be looked up$/, /: verificação de atualizações: /],
    [`${at} update-check available to=1.0.0`, /: update check: t3sm 1\.0\.0 is available$/, /o t3sm 1\.0\.0 está disponível$/],
    [`${at} update-check start to=0.3.1`, /: update check: installing t3sm 0\.3\.1$/, /a instalar o t3sm 0\.3\.1$/],
    [`${at} version-unknown Error`, /: the watcher could not read its install$/, /: o vigilante não conseguiu ler a sua instalação$/],
    [`${at} startup-error exit=1 ConfigError`, /: the watcher stopped at start-up \(ConfigError\)$/, /: o vigilante parou no arranque \(ConfigError\)$/],
    [`${at} socket-dir-unsafe /tmp/t3sm-1000-x`, /: the watcher could not start: its socket folder is not safe$/, /a pasta do seu socket não é segura$/],
  ];
  for (const [line, en, pt] of cases) {
    const e = loggedLine(ui("en"), line);
    const p = loggedLine(ui("pt"), line);
    assert.match(e, en, line);
    assert.match(p, pt, line);
    for (const out of [e, p]) assert.doesNotMatch(out, /restart from|update-check|startup-error|socket-dir|version-unknown|from=|to=|rolled-back|\/tmp/, out);
  }
});
