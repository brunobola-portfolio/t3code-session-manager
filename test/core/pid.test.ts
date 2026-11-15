import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive, processInfo } from "../../src/core/pid.ts";
import { sweepWriteTemps } from "../../src/core/fsutil.ts";

const answersAlive = (): void => {}; // a probe that would say "alive" for anything

test("pidAlive: a pid outside the valid range (<= 0, > 2^31 - 1, NaN, not an integer) is not alive, whatever the probe says", () => {
  for (const pid of [0, -1, -4242, 2 ** 31, 99_999_999_999, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.equal(pidAlive(pid, answersAlive), false, String(pid));
  }
  assert.equal(pidAlive(2 ** 31 - 1, answersAlive), true, "the top valid pid is probed");
  assert.equal(pidAlive(4242, answersAlive), true);
  assert.equal(pidAlive(4242, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }), false);
  assert.equal(pidAlive(4242, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }), true, "doubtful answer: alive (unchanged)");
});

test("sweepWriteTemps: temps carrying an out-of-range pid (0, > 2^31 - 1) are swept with the real probe; this process's are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-pid-"));
  try {
    const uuid = "00000000-0000-4000-8000-000000000001";
    const zero = `.${uuid}.0.aaaaaaaaaaaa.tmp`;
    const huge = `.${uuid}.99999999999.bbbbbbbbbbbb.tmp`;
    const mine = `.${uuid}.${process.pid}.cccccccccccc.tmp`;
    for (const n of [zero, huge, mine]) writeFileSync(join(dir, n), "x");
    const swept = await sweepWriteTemps(dir);
    assert.deepEqual(swept.map((p) => p.slice(dir.length + 1)).sort(), [huge, zero].sort());
    assert.deepEqual(readdirSync(dir), [mine]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

type Call = { cmd: string; args: string[]; cwd?: string };
function runner(stdout: string | ((c: Call) => string), code = 0) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    const c = { cmd, args, cwd: opts?.cwd };
    calls.push(c);
    return { code, stdout: typeof stdout === "string" ? stdout : stdout(c), stderr: "" };
  };
  return { run, calls };
}

