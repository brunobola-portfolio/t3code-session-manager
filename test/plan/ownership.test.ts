import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCopies, labelRecords, parseJsonc, pinFromSettings, projectAccount, readVscodePin } from "../../src/plan/ownership.ts";
import type { Config, DiscoveredSession } from "../../src/core/types.ts";
import { HOME, cfg, sess } from "./helpers.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-own-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A JSONL record whose cwd is a JSON-escaped Windows path (drive letter as given).
const rec = (i: number, drive = "C"): string => `{"type":"user","uuid":"u${i}","text":"msg ${i}","cwd":"${drive}:\\\\work\\\\demo"}`;
const body = (n: number, drive?: string): string => Array.from({ length: n }, (_, i) => rec(i, drive)).join("\n") + "\n";

// ---------- compareCopies ----------
const cmpCases: { name: string; a: string; b: string; want: string }[] = [
  { name: "identical", a: body(3), b: body(3), want: "identical" },
  { name: "drive case in cwd ignored", a: body(3, "c"), b: body(3, "C"), want: "identical" },
  { name: "a extends b", a: body(5), b: body(3), want: "a-extends-b" },
  { name: "b extends a (stale mirror with lower-case drive)", a: body(3, "c"), b: body(6), want: "b-extends-a" },
  { name: "shorter ends with a partial line is still a prefix", a: body(5), b: body(3) + rec(3).slice(0, 10), want: "a-extends-b" },
  { name: "partial last line on a, b longer", a: body(2) + "{\"type\":\"us", b: body(4), want: "b-extends-a" },
  { name: "diverged", a: body(3) + rec(99) + "\n", b: body(3) + rec(98) + "\n", want: "diverged" },
  { name: "empty vs content", a: "", b: body(1), want: "b-extends-a" },
  { name: "CRLF and LF compare equal", a: body(3).replace(/\n/g, "\r\n"), b: body(3), want: "identical" },
  // Real data (2026-11-11): mirrors differ in title/queue metadata records and in path case inside cwd.
  {
    name: "metadata records (ai-title, queue-operation, custom-title, last-prompt, mode) are ignored",
    a: `{"type":"ai-title","aiTitle":"T","sessionId":"s"}\n` + body(3) + `{"type":"last-prompt","lastPrompt":"p"}\n`,
    b: `{"type":"queue-operation","operation":"enqueue","timestamp":"t"}\n{"type":"custom-title","customTitle":"C"}\n` + body(5) + `{"type":"mode","mode":"x"}\n`,
    want: "b-extends-a",
  },
  { name: "metadata-only difference is identical", a: body(2) + `{"type":"ai-title","aiTitle":"A"}\n`, b: body(2), want: "identical" },
  { name: "nested type values are not treated as metadata", a: body(2) + `{"type":"user","message":{"type":"ai-title"}}\n`, b: body(2), want: "a-extends-b" },
  {
    name: "path case inside cwd is ignored",
    a: body(2).replace(/work\\\\demo/g, "Work\\\\Demo"), b: body(2), want: "identical",
  },
];
for (const c of cmpCases) {
  test(`compareCopies: ${c.name}`, async () => withTmp(async (d) => {
    await writeFile(join(d, "a.jsonl"), c.a);
    await writeFile(join(d, "b.jsonl"), c.b);
    assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "win32"), c.want);
  }));
}

// Review I1: a partial last line must actually be a prefix of the other copy's line.
const L = (k: string): string => `{"type":"assistant","text":"${k}"}`;
const partialCases: { name: string; a: string; b: string; want: string }[] = [
  { name: "partial that is not a prefix of the other line -> diverged", a: `${L("1")}
${L("2")}
{"type":"assistant","text":"XXXX`, b: `${L("1")}
${L("2")}
${L("YYYY")}
${L("4")}
`, want: "diverged" },
  { name: "partial on b that is not a prefix -> diverged", a: `${L("1")}
${L("YYYY")}
${L("3")}
`, b: `${L("1")}
{"type":"assistant","text":"XX`, want: "diverged" },
  { name: "partial on b that is a prefix -> a extends b", a: `${L("1")}
${L("2")}
${L("3")}
`, b: `${L("1")}
${L("2")}`.slice(0, -5), want: "a-extends-b" },
  { name: "longer file's only extra content is a garbage partial line -> identical", a: `${L("1")}
${L("2")}
{"type":"assi`, b: `${L("1")}
${L("2")}
`, want: "identical" },
  { name: "extra partial on b only -> identical", a: `${L("1")}
`, b: `${L("1")}
{"ty`, want: "identical" },
  { name: "extra complete line plus partial -> extends", a: `${L("1")}
`, b: `${L("1")}
${L("2")}
{"ty`, want: "b-extends-a" },
];
for (const c of partialCases) {
  test(`compareCopies partial: ${c.name}`, async () => withTmp(async (d) => {
    await writeFile(join(d, "a.jsonl"), c.a);
    await writeFile(join(d, "b.jsonl"), c.b);
    assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "win32"), c.want);
  }));
}

