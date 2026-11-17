// `t3sm stats`: read-only, no T3 Code, nothing written (not even the discovery cache), English --json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { statsCommand } from "../../src/cli/commands/stats.ts";
import type { DiscoveredSession, JournalEntry } from "../../src/core/types.ts";
import type { Env, SourceAdapter } from "../../src/sources/types.ts";
import { sess, uuid } from "../plan/helpers.ts";
import { displayWidth } from "../../src/ui/text.ts";
import { defaultConfig } from "../../src/core/config.ts";

function setup(lang = "en_US.UTF-8", columns?: number) {
  const home = mkdtempSync(join(tmpdir(), "t3sm-stats-"));
  const state = join(home, "state");
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state, LANG: lang },
    ...(lang.startsWith("pt") ? { lang: "pt" as const } : {}),
    ...(columns ? { caps: { color: 0, unicode: true, isTTY: false, columns } } : {}),
  };
  return { home, state, io, out: () => out.join(""), err: () => err.join("") };
}

function adapter(sessions: DiscoveredSession[], seen: { readOnly?: boolean }[] = []): SourceAdapter {
  return {
    id: "claude", mode: "native", isAvailable: async () => true,
    async *discover(env: Env) { seen.push({ readOnly: env.readOnly }); for (const s of sessions) yield s; },
  } as unknown as SourceAdapter;
}

const sessions = (): DiscoveredSession[] => [
  sess({ mtimeMs: Date.parse("2026-09-03T12:00:00Z") }),
  sess({ mtimeMs: Date.parse("2026-10-03T12:00:00Z"), accountId: "claude-org" }),
  sess({ harness: "codex", mtimeMs: Date.parse("2026-10-04T12:00:00Z") }),
];

test("stats prints sessions per agent, account and month, the imported totals and that nothing is sent anywhere", async () => {
  const s = setup();
  mkdirSync(s.state, { recursive: true });
  const journal: JournalEntry[] = [
    { t: "run-start", runId: "r1", at: "2026-10-05T10:00:00.000Z", command: "apply" },
    { t: "imported", runId: "r1", harness: "claude", nativeId: uuid(1), threadId: "t1", source: { path: "C:/x", size: 1, mtimeMs: 1 } },
  ];
  writeFileSync(join(s.state, "journal.jsonl"), journal.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const seen: { readOnly?: boolean }[] = [];
  const before = readdirSync(s.state).sort();
  assert.equal(await statsCommand([], s.io, { home: s.home, adapters: [adapter(sessions(), seen)], now: () => Date.parse("2026-11-17T12:00:00Z") }), 0, s.err());
  const o = s.out().replace(/\s+/g, " ");
  assert.match(o, /Sessions found\s+3/);
  assert.match(o, /Imported into T3 Code\s+1/);
  assert.match(o, /Claude Code\s+2/);
  assert.match(o, /Codex\s+1/);
  assert.match(o, /2026-10\s+2/);
  assert.match(o, /2026-09\s+1/);
  assert.match(o, /nothing is sent anywhere/);
  assert.match(o, /No plan yet/);
  assert.deepEqual(seen, [{ readOnly: true }], "discovery runs read-only (no cache saved)");
  assert.deepEqual(readdirSync(s.state).sort(), before, "stats writes nothing in the state folder");
});

test("stats --json: English keys, masked account names, no paths", async () => {
  const s = setup("pt_PT.UTF-8");
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "config.json"), JSON.stringify(defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "demo@example.com", accentColor: null }])));
  assert.equal(await statsCommand(["--json"], s.io, { home: s.home, adapters: [adapter(sessions())] }), 0, s.err());
  const j = JSON.parse(s.out());
  assert.equal(j.sessions, 3);
  assert.deepEqual(j.agents, [{ agent: "claude", sessions: 2 }, { agent: "codex", sessions: 1 }]);
  assert.equal(j.accounts.find((a: { accountId: string }) => a.accountId === "claudeAgent").name, "d***@example.com");
  assert.deepEqual(j.imported, { threads: 0, byAgent: [], converted: 0, failed: 0, runs: 0, lastAt: null });
  assert.equal(j.latestPlan, null);
  assert.doesNotMatch(s.out(), /C:\/work|demo@example\.com/);
});

test("stats in Portuguese, at 40 columns, never wider than the window; no state folder is created", async () => {
  const s = setup("pt_PT.UTF-8", 40);
  assert.equal(await statsCommand([], s.io, { home: s.home, adapters: [adapter(sessions())] }), 0, s.err());
  const o = s.out();
  assert.match(o, /Sessões encontradas/);
  assert.match(o.replace(/\s+/g, " "), /nada é enviado/);
  for (const l of o.split("\n")) assert.ok(displayWidth(l) <= 40, l);
  assert.ok(!existsSync(s.state), "nothing written");
});

test("stats: no sessions says so; an unknown option is a usage error; main dispatches it", async () => {
  const s = setup();
  assert.equal(await statsCommand([], s.io, { home: s.home, adapters: [adapter([])] }), 0);
  assert.match(s.out(), /No sessions found/);
  const b = setup();
  assert.equal(await main(["stats", "--nope"], b.io), 2);
  assert.match(b.err(), /Unknown option: --nope/);
});
