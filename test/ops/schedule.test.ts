import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  CRON_TAG, TASK_NAME, installSchedule, removeSchedule, scheduleSpec, scheduleStatus, taskXml, type CommandRunner, type SpecOptions,
} from "../../src/ops/schedule.ts";
import { tempRoot } from "./helpers.ts";

const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_BIN = "C:\\Users\\demo user\\t3sm\\bin\\t3sm.mjs";
const CONHOST = "C:\\Windows\\System32\\conhost.exe";
const SCHTASKS = "C:\\Windows\\System32\\schtasks.exe";
const STATE = "C:\\Users\\demo user\\.t3code-session-manager";
const XML_PATH = win32.join(STATE, "schedule", "t3sm-task.xml");
const NIX_NODE = "/usr/local/bin/node";
const NIX_BIN = "/home/demo user/t3sm/bin/t3sm.mjs";
const WIN: SpecOptions = { conhost: CONHOST, systemRoot: "C:\\Windows", stateDir: STATE, userId: "DEMO\\demo" };

const INTERVAL_XML = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>t3code-session-manager: import new agent sessions into T3 Code (t3sm sync).</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT15M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>DEMO\\demo</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\Windows\\System32\\conhost.exe</Command>
      <Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\demo user\\t3sm\\bin\\t3sm.mjs&quot; sync --quiet</Arguments>
    </Exec>
  </Actions>
