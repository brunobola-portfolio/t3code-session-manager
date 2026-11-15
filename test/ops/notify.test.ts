import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOTIFY_INTERVAL_MS, NOTIFY_RETRY_MS, NOTIFY_TIMEOUT_MS, attentionBody, notifyAfterCycle, shouldNotify, summaryBody, systemNotifier, type Notifier,
} from "../../src/ops/notify.ts";
import { markNotified, readLastNotified, recordSyncStatus, writeHeartbeatMerged, type NeedsAttention } from "../../src/ops/syncStatus.ts";
import type { RunOptions, RunResult, Runner } from "../../src/t3/auth.ts";
import { tempRoot } from "./helpers.ts";
import { attentionOf, zeroCounts } from "../../src/ops/sync.ts";

interface Call { file: string; args: string[]; opts: RunOptions }
function fakeRunner(code: number | null = 0, timedOut = false): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (file, args, opts) => { calls.push({ file, args, opts }); return { code, stdout: "", stderr: "", timedOut } satisfies RunResult; };
  return { run, calls };
}
const NOW = Date.parse("2026-11-14T12:00:00Z");
// What a cycle really records (sync.ts attentionOf): "3 sessions in 2 categories wait for your decision" and its facts.
const attention = (over: Partial<NeedsAttention> = {}): NeedsAttention => ({
  ...attentionOf({ kind: "noop", runId: null, counts: zeroCounts() }, { undecided: { automated: 2, home: 1 }, signedOut: 0 })!,
  since: "2026-11-13T00:00:00.000Z", ...over,
});

test("shouldNotify: one per reason per 24 h; another reason is independent", () => {
  const last = { undecided: new Date(NOW - 3_600_000).toISOString() };
  assert.equal(shouldNotify({ mode: "attention", reason: "undecided", lastNotified: {}, now: NOW }), true);
  assert.equal(shouldNotify({ mode: "attention", reason: "undecided", lastNotified: last, now: NOW }), false);
  assert.equal(shouldNotify({ mode: "attention", reason: "signed-out", lastNotified: last, now: NOW }), true);
  const old = { undecided: new Date(NOW - NOTIFY_INTERVAL_MS).toISOString() };
  assert.equal(shouldNotify({ mode: "attention", reason: "undecided", lastNotified: old, now: NOW }), true, "24 h later it is due again");
  assert.equal(shouldNotify({ mode: "attention", reason: "undecided", lastNotified: { undecided: "garbage" }, now: NOW }), true);
});

test("shouldNotify: mode off never; attention never sends the summary; all does; --dry-run never", () => {
  assert.equal(shouldNotify({ mode: "off", reason: "undecided", lastNotified: {}, now: NOW }), false);
  assert.equal(shouldNotify({ mode: "attention", reason: "imported", lastNotified: {}, now: NOW }), false);
  assert.equal(shouldNotify({ mode: "all", reason: "imported", lastNotified: {}, now: NOW }), true);
  assert.equal(shouldNotify({ mode: "all", reason: "undecided", lastNotified: {}, now: NOW, dryRun: true }), false);
});

test("systemNotifier win32: powershell with fixed arguments; title and body travel base64 in the environment, never in the script", async () => {
  const { run, calls } = fakeRunner();
  const title = "t3sm needs attention", body = `It's "quoted" $(Remove-Item x) \`n 'é ü' 日本`;
  const ok = await systemNotifier("win32", run, { env: { PATH: "x", CLAUDE_CONFIG_DIR: "C:/acct" } }).notify(title, body);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "by its absolute path: never a powershell.exe in the current folder");
  assert.deepEqual(c.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.equal(c.args.length, 6);
  assert.match(c.args[5]!, /ToastText02/);
  assert.match(c.args[5]!, /\{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7\}\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.ok(!c.args[5]!.includes("quoted") && !c.args[5]!.includes("Remove-Item") && !c.args[5]!.includes(title), "no text in the script");
  assert.equal(Buffer.from(c.opts.env["T3SM_NOTIFY_TITLE"]!, "base64").toString("utf8"), title);
  assert.equal(Buffer.from(c.opts.env["T3SM_NOTIFY_BODY"]!, "base64").toString("utf8"), body);
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.timeoutMs, NOTIFY_TIMEOUT_MS);
  assert.equal(NOTIFY_TIMEOUT_MS, 10_000);
  assert.ok(!("CLAUDE_CONFIG_DIR" in c.opts.env));
});

