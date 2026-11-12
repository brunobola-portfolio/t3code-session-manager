import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "../../src/sources/codex.ts";
import { ACTIVE_WINDOW_MS, CWD_SCAN_MAX_BYTES, type Env } from "../../src/sources/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex", "home");
const NOW = Date.parse("2026-06-01T00:00:00Z");
const OLD = new Date("2026-01-02T00:00:00Z");
const ID = (n: number) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface Ctx { dir: string; home: string; env: Env }

async function stamp(d: string): Promise<void> {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) await stamp(p);
    else await utimes(p, OLD, OLD);
  }
}

async function setup(env: NodeJS.ProcessEnv = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-codex-"));
  const home = join(dir, ".codex");
  await cp(FIX, home, { recursive: true });
  await stamp(home);
  return { dir, home, env: { home: dir, platform: process.platform, now: () => NOW, config: defaultConfig([]), stateDir: join(dir, "state"), env } };
}

async function collect(it: AsyncIterable<DiscoveredSession>): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  for await (const s of it) out.push(s);
  return out;
}
const find = (all: DiscoveredSession[], id: string): DiscoveredSession => {
  const s = all.find((x) => x.nativeId === id);
  assert.ok(s, `session ${id} not found`);
  return s;
};
const rolloutPath = (c: Ctx, d: string, n: number) =>
  join(c.home, "sessions", "2026", "01", d, `rollout-2026-01-${d}T00-00-00-${ID(n)}.jsonl`);