</Task>
`;

test("scheduleSpec win32: schtasks.exe (absolute) /Create /XML from the state dir; interval task XML snapshot", () => {
  const s = scheduleSpec("win32", WIN_NODE, WIN_BIN, 15, WIN);
  assert.equal(s.kind, "schtasks");
  assert.deepEqual(s.install, [[SCHTASKS, "/Create", "/XML", XML_PATH, "/TN", TASK_NAME, "/F"]]);
  assert.deepEqual(s.remove, [[SCHTASKS, "/Delete", "/F", "/TN", TASK_NAME]]);
  assert.deepEqual(s.query, [SCHTASKS, "/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"]);
  assert.deepEqual(s.files, [{ path: XML_PATH, content: INTERVAL_XML, encoding: "utf16le-bom" }]);
  assert.equal(TASK_NAME, "t3code-session-manager sync");
});

test("taskXml --watch: logon trigger for the current user only, no time limit, started right away", () => {
  const s = scheduleSpec("win32", WIN_NODE, WIN_BIN, 15, { ...WIN, watch: true });
  assert.deepEqual(s.install, [[SCHTASKS, "/Create", "/XML", XML_PATH, "/TN", TASK_NAME, "/F"], [SCHTASKS, "/Run", "/TN", TASK_NAME]]);
  const x = s.files![0]!.content;
  assert.match(x, /<Triggers>\s*<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DEMO\\demo<\/UserId>\s*<\/LogonTrigger>\s*<\/Triggers>/);
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(x, /<Hidden>/, "Hidden would hide the task from the Task Scheduler library, not the window");
  assert.match(x, /<Arguments>--headless &quot;.*&quot; sync --watch --quiet<\/Arguments>/);
  assert.doesNotMatch(x, /TimeTrigger/);
});

test("taskXml escapes every value; without conhost the action is a minimized start", () => {
  const x = taskXml({ nodePath: "C:\\a&b\\node.exe", binPath: "C:\\x<y>\\t3sm.mjs", args: ["sync", "--quiet"], everyMinutes: 30, watch: false, userId: "DOM\\o'brien & co", conhost: null, systemRoot: "C:\\Windows" });
  assert.match(x, /<UserId>DOM\\o&apos;brien &amp; co<\/UserId>/);
  assert.match(x, /<Interval>PT30M<\/Interval>/);
  assert.match(x, /<Command>C:\\Windows\\System32\\cmd\.exe<\/Command>/);
  assert.match(x, /<Arguments>\/c start &quot;&quot; \/min &quot;C:\\a&amp;b\\node\.exe&quot; &quot;C:\\x&lt;y&gt;\\t3sm\.mjs&quot; sync --quiet<\/Arguments>/);
});

test("scheduleSpec refuses node/bin paths with %, CR or LF on every platform", () => {
  for (const p of ["C:\\a%PATH%\\t3sm.mjs", "C:\\a\r\\t3sm.mjs", "C:\\a\n\\t3sm.mjs"]) {
    assert.throws(() => scheduleSpec("win32", WIN_NODE, p, 15, WIN), /cannot contain/);
    assert.throws(() => scheduleSpec("linux", p, NIX_BIN, 15), /cannot contain/);
    assert.throws(() => scheduleSpec("darwin", NIX_NODE, p, 15, { home: "/Users/d", uid: 501 }), /cannot contain/);
  }
});

test("scheduleSpec darwin: LaunchAgent plist with StartInterval and launchctl bootstrap gui/<uid>", () => {
  const s = scheduleSpec("darwin", NIX_NODE, "/Users/demo user/t3sm/bin/t3sm.mjs", 15, { home: "/Users/demo user", uid: 501 });
  assert.equal(s.kind, "launchd");
  const plist = "/Users/demo user/Library/LaunchAgents/dev.t3sm.sync.plist";
  assert.deepEqual(s.install, [["launchctl", "bootstrap", "gui/501", plist]]);
  assert.deepEqual(s.remove, [["launchctl", "bootout", "gui/501/dev.t3sm.sync"]]);
  assert.deepEqual(s.query, ["launchctl", "print", "gui/501/dev.t3sm.sync"]);
  assert.equal(s.files!.length, 1);
  assert.equal(s.files![0]!.path, plist);
  const c = s.files![0]!.content;
  assert.match(c, /<key>Label<\/key>\s*<string>dev\.t3sm\.sync<\/string>/);
  assert.match(c, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/demo user\/t3sm\/bin\/t3sm\.mjs<\/string>\s*<string>sync<\/string>\s*<string>--quiet<\/string>\s*<\/array>/);
  assert.match(c, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.doesNotMatch(c, /RunAtLoad|KeepAlive/);
});

test("scheduleSpec darwin --watch: RunAtLoad + KeepAlive (only after a failed exit) + ThrottleInterval 60", () => {
  const s = scheduleSpec("darwin", NIX_NODE, "/Users/demo/a&b<c>/t3sm.mjs", 15, { home: "/Users/demo", uid: 501, watch: true });
  const c = s.files![0]!.content;
  assert.match(c, /<string>\/Users\/demo\/a&amp;b&lt;c&gt;\/t3sm\.mjs<\/string>\s*<string>sync<\/string>\s*<string>--watch<\/string>\s*<string>--quiet<\/string>/);
  assert.match(c, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(c, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(c, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  assert.doesNotMatch(c, /StartInterval/);
});

test("scheduleSpec linux: tagged crontab line, quoted paths with spaces, @reboot for --watch", () => {
  const s = scheduleSpec("linux", NIX_NODE, NIX_BIN, 15);
  assert.equal(s.kind, "cron");
  assert.equal(s.cronLine, `*/15 * * * * "/usr/local/bin/node" "/home/demo user/t3sm/bin/t3sm.mjs" sync --quiet # t3sm`);
  assert.deepEqual(s.install, [["crontab", "-"]]);
  assert.deepEqual(s.query, ["crontab", "-l"]);
  const w = scheduleSpec("linux", NIX_NODE, NIX_BIN, 15, { watch: true });
  assert.equal(w.cronLine, `@reboot "/usr/local/bin/node" "/home/demo user/t3sm/bin/t3sm.mjs" sync --watch --quiet # t3sm`);
  assert.equal(CRON_TAG, "# t3sm");
});