test("systemNotifier darwin: osascript with the text as arguments, not spliced into the script", async () => {
  const { run, calls } = fakeRunner();
  assert.equal(await systemNotifier("darwin", run, { env: {} }).notify("T", `a "b" \\ c`), true);
  assert.deepEqual(calls[0]!.args, ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "T", `a "b" \\ c`]);
  assert.equal(calls[0]!.file, "osascript");
  assert.equal(calls[0]!.opts.shell, false);
});

test("systemNotifier linux: notify-send only when on PATH (else a no-op returning false, nothing spawned)", async () => {
  const yes = fakeRunner();
  assert.equal(await systemNotifier("linux", yes.run, { which: (n) => n === "notify-send", env: {} }).notify("T", "B"), true);
  assert.deepEqual(yes.calls.map((c) => [c.file, c.args]), [["notify-send", ["--", "T", "B"]]]);
  const no = fakeRunner();
  assert.equal(await systemNotifier("linux", no.run, { which: () => false, env: {} }).notify("T", "B"), false);
  assert.equal(no.calls.length, 0);
  const other = fakeRunner();
  assert.equal(await systemNotifier("freebsd", other.run, { env: {} }).notify("T", "B"), false);
  assert.equal(other.calls.length, 0);
});

test("systemNotifier: failures, timeouts and a throwing runner return false and never throw; control characters are stripped", async () => {
  assert.equal(await systemNotifier("darwin", fakeRunner(1).run, { env: {} }).notify("T", "B"), false);
  assert.equal(await systemNotifier("darwin", fakeRunner(null, true).run, { env: {} }).notify("T", "B"), false);
  const boom: Runner = async () => { throw new Error("spawn exploded"); };
  assert.equal(await systemNotifier("win32", boom, { env: {} }).notify("T", "B"), false);
  const { run, calls } = fakeRunner();
  await systemNotifier("darwin", run, { env: {} }).notify("T\u001b[31m", "B\u0007\r\nC");
  const [title, body] = calls[0]!.args.slice(-2);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(`${title}${body}`), `${JSON.stringify([title, body])}`);
});

test("texts: attention body is detail plus the how-to; the summary is counts and sanitized project names only", () => {
  assert.equal(attentionBody("3 sessions in 2 categories wait for your decision"), "3 sessions in 2 categories wait for your decision. Open T3 Code and type /t3sm:status, or run t3sm start.");
  assert.equal(attentionBody("Already ends.\u001b"), "Already ends. Open T3 Code and type /t3sm:status, or run t3sm start.");
  assert.equal(summaryBody({ imported: 3, projects: 2, newProjects: ["demo"] }), "3 new conversations in 2 projects. New project: demo.");
  assert.equal(summaryBody({ imported: 1, projects: 1, newProjects: [] }), "1 new conversation in 1 project.");
  const long = summaryBody({ imported: 2, projects: 1, newProjects: ["x".repeat(100) + "\u001b[0m"] });
  assert.ok(!long.includes("\u001b") && long.length < 100, long);
  assert.match(summaryBody({ imported: 9, projects: 5, newProjects: ["a", "b", "c", "d"] }), /New projects: a, b, c and 1 more\./);
});

function recordingNotifier(result = true): { n: Notifier; sent: { title: string; body: string }[] } {
  const sent: { title: string; body: string }[] = [];
  return { sent, n: { notify: async (title, body) => { sent.push({ title, body }); return result; } } };
}

