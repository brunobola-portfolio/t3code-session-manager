import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faithfulCopy } from "../../src/apply/copyTranscript.ts";

const DAY = 86_400_000;
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const OLD_ID = "11111111-2222-4333-8444-555555555555";
const NEW_ID = "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee";
const HOME_CWD = "C:\\Users\\demo";
const NEW_CWD = "C:\\work\\demo";
const PROV = { fromPath: "C:/Users/demo/.claude/projects/C--Users-demo/orig.jsonl", fromSessionId: OLD_ID, fromCwd: HOME_CWD };

/** Every kind of record a Claude transcript holds (synthetic), as the exact lines written to disk. */
const LINES = [
  `{"type":"summary","summary":"Synthetic summary","leafUuid":"u-9"}`,
  `{"type":"file-history-snapshot","messageId":"m-0","snapshot":{"trackedFileBackups":{},"timestamp":"2026-01-01T00:00:00.000Z"},"isSnapshotUpdate":false}`,
  JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", cwd: HOME_CWD, sessionId: OLD_ID, version: "2.0.0", gitBranch: "", type: "user", message: { role: "user", content: "olá, synthetic question ação ✅" }, uuid: "u-1", timestamp: "2026-01-01T00:00:01.000Z" }),
  JSON.stringify({ parentUuid: "u-1", isSidechain: false, cwd: HOME_CWD, sessionId: OLD_ID, type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "synthetic thought", signature: "sig==" }] }, uuid: "u-2", timestamp: "2026-01-01T00:00:02.000Z" }),
  JSON.stringify({ parentUuid: "u-2", isSidechain: false, cwd: HOME_CWD, sessionId: OLD_ID, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t-1", name: "Edit", input: { file_path: "C:\\work\\demo\\a.ts", cwd: "C:\\Users\\demo" } }] }, uuid: "u-3", timestamp: "2026-01-01T00:00:03.000Z" }),
  JSON.stringify({ parentUuid: "u-3", isSidechain: false, cwd: HOME_CWD, sessionId: OLD_ID, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: "ok" }] }, toolUseResult: { stdout: "ok" }, uuid: "u-4", timestamp: "2026-01-01T00:00:04.000Z" }),
  `{"type":"ai-title","aiTitle":"Synthetic title","sessionId":"${OLD_ID}"}`,
  `{"type":"custom-title","customTitle":"My synthetic name","sessionId":"${OLD_ID}"}`,
  `{"type": "x-unknown",  "spaced" : true}`, // odd formatting, no cwd / sessionId: byte for byte
  `{"cwd":"C:\\\\Users\\\\demo","type":"system","subtype":"x","sessionId":"${OLD_ID}","content":"\\u00e9"}`,
  `{"type":"user","message":{"role":"user","content":"trunc`, // corrupt (cut off): copied as it is
];

function source(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-copy-"));
  temps.push(dir);
  const file = join(dir, `${OLD_ID}.jsonl`);
  writeFileSync(file, text);
  const old = (Date.now() - 3 * DAY) / 1000;
  utimesSync(file, old, old);
  return file;
}
const opts = { cwd: NEW_CWD, sessionId: NEW_ID, provenance: PROV };

test("faithfulCopy: keeps every record and only swaps cwd and sessionId (tool_use, thinking, tool_result, summary, ai-title, custom-title)", async () => {
  const file = source(LINES.join("\n") + "\n");
  const { text, records } = await faithfulCopy(file, opts);
  assert.ok(text.endsWith("\n"));
  const out = text.slice(0, -1).split("\n");
  assert.equal(out.length, LINES.length + 1, "every line, plus the provenance record");
  assert.equal(records, LINES.length);
  for (let i = 0; i < LINES.length; i++) {
    const src = LINES[i]!;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(src) as Record<string, unknown>; } catch { /* corrupt: copied as it is */ }
    if (parsed === null || (!("cwd" in parsed) && !("sessionId" in parsed))) {
      assert.equal(out[i], src, `line ${i} byte for byte`);
      continue;
    }
    const got = JSON.parse(out[i]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(got), Object.keys(parsed), `line ${i}: same keys in the same order`);
    const want = { ...parsed, ...("cwd" in parsed ? { cwd: NEW_CWD } : {}), ...("sessionId" in parsed ? { sessionId: NEW_ID } : {}) };
    assert.deepEqual(got, want, `line ${i}: only cwd and sessionId differ`);
  }
  // Nested fields named cwd (tool input) are content, never rewritten.
  assert.match(out[4]!, /"input":\{"file_path":"C:\\\\work\\\\demo\\\\a.ts","cwd":"C:\\\\Users\\\\demo"\}/);
});

test("faithfulCopy: the provenance record is appended once, last, without a uuid", async () => {
  const file = source(LINES.slice(0, 6).join("\n") + "\n");
  const { text } = await faithfulCopy(file, opts);
  const out = text.trimEnd().split("\n");
  const prov = out.filter((l) => l.includes(`"t3sm-provenance"`));
  assert.equal(prov.length, 1);
  assert.equal(out.at(-1), JSON.stringify({ type: "t3sm-provenance", ...PROV, writtenBy: "t3code-session-manager" }));
  assert.equal("uuid" in (JSON.parse(out.at(-1)!) as object), false);
});

test("faithfulCopy: a source without a final newline still gets the provenance record on a line of its own; CRLF and a BOM are kept", async () => {
  const crlf = `\uFEFF${LINES[2]}\r\n${LINES[0]}\r\n${LINES[3]}`;
  const file = source(crlf);
  const { text, records } = await faithfulCopy(file, opts);
  assert.equal(records, 3);
  const out = text.split("\n");
  assert.equal(out.length, 5, "three records, provenance, and the final empty piece");
  assert.ok(out[0]!.startsWith("\uFEFF{") && out[0]!.endsWith("\r"), "BOM and CR kept on a rewritten line");
  assert.equal((JSON.parse(out[0]!.slice(1, -1)) as { sessionId: string }).sessionId, NEW_ID);
  assert.equal(out[1], `${LINES[0]}\r`, "an untouched CRLF line stays byte for byte");
  assert.equal((JSON.parse(out[2]!) as { cwd: string }).cwd, NEW_CWD, "the last line (no newline) is still rewritten");
  assert.match(out[3]!, /^\{"type":"t3sm-provenance"/);
  assert.equal(out[4], "");
});

test("faithfulCopy: the original file stays byte-identical (sha256) and keeps its mtime", async () => {
  const file = source(LINES.join("\n") + "\n");
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  const before = sha(readFileSync(file));
  const mtime = statSync(file).mtimeMs;
  await faithfulCopy(file, opts);
  assert.equal(sha(readFileSync(file)), before);
  assert.equal(statSync(file).mtimeMs, mtime);
});