test("scheduleSpec linux: shell metacharacters in paths are escaped; hourly intervals; bad intervals refused", () => {
  const s = scheduleSpec("linux", NIX_NODE, `/home/d/$x"y\`z/t3sm.mjs`, 15);
  assert.equal(s.cronLine, `*/15 * * * * "/usr/local/bin/node" "/home/d/\\$x\\"y\\\`z/t3sm.mjs" sync --quiet # t3sm`);
  assert.match(scheduleSpec("linux", NIX_NODE, NIX_BIN, 120).cronLine!, /^0 \*\/2 \* \* \* /);
  assert.match(scheduleSpec("linux", NIX_NODE, NIX_BIN, 1440).cronLine!, /^0 0 \* \* \* /);
  assert.throws(() => scheduleSpec("linux", NIX_NODE, NIX_BIN, 90), /everyMinutes/);
  assert.throws(() => scheduleSpec("win32", WIN_NODE, WIN_BIN, 0, WIN), /everyMinutes/);
});

/** A fake command runner holding one schtasks task, one crontab and one launchd job. */
function fakeRunner(o: { bootstrapFailsOnce?: boolean } = {}) {
  const calls: string[][] = [];
  const st = { task: null as string[] | null, crontab: null as string | null, loaded: false, inputs: [] as string[], xml: "" };
  let failOnce = o.bootstrapFailsOnce ?? false;
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === SCHTASKS) {
      if (args[0] === "/Create") {
        st.task = args;
        st.xml = readFileSync(args[2]!).subarray(2).toString("utf16le");
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (args[0] === "/Query" && args.includes("/XML")) return st.task ? { code: 0, stdout: st.xml, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR" };
      if (args[0] === "/Query") {
        return st.task ? { code: 0, stdout: `"\\${TASK_NAME}","11/11/2026 12:15:00","Ready"\r\n`, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
      }
      if (args[0] === "/Delete") {
        if (!st.task) return { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
        st.task = null; return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (args[0] === "/Run") return { code: st.task ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "crontab") {
      if (args[0] === "-l") return st.crontab === null ? { code: 1, stdout: "", stderr: "no crontab for demo" } : { code: 0, stdout: st.crontab, stderr: "" };
      if (args[0] === "-") { st.crontab = opts?.input ?? ""; st.inputs.push(st.crontab); return { code: 0, stdout: "", stderr: "" }; }
    }
    if (cmd === "launchctl") {
      if (args[0] === "bootstrap") {
        if (failOnce) { failOnce = false; return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }; }
        if (st.loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        st.loaded = true; return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") { if (!st.loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" }; st.loaded = false; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "print") return st.loaded ? { code: 0, stdout: "state = not running\n", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    }
    return { code: 127, stdout: "", stderr: "not found" };
  };
  return { run, calls, st };
}

test("install/remove/status win32 via a fake runner: XML written UTF-16LE with BOM, idempotent, status reads the installed command", async () => {
  const t = tempRoot();
  const f = fakeRunner();
  const node = join(t.root, "node.exe");
  const bin = join(t.root, "bin", "t3sm.mjs");
  writeFileSync(node, "");
  const spec = scheduleSpec("win32", node, bin, 15, { ...WIN, stateDir: t.state });
  const xmlPath = spec.files![0]!.path;
  assert.deepEqual(await scheduleStatus(spec, f.run), { installed: false, nextRun: null, detail: null, command: null, missing: [] });
  await installSchedule(spec, f.run);
  const raw = readFileSync(xmlPath);
  assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe], "UTF-16LE BOM");
  assert.equal(raw.subarray(2).toString("utf16le"), spec.files![0]!.content);
  const first = f.st.task;
  await installSchedule(spec, f.run);
  assert.deepEqual(f.st.task, first, "second install leaves the same task");
  const s = await scheduleStatus(spec, f.run);
  assert.equal(s.installed, true);
  assert.equal(s.nextRun, "11/11/2026 12:15:00");
  assert.match(s.command!, /node\.exe" ".*t3sm\.mjs" sync --quiet$/);
  assert.deepEqual(s.missing, [bin], "the installed bin path no longer exists");
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: true });
  assert.ok(!existsSync(xmlPath), "task XML removed");
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: false }, "remove twice is a no-op");
  assert.equal(f.calls.filter((c) => c[1] === "/Delete").length, 1);
});