test("notifyAfterCycle: one per reason per 24 h, persisted in sync-status.json; a second cycle within the day stays silent", async () => {
  const dir = tempRoot().state;
  const r = recordingNotifier();
  const first = await notifyAfterCycle({ stateDir: dir, mode: "attention", notifier: r.n, now: NOW, attention: attention() });
  assert.deepEqual(first, ["undecided"]);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.title, "t3sm needs attention");
  assert.match(r.sent[0]!.body, /^3 sessions in 2 categories wait for your decision\. Open T3 Code and type \/t3sm:status, or run t3sm start\.$/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "sync-status.json"), "utf8")).lastNotified, { undecided: new Date(NOW).toISOString() });
  await notifyAfterCycle({ stateDir: dir, mode: "attention", notifier: r.n, now: NOW + 3_600_000, attention: attention() });
  assert.equal(r.sent.length, 1, "within 24 h: silent");
  await notifyAfterCycle({ stateDir: dir, mode: "attention", notifier: r.n, now: NOW + 3_600_000, attention: attention({ reason: "signed-out", detail: "1 account is signed out in T3 Code; its sessions wait" }) });
  assert.equal(r.sent.length, 2, "another reason is its own");
  await notifyAfterCycle({ stateDir: dir, mode: "attention", notifier: r.n, now: NOW + NOTIFY_INTERVAL_MS + 1, attention: attention() });
  assert.equal(r.sent.length, 3, "a day later: again");
});

test("systemNotifier linux: &, < and > are escaped for notify-send markup (Linux only)", async () => {
  const { run, calls } = fakeRunner();
  await systemNotifier("linux", run, { which: () => true, env: {} }).notify("A & B <i>", "x > y & <b>z</b>");
  assert.deepEqual(calls[0]!.args, ["--", "A &amp; B &lt;i&gt;", "x &gt; y &amp; &lt;b&gt;z&lt;/b&gt;"]);
  const mac = fakeRunner();
  await systemNotifier("darwin", mac.run, { env: {} }).notify("A & B", "x > y");
  assert.deepEqual(mac.calls[0]!.args.slice(-2), ["A & B", "x > y"], "other platforms are untouched");
});

test("notifyAfterCycle: a failed send is retried after 1 h (not every cycle, not after 24 h); a successful send waits 24 h", async () => {
  assert.equal(NOTIFY_RETRY_MS, 3_600_000);
  const fail = tempRoot().state;
  const f = recordingNotifier(false);
  const input = { stateDir: fail, mode: "attention" as const, notifier: f.n, attention: attention() };
  await notifyAfterCycle({ ...input, now: NOW });
  assert.equal(f.sent.length, 1);
  assert.equal((await readLastNotified(fail))["undecided"], new Date(NOW - (NOTIFY_INTERVAL_MS - NOTIFY_RETRY_MS)).toISOString(), "stamped, but only 1 h worth");
  await notifyAfterCycle({ ...input, now: NOW + 60_000 });
  await notifyAfterCycle({ ...input, now: NOW + NOTIFY_RETRY_MS - 1 });
  assert.equal(f.sent.length, 1, "within the hour: no retry");
  await notifyAfterCycle({ ...input, now: NOW + NOTIFY_RETRY_MS });
  assert.equal(f.sent.length, 2, "1 h later: retried");
  const ok = tempRoot().state;
  const g = recordingNotifier(true);
  await notifyAfterCycle({ stateDir: ok, mode: "attention", notifier: g.n, now: NOW, attention: attention() });
  assert.equal((await readLastNotified(ok))["undecided"], new Date(NOW).toISOString());
  await notifyAfterCycle({ stateDir: ok, mode: "attention", notifier: g.n, now: NOW + NOTIFY_RETRY_MS, attention: attention() });
  assert.equal(g.sent.length, 1, "success: silent for 24 h");
});

test("notifyAfterCycle: mode off and --dry-run send nothing and write nothing; attention mode ignores the import summary; all adds it", async () => {
  const dir = tempRoot().state;
  const r = recordingNotifier();
  const summary = { imported: 3, projects: 2, newProjects: ["demo"] };
  await notifyAfterCycle({ stateDir: dir, mode: "off", notifier: r.n, now: NOW, attention: attention(), summary });
  await notifyAfterCycle({ stateDir: dir, mode: "all", notifier: r.n, now: NOW, attention: attention(), summary, dryRun: true });
  assert.equal(r.sent.length, 0);
  assert.deepEqual(await readLastNotified(dir), {});
  await notifyAfterCycle({ stateDir: dir, mode: "attention", notifier: r.n, now: NOW, attention: null, summary });
  assert.equal(r.sent.length, 0);
  await notifyAfterCycle({ stateDir: dir, mode: "all", notifier: r.n, now: NOW, attention: null, summary });
  assert.deepEqual(r.sent, [{ title: "t3sm", body: "3 new conversations in 2 projects. New project: demo." }]);
  await notifyAfterCycle({ stateDir: dir, mode: "all", notifier: r.n, now: NOW + 1000, attention: null, summary });
  assert.equal(r.sent.length, 1, "the summary is rate limited too");
});