test("discovers rollout files with id, cwd and messageCount from the T3 rules", async () => {
  const c = await setup();
  try {
    const all = await collect(createCodexAdapter().discover(c.env));
    assert.equal(all.length, 7); // notes.jsonl is not a rollout file
    assert.ok(all.every((s) => s.harness === "codex" && s.accountId === null));
    const s = find(all, ID(1));
    assert.equal(s.cwd, "C:/work/demo");
    // T3 count is 2: in the segment before the assistant, the response-item user messages (env context
    // and prompt) share turn-1 and the prompt text equals the event_msg user_message, so turn-1 is
    // canonical and both response copies are dropped (AgentSessionScanner.ts:433-446, 583-588).
    assert.equal(s.messageCount, 2);
    assert.equal(s.corruptLines, 0);
    assert.deepEqual(s.flags, []);
    assert.equal(s.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(s.updatedAt, "2026-01-01T00:00:07.000Z");
    assert.equal(s.file.path, rolloutPath(c, "01", 1));
    assert.equal(s.cwdOffsetBytes, (await readFile(s.file.path, "utf8")).indexOf("\n") + 1);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("id comes from payload.session_id when payload.id is absent; corrupt middle line is counted, not fatal", async () => {
  const c = await setup();
  try {
    const adapter = createCodexAdapter();
    const s = find(await collect(adapter.discover(c.env)), ID(2));
    assert.equal(s.corruptLines, 1);
    assert.equal(s.messageCount, 2);
    assert.deepEqual(s.flags, ["corrupt-lines"]);
    assert.deepEqual(adapter.lastErrors, []);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("no session_meta: cwd from turn_context but no id -> no-session-id flag; nativeId is the stem for display only", async () => {
  const c = await setup();
  try {
    const all = await collect(createCodexAdapter().discover(c.env));
    const s = find(all, `rollout-2026-01-03T00-00-00-${ID(8)}`);
    assert.equal(s.cwd, "C:/work/demo");
    assert.deepEqual(s.flags, ["no-session-id"]);
    // no cwd anywhere as well (fixture 3)
    const s3 = find(all, `rollout-2026-01-01T00-00-00-${ID(3)}`);
    assert.equal(s3.cwd, null);
    assert.deepEqual(s3.flags.toSorted(), ["cwd-unreadable", "no-cwd", "no-session-id"]);
    assert.equal(s3.cwdOffsetBytes, s3.file.size);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("subagent rollouts are flagged subagent (not no-cwd); a top-level cwd on the meta wins like T3; sessions without a user message are only-hidden", async () => {
  const c = await setup();
  try {
    const all = await collect(createCodexAdapter().discover(c.env));
    const sub = find(all, ID(4));
    assert.equal(sub.cwd, null);
    assert.deepEqual(sub.flags, ["subagent"]);
    const hid = find(all, ID(5));
    assert.deepEqual(hid.flags, ["only-hidden"]);
    assert.equal(hid.messageCount, 1);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("active flag within ACTIVE_WINDOW_MS; clears later even with a warm cache", async () => {
  const c = await setup();
  try {
    const recent = new Date(NOW - ACTIVE_WINDOW_MS + 1000);
    await utimes(rolloutPath(c, "02", 6), recent, recent);
    const adapter = createCodexAdapter();
    assert.ok(find(await collect(adapter.discover(c.env)), ID(6)).flags.includes("active"));
    const later = { ...c.env, now: () => NOW + 5 * ACTIVE_WINDOW_MS };
    assert.ok(!find(await collect(adapter.discover(later)), ID(6)).flags.includes("active"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("size flag over-32mib", async () => {
  const c = await setup();
  try {
    const p = rolloutPath(c, "01", 1);
    await truncate(p, 33 * 1024 * 1024);
    await utimes(p, OLD, OLD);
    const s = find(await collect(createCodexAdapter().discover(c.env)), ID(1));
    assert.ok(s.flags.includes("over-32mib"));
    assert.ok(!s.flags.includes("over-4gib"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("cwd beyond 1 MiB is cwd-unreadable, as T3 reads at most 1 MiB", async () => {
  const c = await setup();
  try {
    const p = rolloutPath(c, "01", 1);
    const pad = JSON.stringify({ type: "response_item", payload: { type: "other", pad: "x".repeat(CWD_SCAN_MAX_BYTES) } });
    const lines = (await readFile(p, "utf8")).split("\n");
    await writeFile(p, `${pad}\n${lines.join("\n")}`);
    await utimes(p, OLD, OLD);
    const s = find(await collect(createCodexAdapter().discover(c.env)), ID(1));
    assert.equal(s.cwd, "C:/work/demo");
    assert.ok(s.flags.includes("cwd-unreadable"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("CODEX_HOME env overrides ~/.codex; isAvailable reflects the sessions dir", async () => {
  const c = await setup();
  try {
    assert.equal(await createCodexAdapter().isAvailable(c.env), true);
    const empty = await mkdtemp(join(tmpdir(), "t3sm-codex-empty-"));
    try {
      const viaEnv = { ...c.env, home: empty, env: { CODEX_HOME: c.home } };
      assert.equal(await createCodexAdapter().isAvailable({ ...c.env, home: empty }), false);
      assert.equal(await createCodexAdapter().isAvailable(viaEnv), true);
      assert.equal((await collect(createCodexAdapter().discover(viaEnv))).length, 7);
      assert.deepEqual(await collect(createCodexAdapter().discover({ ...c.env, home: empty })), []);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("warm discover uses codex-discovery.json; changed files rescanned; corrupt cache rebuilt", async () => {
  const c = await setup();
  try {
    const scans: string[] = [];
    const adapter = createCodexAdapter({ onScan: (p) => scans.push(p) });
    await collect(adapter.discover(c.env));
    assert.equal(scans.length, 7);
    const cache = join(c.env.stateDir, "cache", "codex-discovery.json");
    assert.equal((await stat(cache)).isFile(), true);
    scans.length = 0;
    await collect(adapter.discover(c.env));
    assert.equal(scans.length, 0);
    const p = rolloutPath(c, "01", 1);
    await writeFile(p, (await readFile(p, "utf8")) + "\n");
    await utimes(p, OLD, new Date(OLD.getTime() + 1000));
    await collect(adapter.discover(c.env));
    assert.deepEqual(scans, [p]);
    await writeFile(cache, "{ not json");
    scans.length = 0;
    assert.equal((await collect(adapter.discover(c.env))).length, 7);
    assert.equal(scans.length, 7);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("a rollout path that cannot be streamed goes to lastErrors and never throws", async () => {
  const c = await setup();
  try {
    await mkdir(join(c.home, "sessions", "2026", "01", "03", "rollout-dir.jsonl"), { recursive: true });
    const adapter = createCodexAdapter();
    const all = await collect(adapter.discover(c.env));
    assert.equal(all.length, 7);
    assert.equal(adapter.lastErrors.length, 0); // directories are skipped, not errors
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("a top-level cwd on a subagent session_meta is checked before the subagent rule (T3 order)", async () => {
  const c = await setup();
  try {
    const p = rolloutPath(c, "02", 4);
    const lines = (await readFile(p, "utf8")).split("\n");
    const meta = JSON.parse(lines[0]!);
    meta.cwd = "C:/work/top";
    await writeFile(p, [JSON.stringify(meta), ...lines.slice(1)].join("\n"));
    await utimes(p, OLD, OLD);
    const s = find(await collect(createCodexAdapter().discover(c.env)), ID(4));
    assert.equal(s.cwd, "C:/work/top");
    assert.deepEqual(s.flags, []);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("blank lines count toward the 1000-record window: cwd after 1000 blank lines is cwd-unreadable", async () => {
  const c = await setup();
  try {
    const p = rolloutPath(c, "01", 1);
    const lines = (await readFile(p, "utf8")).split("\n");
    await writeFile(p, "\n".repeat(1000) + lines.join("\n"));
    await utimes(p, OLD, OLD);
    const s = find(await collect(createCodexAdapter().discover(c.env)), ID(1));
    assert.equal(s.cwd, "C:/work/demo");
    assert.ok(s.flags.includes("cwd-unreadable"));
    await writeFile(p, "\n".repeat(999) + lines.join("\n"));
    await utimes(p, OLD, OLD);
    assert.ok(!find(await collect(createCodexAdapter().discover(c.env)), ID(1)).flags.includes("cwd-unreadable"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("conversion off (codex.convertCompressed false): compressed rollouts (.jsonl.zst) are listed, never read: flag compressed, id from the file name, mtime as updatedAt", async () => {
  const c = await setup();
  c.env.config = { ...c.env.config, codex: { convertCompressed: false } };
  try {
    const day = join(c.home, "sessions", "2026", "01", "02");
    const zst = join(day, `rollout-2026-01-02T05-06-07-${ID(20)}.jsonl.zst`);
    const odd = join(day, "rollout-odd.jsonl.zst");
    // Content is irrelevant: not valid zstd, not JSON. A read would show up in onScan or as corrupt lines.
    await writeFile(zst, "\x28\xb5\x2f\xfd not really zstd");
    await writeFile(odd, "garbage");
    const mtime = new Date("2026-01-05T00:00:00Z");
    await utimes(zst, mtime, mtime);
    await utimes(odd, OLD, OLD);
    await writeFile(join(day, "rollout-x.json.zst"), "not a rollout"); // wrong extension: ignored
    const scans: string[] = [];
    const adapter = createCodexAdapter({ onScan: (p) => scans.push(p) });
    const all = await collect(adapter.discover(c.env));
    assert.equal(all.length, 7 + 2);
    assert.ok(!scans.some((p) => p.endsWith(".zst")), "a compressed file is never opened");
    const s = find(all, ID(20));
    assert.deepEqual(s.flags, ["compressed"]);
    assert.equal(s.cwd, null);
    assert.equal(s.messageCount, 0);
    assert.equal(s.corruptLines, 0);
    assert.equal(s.updatedAt, mtime.toISOString());
    assert.equal(s.file.path, zst);
    assert.deepEqual(find(all, "rollout-odd").flags, ["compressed"]);
    assert.deepEqual(adapter.lastErrors, []);
    // Conversion on (the default): the same files are decompressed; neither is valid zstd, so both are read errors.
    const on = createCodexAdapter();
    assert.equal((await collect(on.discover({ ...c.env, config: defaultConfig([]) }))).length, 7);
    assert.equal(on.lastErrors.length, 2);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("symlinked rollouts and day dirs are followed; a broken link goes to lastErrors", async () => {
  const c = await setup();
  try {
    const day = join(c.home, "sessions", "2026", "01", "02");
    try {
      await symlink(rolloutPath(c, "01", 1), join(day, "rollout-2026-01-02T00-00-01-linked.jsonl"), "file");
      await symlink(join(c.dir, "missing-target"), join(day, "rollout-broken.jsonl"), "file");
      await symlink(join(c.home, "sessions", "2026", "01", "01"), join(c.home, "sessions", "2026", "01", "09"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return; // symlinks not permitted on this machine
      throw e;
    }
    const adapter = createCodexAdapter();
    const all = await collect(adapter.discover(c.env));
    assert.equal(all.length, 7 + 1 + 3); // linked file + three rollouts reached through the linked day dir
    assert.equal(adapter.lastErrors.length, 1);
    assert.ok(adapter.lastErrors[0]!.path.endsWith("rollout-broken.jsonl"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});