test("processInfo win32: one absolute powershell call (SystemRoot from the injected env), explicit cwd, JSON with command line and start time", async () => {
  const json = JSON.stringify({ CommandLine: "node t3sm.mjs sync --watch", S: "2026-11-15T10:00:00.0000000Z" });
  const r = runner(`${json}\r\n`);
  const info = await processInfo(4242, "win32", r.run, { env: { SystemRoot: "D:\\Win" }, cwd: "D:\\tmp" });
  assert.deepEqual(info, { argv: null, commandLine: "node t3sm.mjs sync --watch", startedAt: Date.UTC(2026, 10, 15, 10, 0, 0) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.cmd, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(r.calls[0]!.cwd, "D:\\tmp");
  assert.deepEqual(r.calls[0]!.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(r.calls[0]!.args[3]!, /Win32_Process -Filter 'ProcessId=4242'/);
  assert.match(r.calls[0]!.args[3]!, /CommandLine/);
  assert.match(r.calls[0]!.args[3]!, /CreationDate/);
  assert.equal((await processInfo(4242, "win32", runner(json).run, { env: { windir: "E:\\W" } }) && 1), 1);
  const dflt = runner(json);
  await processInfo(4242, "win32", dflt.run, { env: {} });
  assert.equal(dflt.calls[0]!.cmd, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const viaWindir = runner(json);
  await processInfo(4242, "win32", viaWindir.run, { env: { windir: "E:\\W" } });
  assert.equal(viaWindir.calls[0]!.cmd, "E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("processInfo win32: gone / failed / empty / garbage / no start time is null", async () => {
  for (const out of ["", "\r\n", "not json", "{}", JSON.stringify({ CommandLine: "x" }), JSON.stringify({ CommandLine: "x", S: "nope" })]) {
    assert.equal(await processInfo(4242, "win32", runner(out).run, { env: {} }), null, out);
  }
  assert.equal(await processInfo(4242, "win32", runner("{}", 1).run, { env: {} }), null);
  assert.equal(await processInfo(4242, "win32", async () => { throw new Error("spawn"); }, { env: {} }), null);
});

test("processInfo darwin: absolute /bin/ps for lstart and command, explicit cwd", async () => {
  const r = runner((c) => (c.args.includes("lstart=") ? "Sun Nov 15 10:00:00 2026\n" : "node /x/t3sm.mjs sync --watch\n"));
  const info = await processInfo(4242, "darwin", r.run, { cwd: "/tmp" });
  assert.equal(info?.commandLine, "node /x/t3sm.mjs sync --watch");
  assert.equal(info?.startedAt, new Date("Sun Nov 15 10:00:00 2026").getTime());
  assert.deepEqual(r.calls.map((c) => [c.cmd, ...c.args]), [["/bin/ps", "-o", "lstart=", "-p", "4242"], ["/bin/ps", "-o", "command=", "-p", "4242"]]);
  assert.ok(r.calls.every((c) => c.cwd === "/tmp"));
  assert.equal(await processInfo(4242, "darwin", runner("", 1).run), null);
  assert.equal(await processInfo(4242, "darwin", runner("garbage\n").run), null, "unparsable start time");
});

test("processInfo linux: argv from the NUL-delimited cmdline, start time from stat field 22 and btime; no command is run", async () => {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = "S";
  fields[19] = "360000"; // field 22: 3600 s after boot
  const stat = `4242 (no de) ) ${fields.join(" ")}`;
  const files: Record<string, string> = {
    "/proc/4242/cmdline": "/usr/bin/node\0/opt/my tools/t3sm.mjs\0sync\0--watch\0",
    "/proc/4242/stat": stat,
    "/proc/stat": "cpu  1 2 3\nbtime 1800000000\nprocesses 5\n",
  };
  const r = runner("unused");
  const info = await processInfo(4242, "linux", r.run, { readProc: async (p) => { const v = files[p]; if (v === undefined) throw new Error("ENOENT"); return v; } });
  assert.deepEqual(info, { argv: ["/usr/bin/node", "/opt/my tools/t3sm.mjs", "sync", "--watch"], commandLine: "/usr/bin/node /opt/my tools/t3sm.mjs sync --watch", startedAt: (1_800_000_000 + 3600) * 1000 });
  assert.equal(r.calls.length, 0);
  assert.equal(await processInfo(4242, "linux", r.run, { readProc: async () => { throw new Error("ENOENT"); } }), null);
  assert.equal(await processInfo(4242, "linux", r.run, { readProc: async (p) => (p.endsWith("cmdline") ? "" : files[p]!) }), null, "empty cmdline");
});

test("processInfo: invalid pids never reach a command; a hung reader times out to null", async () => {
  const r = runner("{}");
  for (const bad of [0, -1, 1.5, 2 ** 31, Number.NaN]) assert.equal(await processInfo(bad, "win32", r.run, { env: {} }), null);
  assert.equal(r.calls.length, 0);
  assert.equal(await processInfo(4242, "win32", () => new Promise(() => {}), { env: {}, timeoutMs: 20 }), null);
});

test("processInfo: every reader command gets the time limit (15 s by default), so the runner kills a reader that hangs", async () => {
  const { PROCESS_INFO_TIMEOUT_MS } = await import("../../src/core/pid.ts");
  assert.equal(PROCESS_INFO_TIMEOUT_MS, 15_000);
  const limits: (number | undefined)[] = [];
  const run = async (_c: string, _a: string[], o?: { timeoutMs?: number }) => { limits.push(o?.timeoutMs); return { code: 1, stdout: "", stderr: "" }; };
  await processInfo(4242, "win32", run, { env: {} });
  await processInfo(4242, "darwin", run, { timeoutMs: 700 });
  assert.deepEqual(limits, [15_000, 700]);
});