test("notifyAfterCycle never throws (failing notifier, unwritable state) and the body holds no session text", async () => {
  const bad: Notifier = { notify: async () => { throw new Error("x"); } };
  await assert.doesNotReject(notifyAfterCycle({ stateDir: tempRoot().state, mode: "attention", notifier: bad, now: NOW, attention: attention() }));
  await assert.doesNotReject(notifyAfterCycle({ stateDir: join(tempRoot().state, "sync-status.json", "nope"), mode: "attention", notifier: recordingNotifier().n, now: NOW, attention: attention() }));
  const r = recordingNotifier();
  await notifyAfterCycle({ stateDir: tempRoot().state, mode: "all", notifier: r.n, now: NOW, attention: null, summary: { imported: 1, projects: 1, newProjects: ["demo"] } });
  assert.ok(r.sent.every((s) => !/SECRET|transcript|\.jsonl|C:\\|C:\//.test(`${s.title} ${s.body}`)));
});

test("lastNotified survives the cycle writer and the watcher heartbeat", async () => {
  const dir = tempRoot().state;
  await markNotified(dir, "undecided", new Date(NOW));
  await recordSyncStatus(dir, { cycle: "ok", attention: null, undecided: {}, heldRehome: 0 }, new Date(NOW));
  await writeHeartbeatMerged(dir, { pid: 1, startedAt: "x", lastCycleAt: null, lastResult: null, nextCycleAt: null });
  assert.deepEqual(await readLastNotified(dir), { undecided: new Date(NOW).toISOString() });
  await markNotified(dir, "over-limit", new Date(NOW + 1));
  assert.deepEqual(Object.keys(await readLastNotified(dir)).sort(), ["over-limit", "undecided"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "sync-status.json"), "utf8")).pid, 1, "heartbeat fields stay");
});

test("notifyOnce: an update announcement or failure is sent once per key, ever; off sends nothing; cycles never repeat update-failed", async () => {
  const { notifyOnce } = await import("../../src/ops/notify.ts");
  const dir = tempRoot().state;
  const r = recordingNotifier();
  const send = (now: number, mode: "attention" | "all" | "off" = "attention") =>
    notifyOnce({ stateDir: dir, mode, notifier: r.n, now, key: "update-available:1.0.0", title: "t3sm 1.0.0 is available", body: "A major release." });
  assert.equal(await send(NOW, "off"), false);
  assert.equal(r.sent.length, 0);
  assert.equal(await send(NOW), true);
  assert.equal(await send(NOW + 3 * NOTIFY_INTERVAL_MS), false, "never again for the same key");
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.title, "t3sm 1.0.0 is available");
  // The update itself announced its failure: the cycles' attention notification leaves update-failed alone.
  const sent = await notifyAfterCycle({ stateDir: dir, mode: "all", notifier: r.n, now: NOW, attention: attention({ reason: "update-failed", detail: "t3sm 0.3.1 did not start, so 0.3.0 was put back", command: "t3sm update --check" }) });
  assert.deepEqual(sent, []);
  assert.equal(r.sent.length, 1);
});