test("install linux keeps the user's other crontab lines and replaces only the tagged one (idempotent)", async () => {
  const f = fakeRunner();
  f.st.crontab = `MAILTO=""\n0 3 * * * /usr/bin/backup.sh\n*/5 * * * * "/old/node" "/old/t3sm.mjs" sync --quiet # t3sm\n`;
  const spec = scheduleSpec("linux", NIX_NODE, NIX_BIN, 15);
  await installSchedule(spec, f.run);
  const once = f.st.crontab;
  assert.equal(once, `MAILTO=""\n0 3 * * * /usr/bin/backup.sh\n${spec.cronLine}\n`);
  await installSchedule(spec, f.run);
  assert.equal(f.st.crontab, once);
  const s = await scheduleStatus(spec, f.run, { exists: (p) => p === NIX_NODE });
  assert.equal(s.installed, true);
  assert.equal(s.detail, spec.cronLine);
  assert.deepEqual(s.missing, [NIX_BIN]);
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: true });
  assert.equal(f.st.crontab, `MAILTO=""\n0 3 * * * /usr/bin/backup.sh\n`);
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: false });
});

test("install linux with no crontab yet creates one; an unreadable crontab is never overwritten", async () => {
  const f = fakeRunner();
  const spec = scheduleSpec("linux", NIX_NODE, NIX_BIN, 15);
  await installSchedule(spec, f.run);
  assert.equal(f.st.crontab, `${spec.cronLine}\n`);
  const broken: CommandRunner = async (cmd, args) => (cmd === "crontab" && args[0] === "-l" ? { code: 1, stdout: "", stderr: "crontab: permission denied" } : { code: 0, stdout: "", stderr: "" });
  await assert.rejects(installSchedule(spec, broken), /permission denied/);
});

test("install darwin writes the plist and reloads the agent (bootout ignored when not loaded), idempotent", async () => {
  const t = tempRoot();
  const f = fakeRunner();
  const spec = scheduleSpec("darwin", NIX_NODE, NIX_BIN, 15, { home: t.root, uid: 501 });
  await installSchedule(spec, f.run);
  await installSchedule(spec, f.run);
  const plist = spec.files![0]!.path;
  assert.equal(readFileSync(plist, "utf8"), spec.files![0]!.content);
  assert.equal(f.st.loaded, true);
  const s = await scheduleStatus(spec, f.run, { exists: () => true });
  assert.equal(s.installed, true);
  assert.equal(s.command, `${NIX_NODE} ${NIX_BIN} sync --quiet`);
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: true });
  assert.ok(!existsSync(plist));
  assert.equal(f.st.loaded, false);
  assert.deepEqual(await removeSchedule(spec, f.run), { removed: false });
  assert.ok(existsSync(join(t.root, "Library", "LaunchAgents")), "parent kept");
});

test("install darwin retries bootstrap once after a bootout when the first bootstrap fails", async () => {
  const t = tempRoot();
  mkdirSync(join(t.root, "Library", "LaunchAgents"), { recursive: true });
  const f = fakeRunner({ bootstrapFailsOnce: true });
  const spec = scheduleSpec("darwin", NIX_NODE, NIX_BIN, 15, { home: t.root, uid: 501 });
  await installSchedule(spec, f.run);
  assert.equal(f.st.loaded, true);
  assert.deepEqual(f.calls.map((c) => c[1]), ["bootout", "bootstrap", "bootout", "bootstrap"]);
});

test("a failing install command surfaces its stderr", async () => {
  const t = tempRoot();
  const spec = scheduleSpec("win32", WIN_NODE, WIN_BIN, 15, { ...WIN, stateDir: t.state, watch: true });
  const denied: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });
  await assert.rejects(installSchedule(spec, denied), /Access is denied/);
});
