// An elevated shell (Windows, Administrator): t3sm warns once that the schedule and the plugin are installed for this
// user only. Detected with `net session` (exit 0 only when elevated), by its absolute path, with a time limit; never
// blocks a command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isElevated, resetElevatedWarning, warnIfElevated } from "../../src/ops/elevated.ts";
import type { RunOptions, Runner } from "../../src/t3/auth.ts";

function runner(code: number | null, timedOut = false): { run: Runner; calls: { file: string; args: string[]; opts: RunOptions }[] } {
  const calls: { file: string; args: string[]; opts: RunOptions }[] = [];
  return { calls, run: async (file, args, opts) => { calls.push({ file, args, opts }); return { code, stdout: "", stderr: "", timedOut }; } };
}

test("isElevated: win32 runs <SystemRoot>\\System32\\net.exe session with a time limit and no shell; exit 0 is elevated", async () => {
  const r = runner(0);
  assert.equal(await isElevated("win32", r.run, { SystemRoot: "D:\\Win", CLAUDE_CONFIG_DIR: "C:/x" }), true);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.file, "D:\\Win\\System32\\net.exe");
  assert.deepEqual(r.calls[0]!.args, ["session"]);
  assert.equal(r.calls[0]!.opts.shell, false);
  assert.ok((r.calls[0]!.opts.timeoutMs ?? 0) > 0 && (r.calls[0]!.opts.timeoutMs ?? 0) <= 10_000);
  assert.ok(!Object.keys(r.calls[0]!.opts.env ?? {}).some((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR"), "no CLAUDE_CONFIG_DIR in the child");
  assert.equal(await isElevated("win32", runner(2).run, {}), false, "access denied: not elevated");
  assert.equal(await isElevated("win32", runner(0, true).run, {}), false, "timed out: not elevated");
  assert.equal(await isElevated("win32", async () => { throw new Error("spawn failed"); }, {}), false);
  const def = runner(0);
  await isElevated("win32", def.run, {});
  assert.equal(def.calls[0]!.file, "C:\\Windows\\System32\\net.exe");
  const other = runner(0);
  assert.equal(await isElevated("linux", other.run, {}), false);
  assert.equal(other.calls.length, 0, "never runs anything elsewhere");
});

test("warnIfElevated: one localized line on stderr, once per process; nothing when not elevated", async () => {
  resetElevatedWarning();
  const err: string[] = [];
  const io = { stderr: (s: string) => void err.push(s), lang: "en" as const };
  await warnIfElevated(io, async () => false, "schedule");
  assert.deepEqual(err, []);
  await warnIfElevated(io, async () => true, "schedule");
  await warnIfElevated(io, async () => true, "update");
  assert.equal(err.length, 1);
  assert.match(err[0]!, /Running as Administrator: the scheduled sync is registered for this user only/);
  // Each command names what it installs.
  const said = async (c: "start" | "schedule" | "update", lang: "en" | "pt"): Promise<string> => {
    resetElevatedWarning();
    const e: string[] = [];
    await warnIfElevated({ stderr: (s: string) => void e.push(s), lang }, async () => true, c);
    return e.join("");
  };
  assert.match(await said("start", "en"), /installs the scheduled sync and the \/t3sm commands for this user only/);
  assert.match(await said("update", "en"), /t3sm is reinstalled with this user's npm and its watcher restarts as this user/);
  assert.match(await said("start", "pt"), /A correr como Administrador: a configuração guiada instala/);
  assert.match(await said("schedule", "pt"), /a sincronização agendada fica registada só para este utilizador/);
  assert.match(await said("update", "pt"), /o t3sm é reinstalado com o npm deste utilizador/);
  resetElevatedWarning();
  const silent: string[] = [];
  await warnIfElevated({ stderr: (s: string) => void silent.push(s) }, async () => { throw new Error("x"); }, "start");
  assert.deepEqual(silent, [], "a failing check never warns and never throws");
});