test("notification texts in PT: the attention title and body, the import summary and the update notices, from the catalogues", async () => {
  const { attentionTitle, summaryTitle, updateNotice } = await import("../../src/ops/notify.ts");
  assert.equal(attentionTitle("en"), "t3sm needs attention");
  assert.equal(attentionTitle("pt"), "O t3sm precisa de ti");
  assert.equal(summaryTitle("pt"), "t3sm");
  // Worded from the structured facts each producer records next to its English detail (never parsed back from it).
  const { attentionOf, incompatibleAttention } = await import("../../src/ops/sync.ts");
  const { streakAttention } = await import("../../src/ops/syncStatus.ts");
  const { zeroCounts } = await import("../../src/ops/sync.ts");
  const info = (o: { undecided?: Record<string, number>; signedOut?: number }) =>
    ({ undecided: o.undecided ?? {}, heldRehome: 0, signedOut: o.signedOut ?? 0, planned: { projects: 0, newProjects: [] } });
  const noop = { kind: "noop" as const, runId: null, counts: zeroCounts() };
  const undecided = attentionOf(noop, info({ undecided: { automated: 2, home: 1 } }))!;
  assert.deepEqual(undecided.facts, { n: 3, q: 2 });
  assert.equal(attentionBody(undecided, "pt"), "3 sessões em 2 categorias esperam pela tua decisão. Abre o T3 Code e escreve /t3sm:status, ou corre t3sm start.");
  assert.equal(attentionBody(undecided, "en"), `${undecided.detail}. Open T3 Code and type /t3sm:status, or run t3sm start.`, "English is the recorded detail");
  const one = attentionOf(noop, info({ undecided: { automated: 1 } }))!;
  assert.match(attentionBody(one, "pt"), /^1 sessão em 1 categoria espera pela tua decisão\./);
  assert.match(attentionBody(attentionOf(noop, info({ signedOut: 1 }))!, "pt"), /^1 conta tem a sessão terminada no T3 Code; as sessões dela esperam\./);
  assert.match(attentionBody(attentionOf({ kind: "over-limit", pending: 250, limit: 200 }, info({}))!, "pt"), /^250 sessões por importar; o limite sem supervisão é 200\./);
  assert.match(attentionBody(streakAttention(3), "pt"), /^Os últimos 3 ciclos de sincronização falharam\./);
  assert.match(attentionBody(incompatibleAttention("0.2.0"), "pt"), /^O T3 Code 0\.2\.0 não é compatível com o t3sm\./);
  // A record written before the facts existed (an older t3sm): English keeps its detail; Portuguese a sentence without
  // the numbers, never the English text.
  const legacy = { reason: "undecided" as const, detail: "3 sessions in 2 categories wait for your decision" };
  assert.match(attentionBody(legacy, "pt"), /^Há conversas à espera da tua decisão\./);
  assert.match(attentionBody(legacy, "en"), /^3 sessions in 2 categories wait for your decision\./);
  assert.equal(summaryBody({ imported: 3, projects: 2, newProjects: ["demo"] }, "pt"), "3 conversas novas em 2 projetos. Projeto novo: demo.");
  assert.equal(summaryBody({ imported: 1, projects: 1, newProjects: [] }, "pt"), "1 conversa nova em 1 projeto.");
  assert.match(summaryBody({ imported: 9, projects: 5, newProjects: ["a", "b", "c", "d"] }, "pt"), /Projetos novos: a, b, c e mais 1\./);
  const rb = updateNotice("rolled-back", { from: "0.3.0", to: "0.3.1" }, "pt");
  assert.equal(rb.title, "O t3sm precisa de ti");
  assert.match(rb.body, /O t3sm 0\.3\.1 não arrancou bem, por isso voltou o 0\.3\.0\. Corre t3sm update --check/);
  assert.match(updateNotice("failed", { from: "0.3.0", to: "0.3.1" }, "pt").body, /falhou; o 0\.3\.0 continua instalado/);
  assert.match(updateNotice("interrupted", { from: "0.3.0", to: "0.3.1" }, "pt").body, /foi interrompida/);
  const major = updateNotice("available", { to: "1.0.0" }, "pt");
  assert.equal(major.title, "O t3sm 1.0.0 está disponível");
  assert.match(major.body, /não é instalada sozinha/);
  assert.deepEqual(updateNotice("available", { to: "1.0.0" }, "en"), {
    title: "t3sm 1.0.0 is available",
    body: "A major release: it is not installed by itself. See what changes with t3sm update --check, then run t3sm update.",
  });
  // A cycle notifies in the language it is given.
  const dir = tempRoot().state;
  const r = recordingNotifier();
  await notifyAfterCycle({ stateDir: dir, mode: "all", notifier: r.n, now: NOW, attention: attention(), summary: { imported: 2, projects: 1, newProjects: [] }, lang: "pt" });
  assert.deepEqual(r.sent.map((x) => x.title), ["O t3sm precisa de ti", "t3sm"]);
  assert.match(r.sent[0]!.body, /^3 sessões em 2 categorias esperam/);
  assert.equal(r.sent[1]!.body, "2 conversas novas em 1 projeto.");
});
