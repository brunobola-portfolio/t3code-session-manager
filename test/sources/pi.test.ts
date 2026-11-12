import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAdapter } from "../../src/sources/pi.ts";
import { ACTIVE_WINDOW_MS, type Env } from "../../src/sources/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pi", "home");
const NOW = Date.parse("2026-06-01T00:00:00Z");
const OLD = new Date("2026-01-02T00:00:00Z");
const ID = (n: number) => `0190bbbb-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface Ctx { dir: string; sessions: string; env: Env }

async function stamp(d: string): Promise<void> {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) await stamp(p);
    else await utimes(p, OLD, OLD);
  }
}

async function setup(env: NodeJS.ProcessEnv = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-pi-"));
  await cp(FIX, dir, { recursive: true });
  await stamp(dir);
  return {
    dir, sessions: join(dir, ".pi", "agent", "sessions"),
    env: { home: dir, platform: process.platform, now: () => NOW, config: defaultConfig([]), stateDir: join(dir, "state"), env },
  };
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
const piFile = (c: Ctx, n: number) => join(c.sessions, "--C--work-demo--", `2026-01-01T00-00-0${n}-000Z_${ID(n)}.jsonl`);

test("discovers per-cwd and flat layouts; nativeId is the session record id; file path kept", async () => {
  const c = await setup();
  try {
    const all = await collect(createPiAdapter().discover(c.env));
    assert.equal(all.length, 6); // readme.txt ignored
    assert.ok(all.every((s) => s.harness === "pi" && s.accountId === null));
    const s = find(all, ID(1));
    assert.equal(s.cwd, "C:/work/demo");
    assert.equal(s.messageCount, 4); // active branch only: m1,a1,c1,c2
    assert.deepEqual(s.flags, []);
    assert.equal(s.file.path, piFile(c, 1));
    assert.equal(s.cwdOffsetBytes, (await readFile(s.file.path, "utf8")).indexOf("\n") + 1);
    const flat = find(all, "pi-flat-id");
    assert.equal(flat.file.path, join(c.sessions, "flat-one.jsonl"));
    assert.equal(flat.messageCount, 2);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("corrupt middle line is counted, not fatal", async () => {
  const c = await setup();
  try {
    const adapter = createPiAdapter();
    const s = find(await collect(adapter.discover(c.env)), ID(2));
    assert.equal(s.corruptLines, 1);
    assert.equal(s.messageCount, 2);
    assert.deepEqual(s.flags, ["corrupt-lines"]);
    assert.deepEqual(adapter.lastErrors, []);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("session record without id or cwd: id falls back to the file stem, no-cwd flagged", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createPiAdapter().discover(c.env)), `2026-01-01T00-00-03-000Z_${ID(3)}`);
    assert.equal(s.cwd, null);
    assert.ok(s.flags.includes("no-cwd") && s.flags.includes("cwd-unreadable"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("only-hidden, active and size flags", async () => {
  const c = await setup();
  try {
    const recent = new Date(NOW - ACTIVE_WINDOW_MS + 1000);
    await utimes(piFile(c, 5), recent, recent);
    await truncate(piFile(c, 1), 33 * 1024 * 1024);
    await utimes(piFile(c, 1), OLD, OLD);
    const all = await collect(createPiAdapter().discover(c.env));
    assert.deepEqual(find(all, ID(4)).flags, ["only-hidden"]);
    assert.ok(find(all, ID(5)).flags.includes("active"));
    assert.ok(find(all, ID(1)).flags.includes("over-32mib"));
    assert.ok(!find(all, ID(1)).flags.includes("over-4gib"));
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("session dir resolves like T3: SESSION_DIR, then AGENT_DIR/sessions, then ~/.pi/agent/sessions", async () => {
  const c = await setup();
  try {
    const empty = await mkdtemp(join(tmpdir(), "t3sm-pi-empty-"));
    try {
      const none = { ...c.env, home: empty };
      assert.equal(await createPiAdapter().isAvailable(none), false);
      assert.deepEqual(await collect(createPiAdapter().discover(none)), []);
      const viaSession = { ...none, env: { PI_CODING_AGENT_SESSION_DIR: c.sessions } };
      assert.equal(await createPiAdapter().isAvailable(viaSession), true);
      assert.equal((await collect(createPiAdapter().discover(viaSession))).length, 6);
      const viaAgent = { ...none, env: { PI_CODING_AGENT_DIR: join(c.dir, ".pi", "agent") } };
      assert.equal((await collect(createPiAdapter().discover(viaAgent))).length, 6);
      const viaTilde = { ...none, home: c.dir, env: { PI_CODING_AGENT_SESSION_DIR: "~/.pi/agent/sessions" } };
      assert.equal((await collect(createPiAdapter().discover(viaTilde))).length, 6);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("warm discover uses pi-discovery.json; changed files rescanned", async () => {
  const c = await setup();
  try {
    const scans: string[] = [];
    const adapter = createPiAdapter({ onScan: (p) => scans.push(p) });
    await collect(adapter.discover(c.env));
    assert.equal(scans.length, 6);
    assert.equal((await stat(join(c.env.stateDir, "cache", "pi-discovery.json"))).isFile(), true);
    scans.length = 0;
    await collect(adapter.discover(c.env));
    assert.equal(scans.length, 0);
    const p = piFile(c, 1);
    await writeFile(p, (await readFile(p, "utf8")) + "\n");
    await utimes(p, OLD, new Date(OLD.getTime() + 1000));
    await collect(adapter.discover(c.env));
    assert.deepEqual(scans, [p]);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});
