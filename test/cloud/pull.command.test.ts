// `t3sm cloud pull` end to end (spec 2026-11-26 §7): fake `claude`, fake T3 Code, a temp home and invented text only.
// A session without a repository (no git at all): pulled, imported into T3 Code in the same run, pulled again after it
// grew in the cloud (a revision; the old thread archived), and rolled back (the transcripts go, the folder stays).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudCommand, type CloudDeps } from "../../src/cli/commands/cloud.ts";
import { rollbackCommand } from "../../src/cli/commands/rollback.ts";
import type { CloudProc, SpawnCloud } from "../../src/cloud/client.ts";
import type { Io } from "../../src/cli/main.ts";
import { Journal } from "../../src/core/journal.ts";
import { normalizeCwd } from "../../src/core/paths.ts";
import type { SignalSource } from "../../src/apply/apply.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import { DAY, fakeT3, inst, tempHome } from "../apply/fake-t3.ts";

class NoSignals implements SignalSource { on(): void {} off(): void {} }

const CLOUD_ID = "session_01PqRsTuVwXyZaBc";

/** A fake `claude` serving one session whose transcript has `count()` entries. */
function cloud(count: () => number, lastEventAt: () => string, extra: Record<string, unknown> = {}): SpawnCloud {
  return () => {
    let line: (l: string) => void = () => {};
    const exits: ((c: number | null, e: string) => void)[] = [];
    let done = false;
    const exit = (c: number | null): void => { if (done) return; done = true; for (const x of exits) x(c, ""); };
    const answer = (r: Record<string, unknown>): unknown => {
      if (r["subtype"] === "initialize") return {};
      if (r["subtype"] === "list_cloud_sessions") {
        return { status: "ok", sessions: [{ id: CLOUD_ID, title: "Sketch the release notes", status: "idle", environment_kind: "anthropic_cloud", last_event_at: lastEventAt(), created_at: "2026-11-01T10:00:00.000Z", origin: "ios", ...extra }], next_cursor: null };
      }
      const n = count();
      return {
        status: "ok", next_cursor: null,
        entries: Array.from({ length: n }, (_, i) => ({
          type: i % 2 === 0 ? "user" : "assistant", parentUuid: i === 0 ? null : `e${i - 1}`, uuid: `e${i}`, sessionId: CLOUD_ID,
          timestamp: new Date(Date.parse(lastEventAt()) - (n - i) * 1000).toISOString(), message: { role: i % 2 === 0 ? "user" : "assistant", content: `invented text ${i}` },
        })),
      };
    };
    const proc: CloudProc = {
      write(l) {
        const m = JSON.parse(l) as { request_id: string; request: Record<string, unknown> };
        const a = answer(m.request);
        queueMicrotask(() => line(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: a } })));
      },
      end: () => queueMicrotask(() => exit(0)),
      onLine: (cb) => { line = cb; },
      onExit: (cb) => { if (done) cb(0, ""); else exits.push(cb); },
      kill: () => exit(null),
    };
    return proc;
  };
}

function io(state: string): Io & { text: () => string } {
  const out: string[] = [];
  return {
    stdout: (s) => void out.push(s), stderr: (s) => void out.push(s), isTTY: false, prompt: async () => "",
    env: { T3SM_HOME: state, LANG: "en_US.UTF-8" }, lang: "en", text: () => out.join("").replace(/\s+/g, " "),
  };
}

/** A temp home with one account, fake T3 Code that sees every transcript of it, and the fake cloud. */
function world(o: { answered: boolean; extra?: Record<string, unknown> }) {
  const t = tempHome();
  const claudeHome = join(t.home, ".claude");
  const base = join(t.home, "work");
  mkdirSync(t.state, { recursive: true });
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent", routes: [],
    // The scratch home is under the system's temp folder: a folder there waits for its question unless a rule says so.
    ...(o.answered ? { organize: { overrides: [{ match: `${base.replaceAll("\\", "/")}/**`, action: "import" }] } } : {}) }));
  const f = fakeT3({ instances: [inst("claudeAgent", claudeHome)] });
  (f.api as { getConfig: unknown }).getConfig = async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: claudeHome } } } }, providers: [] });
  // T3 Code sees every transcript under the account's projects folder, under the folder its cwd names.
  f.opts.onScan = () => {
    const projects = join(claudeHome, "projects");
    if (!existsSync(projects)) return;
    for (const d of readdirSync(projects)) for (const file of readdirSync(join(projects, d))) {
      const p = join(projects, d, file);
      if (!file.endsWith(".jsonl") || f.files.some((x) => x.path === p)) continue;
      const cwd = (JSON.parse(readFileSync(p, "utf8").split("\n")[0]!) as { cwd: string }).cwd;
      f.files.push({ path: p, root: cwd });
    }
  };
  let n = 4;
  let last = new Date(Date.now() - 3 * DAY).toISOString();
  const deps: CloudDeps = {
    home: t.home, findBin: (b) => b, spawn: cloud(() => n, () => last, o.extra), connect: async () => f.api, signals: new NoSignals(),
    git: async () => { throw new Error("no git for a session without a repository"); },
    folderEnv: { platform: process.platform, home: t.home, tmpdir: join(t.home, "no-such-tmp"), env: {}, t3BaseDir: join(t.home, ".t3"), t3WorktreesDir: join(t.home, ".t3", "worktrees") },
  };
  const journal = (): Promise<JournalEntry[]> => new Journal(join(t.state, "journal.jsonl")).readAll();
  return { t, f, base, deps, journal, grow: (entries: number, daysAgo: number) => { n = entries; last = new Date(Date.now() - daysAgo * DAY).toISOString(); } };
}