// Review M1: cwd case folding follows the platform.
test("compareCopies: cwd case folds on win32 and darwin, not on linux", async () => withTmp(async (d) => {
  await writeFile(join(d, "a.jsonl"), body(2).replace(/work\\\\demo/g, "Work\\\\Demo"));
  await writeFile(join(d, "b.jsonl"), body(2));
  assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "win32"), "identical");
  assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "darwin"), "identical");
  assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "linux"), "diverged");
  await writeFile(join(d, "c.jsonl"), body(2, "c"));
  assert.equal(await compareCopies(join(d, "c.jsonl"), join(d, "b.jsonl"), "linux"), "diverged");
}));

test("compareCopies: missing file rejects (the planner decides what to do)", async () => withTmp(async (d) => {
  await writeFile(join(d, "a.jsonl"), body(1));
  await assert.rejects(compareCopies(join(d, "a.jsonl"), join(d, "nope.jsonl"), "win32"));
}));

// Review M2: label records (custom-title, tag) of a copy.
test("labelRecords: custom-title and tag values, nothing else", async () => withTmp(async (d) => {
  await writeFile(join(d, "a.jsonl"), body(1) + `{"type":"custom-title","customTitle":"Mine","sessionId":"s"}
{"type":"ai-title","aiTitle":"Auto"}
{"type":"tag","tag":"wip"}
`);
  assert.deepEqual([...(await labelRecords(join(d, "a.jsonl")))].sort(), ["custom-title:Mine", "tag:wip"]);
  await writeFile(join(d, "b.jsonl"), body(2));
  assert.equal((await labelRecords(join(d, "b.jsonl"))).size, 0);
}));

test("compareCopies: streams large files (several MiB, long lines)", async () => withTmp(async (d) => {
  const big = Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(20_000) })).join("\n") + "\n";
  await writeFile(join(d, "a.jsonl"), big);
  await writeFile(join(d, "b.jsonl"), big + JSON.stringify({ i: 401 }) + "\n");
  assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "win32"), "b-extends-a");
}));

test("compareCopies: no lines lost between two streams (repeated small compares never hang)", { timeout: 10_000 }, async () => withTmp(async (d) => {
  await writeFile(join(d, "a.jsonl"), body(3));
  await writeFile(join(d, "b.jsonl"), body(3));
  for (let i = 0; i < 50; i++) assert.equal(await compareCopies(join(d, "a.jsonl"), join(d, "b.jsonl"), "win32"), "identical");
}));

// ---------- JSONC / pin ----------
test("parseJsonc: comments and trailing commas parse; strings keep // and /*", () => {
  const text = `{
    // line comment
    "a": "http://x/*y*/", /* block
    comment */ "b": [1, 2, ],
    "c": { "d": "e\\"//", },
  }`;
  assert.deepEqual(parseJsonc(text), { a: "http://x/*y*/", b: [1, 2], c: { d: "e\"//" } });
});

test("pinFromSettings: array form, object form, nested form, absent", () => {
  assert.equal(pinFromSettings({ "claudeCode.environmentVariables": [{ name: "X", value: "1" }, { name: "CLAUDE_CONFIG_DIR", value: "C:\\Users\\demo\\.claude-org" }] }), "C:\\Users\\demo\\.claude-org");
  assert.equal(pinFromSettings({ "claudeCode.environmentVariables": { CLAUDE_CONFIG_DIR: "~/.claude-org" } }), "~/.claude-org");
  assert.equal(pinFromSettings({ claudeCode: { environmentVariables: [{ name: "CLAUDE_CONFIG_DIR", value: "~/.claude" }] } }), "~/.claude");
  assert.equal(pinFromSettings({ "editor.tabSize": 2 }), null);
  assert.equal(pinFromSettings(null), null);
});

test("readVscodePin: .vscode/settings.json with comments and trailing commas parses", async () => withTmp(async (d) => {
  await mkdir(join(d, ".vscode"));
  await writeFile(join(d, ".vscode", "settings.json"), `{
  // pinned to org
  "claudeCode.environmentVariables": [
    { "name": "CLAUDE_CONFIG_DIR", "value": "C:\\\\Users\\\\demo\\\\.claude-org" }, /* secure storage */
    { "name": "CLAUDE_SECURESTORAGE_CONFIG_DIR", "value": "C:\\\\Users\\\\demo\\\\.claude-org" },
  ],
}`);
  assert.equal(await readVscodePin(d), "C:\\Users\\demo\\.claude-org");
}));

test("readVscodePin: settings.json with a UTF-8 BOM parses", async () => withTmp(async (d) => {
  await mkdir(join(d, ".vscode"));
  await writeFile(join(d, ".vscode", "settings.json"), "﻿" + `{"claudeCode.environmentVariables": [{"name":"CLAUDE_CONFIG_DIR","value":"~/.claude-org"}],}`);
  assert.equal(await readVscodePin(d), "~/.claude-org");
}));

test("readVscodePin: missing file or invalid JSON -> null; parents are not read", async () => withTmp(async (d) => {
  await mkdir(join(d, ".vscode"));
  await writeFile(join(d, ".vscode", "settings.json"), `{"claudeCode.environmentVariables": [{"name":"CLAUDE_CONFIG_DIR","value":"~/.claude-org"}]}`);
  await mkdir(join(d, "child"));
  assert.equal(await readVscodePin(join(d, "child")), null);
  await mkdir(join(d, "bad", ".vscode"), { recursive: true });
  await writeFile(join(d, "bad", ".vscode", "settings.json"), "{ not json");
  assert.equal(await readVscodePin(join(d, "bad")), null);
}));

// ---------- projectAccount ----------
const root = "C:/work/demo";
const noPin = async (): Promise<string | null> => null;
const pinTo = (v: string) => async (): Promise<string | null> => v;
const paCases: { name: string; config?: Partial<Config>; pin?: (r: string) => Promise<string | null>; sessions: DiscoveredSession[]; want: { accountId: string; source: string } }[] = [
  {
    name: "route wins over pin and activity",
    config: { routes: [{ match: "C:/work/**", account: "claude-org" }] },
    pin: pinTo("~/.claude"), sessions: [sess({ accountId: "claudeAgent", updatedAt: "2026-11-01T00:00:00Z" })],
    want: { accountId: "claude-org", source: "route" },
  },
  {
    name: "pin (absolute, backslashes, different case, trailing slash) wins over activity",
    pin: pinTo("c:\\Users\\demo\\.claude-org\\"), sessions: [sess({ accountId: "claudeAgent" })],
    want: { accountId: "claude-org", source: "vscode-pin" },
  },
  { name: "pin with ~ expands", pin: pinTo("~/.claude-org"), sessions: [], want: { accountId: "claude-org", source: "vscode-pin" } },
  {
    name: "pin to an unknown home is ignored",
    pin: pinTo("C:/elsewhere/.claude-x"), sessions: [sess({ accountId: "claude-org", cwd: "c:\\work\\demo\\" })],
    want: { accountId: "claude-org", source: "recent-activity" },
  },
  {
    name: "newest activity among sessions with sameCwd (other roots and non-Claude ignored)",
    pin: noPin,
    sessions: [
      sess({ accountId: "claude-org", updatedAt: "2026-10-01T00:00:00Z" }),
      sess({ accountId: "claudeAgent", updatedAt: "2026-10-05T00:00:00Z", cwd: "c:/work/demo/" }),
      sess({ accountId: "claude-org", updatedAt: "2026-11-01T00:00:00Z", cwd: "C:/work/other" }),
      sess({ harness: "codex", accountId: null, updatedAt: "2026-11-02T00:00:00Z" }),
    ],
    want: { accountId: "claudeAgent", source: "recent-activity" },
  },
  { name: "nothing -> default", pin: noPin, sessions: [], want: { accountId: "claudeAgent", source: "default" } },
];
for (const c of paCases) {
  test(`projectAccount: ${c.name}`, async () => {
    const r = await projectAccount(root, { sessions: c.sessions, config: cfg(c.config), readVscodePin: c.pin ?? noPin, platform: "win32", home: HOME });
    assert.deepEqual(r, c.want);
  });
}