test("cloud pull: written, imported in the same run, a revision after it grew (old thread archived), rolled back", async () => {
  const { t, f, base, deps, journal, grow } = world({ answered: true });

  // --dry-run: the preview, nothing written.
  const dry = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--dry-run"], dry, deps), 0, dry.text());
  assert.match(dry.text(), /Sketch the release notes/);
  assert.equal(existsSync(join(t.state, "journal.jsonl")), false);

  // First pull: written, journaled with its cloud origin, imported, and the base folder is not saved (--base).
  const first = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--yes"], first, deps), 0, first.text());
  const folder = normalizeCwd(join(base, "cloud-sessions", "01PqRsTuVwXy"));
  assert.equal(existsSync(folder), true);
  const j1 = await journal();
  const w1 = j1.find((e) => e.t === "file-written") as Extract<JournalEntry, { t: "file-written" }>;
  assert.equal(w1.cloudOf?.sessionId, CLOUD_ID);
  assert.equal(w1.cloudOf?.entries, 4);
  const runId = w1.runId;
  assert.ok(j1.some((e) => e.t === "imported" && e.runId === runId), JSON.stringify(j1.map((e) => e.t)) + first.text());
  assert.equal(new Set(j1.filter((e) => e.t === "run-start").map((e) => e.runId)).size, 1);
  const id1 = w1.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "");
  assert.ok(f.threads.has(`import:claudeAgent:${id1}`), first.text());
  assert.match(first.text(), new RegExp(`claude --resume ${id1}`));
  assert.match(first.text(), new RegExp(`t3sm rollback --run ${runId}`));
  assert.equal((JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")) as { cloud?: unknown }).cloud, undefined);

  // Nothing new in the cloud: nothing to do.
  const again = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--yes"], again, deps), 0, again.text());
  assert.equal((await journal()).filter((e) => e.t === "file-written").length, 1);

  // It went on in the cloud: a revision (a new id), imported, and the old thread archived.
  grow(6, 2);
  const second = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--yes"], second, deps), 0, second.text());
  const writes = (await journal()).filter((e): e is Extract<JournalEntry, { t: "file-written" }> => e.t === "file-written");
  assert.equal(writes.length, 2);
  const id2 = writes[1]!.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "");
  assert.notEqual(id2, id1);
  assert.equal(f.threads.get(`import:claudeAgent:${id2}`)?.archived, false);
  assert.equal(f.threads.get(`import:claudeAgent:${id1}`)?.archived, true);

  // Rollback of the first run: its transcript goes, the folder (code) stays.
  const rb = io(t.state);
  assert.equal(await rollbackCommand(["--run", runId, "--yes"], rb, { home: t.home, connect: async () => f.api, signals: new NoSignals() } as never), 0, rb.text());
  assert.equal(existsSync(w1.path), false);
  assert.equal(existsSync(writes[1]!.path), true);
  assert.equal(existsSync(folder), true);
});

test("cloud pull: a session the plan leaves out (a question not answered yet) is named, with the next step, and exits 5", async () => {
  const { t, f, base, deps } = world({ answered: false });
  const c = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--yes"], c, deps), 5, c.text());
  assert.match(c.text(), /Sketch the release notes is on this PC, but it was not imported into T3 Code: waits for your decision. Answer the open questions with t3sm start/);
  assert.equal([...f.threads.keys()].length, 0);
});

test("cloud pull --dry-run: a branch's worktree is announced only for when the branch is not checked out already", async () => {
  // A fresh clone can already sit on the session's branch (a repository whose only branch it is): no worktree then.
  const { t, base, deps } = world({ answered: true, extra: { repository: { owner: "demo", name: "app" }, branch: "feature/notes" } });
  const dry = io(t.state);
  assert.equal(await cloudCommand(["pull", "01PqRsTu", "--base", base, "--dry-run"], dry, deps), 0, dry.text());
  assert.match(dry.text(), /Worktree/);
  assert.match(dry.text().replace(/ ?[|│] ?/g, " ").replace(/\s+/g, " "), /only if that branch is not checked out already/);
});
