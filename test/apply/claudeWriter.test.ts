import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isConvertedTranscript, toClaudeJsonl, NO_TEXT_PLACEHOLDER } from "../../src/apply/claudeWriter.ts";
import { uuidV5 } from "../../src/core/uuid.ts";
import type { CanonicalMessage, CanonicalTranscript } from "../../src/core/types.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "claude", "converted-minimal.jsonl");
const S = "00000000-0000-4000-8000-000000000301";
/** A real v5 id (what the planner gives a conversion). */
const S2 = uuidV5("opencode:ses_demo");
const CWD = "C:\\work\\demo";

type Rec = Record<string, unknown> & { message: { role: string; content: unknown } };
const lines = (text: string): Rec[] => text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Rec);

function transcript(messages: CanonicalMessage[], over: Partial<CanonicalTranscript> = {}): CanonicalTranscript {
  return { harness: "opencode", nativeId: "ses_demo", cwd: "C:/work/demo", title: "demo", startedAt: "2026-01-01T00:00:00Z", messages, ...over };
}

const msg = (role: "user" | "assistant", text: string, timestamp: string): CanonicalMessage => ({ role, text, timestamp });

/** The S3 fixture's conversation as a canonical transcript (the adapter would produce exactly this). */
const S3_MESSAGES: CanonicalMessage[] = [
  msg("user", "Remember the codeword PINEAPPLE-42. What is 2 + 2?", "2026-01-01T00:00:01.000Z"),
  msg("assistant", "Noted the codeword.\n2 + 2 = 4.", "2026-01-01T00:00:02.000Z"),
  msg("user", "[tool bash] ls -la → total 8\n-rw-r--r-- 1 demo demo 120 notas.txt\nAgora em português: ação, coração, pão 🍞✅. Summarise the tool output.", "2026-01-01T00:00:03.000Z"),
  msg("assistant", "A pasta tem um ficheiro: notas.txt (120 bytes). Tudo certo ✅ — ação concluída.", "2026-01-01T00:00:04.000Z"),
];

/** Ids and timestamps replaced by placeholders; assistant text blocks joined the way T3 renders them (S3 §7: "\n"). */
function normalize(recs: Rec[]): unknown[] {
  return recs.map((r, i) => {
    const content = r.message.role === "assistant"
      ? [{ type: "text", text: (r.message.content as { text: string }[]).map((b) => b.text).join("\n") }]
      : r.message.content;
    return {
      ...r,
      parentUuid: r.parentUuid === null ? null : `<u${i - 1}>`,
      uuid: `<u${i}>`,
      timestamp: "<ts>",
      sessionId: "<S>",
      message: { ...r.message, content },
    };
  });
}

test("toClaudeJsonl: the S3 conversation equals the live-tested fixture (same records, fields and field order) modulo ids/timestamps", () => {
  const { text, truncated } = toClaudeJsonl(transcript(S3_MESSAGES), { uuid: S, cwd: CWD });
  assert.equal(truncated, false);
  const got = normalize(lines(text));
  const want = normalize(lines(readFileSync(FIXTURE, "utf8")));
  assert.equal(JSON.stringify(got), JSON.stringify(want), "byte-identical after normalization (key order included)");
});

test("toClaudeJsonl: S3 record rules: provenance isMeta root, linear chain, uuidV5 record ids, sessionId + cwd on every record, trailing newline", () => {
  const { text } = toClaudeJsonl(transcript(S3_MESSAGES), { uuid: S, cwd: CWD });
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  assert.ok(!text.includes("\r"));
  const recs = lines(text);
  assert.equal(recs.length, 5);
  recs.forEach((r, i) => {
    assert.equal(r.uuid, uuidV5(`${S}:${i}`));
    assert.equal(r.parentUuid, i === 0 ? null : recs[i - 1]!.uuid);
    assert.equal(r.sessionId, S);
    assert.equal(r.cwd, CWD);
    assert.equal(r.isMeta, i === 0 ? true : undefined);
    assert.deepEqual(Object.keys(r), i === 0
      ? ["parentUuid", "type", "isMeta", "message", "uuid", "timestamp", "cwd", "sessionId"]
      : ["parentUuid", "type", "message", "uuid", "timestamp", "cwd", "sessionId"]);
    assert.equal(r.type, r.message.role);
    if (r.type === "user") assert.equal(typeof r.message.content, "string");
    else assert.ok(Array.isArray(r.message.content) && (r.message.content as { type: string }[]).every((b) => b.type === "text"));
  });
  assert.equal(recs[0]!.message.content, "Imported from opencode session ses_demo (started 2026-01-01T00:00:00Z) by t3code-session-manager.");
  assert.equal(recs[3]!.message.content, S3_MESSAGES[2]!.text, "flattened tool line and accents kept verbatim");
});

test("toClaudeJsonl: deterministic (same input, byte-identical output)", () => {
  const t = transcript(S3_MESSAGES);
  assert.equal(toClaudeJsonl(t, { uuid: S, cwd: CWD }).text, toClaudeJsonl(structuredClone(t), { uuid: S, cwd: CWD }).text);
});

test("toClaudeJsonl: timestamps are ISO-8601 UTC with ms, strictly increasing; ties and reversals step +1 ms; invalid ones fall back to startedAt + index ms", () => {
  const t = transcript([
    msg("user", "a", "2026-01-01T00:00:05.000Z"),
    msg("assistant", "b", "2026-01-01T00:00:05.000Z"), // tie
    msg("user", "c", "2026-01-01T00:00:01.000Z"), // goes backwards
    msg("assistant", "d", "not a date"),
    msg("user", "e", "2026-01-01T01:00:00+01:00"), // offset form = 00:00:00Z, still behind
  ]);
  const ts = lines(toClaudeJsonl(t, { uuid: S, cwd: CWD }).text).map((r) => r.timestamp as string);
  for (const x of ts) assert.match(x, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(ts, [
    "2026-01-01T00:00:00.000Z", // provenance = startedAt
    "2026-01-01T00:00:05.000Z",
    "2026-01-01T00:00:05.001Z",
    "2026-01-01T00:00:05.002Z",
    "2026-01-01T00:00:05.003Z", // invalid -> startedAt + 3 ms, then lifted above the previous record
    "2026-01-01T00:00:05.004Z",
  ]);
  const ms = ts.map((x) => Date.parse(x));
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i]! > ms[i - 1]!);

  const early = lines(toClaudeJsonl(transcript([msg("user", "a", "2025-12-31T23:59:59.000Z")]), { uuid: S, cwd: CWD }).text);
  assert.ok(Date.parse(early[0]!.timestamp as string) < Date.parse(early[1]!.timestamp as string), "provenance never after the first message");
  const bad = lines(toClaudeJsonl(transcript([msg("user", "a", "x"), msg("assistant", "b", "y")], { startedAt: "garbage" }), { uuid: S, cwd: CWD }).text);
  assert.deepEqual(bad.map((r) => r.timestamp), ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.001Z", "1970-01-01T00:00:00.002Z"]);
});

test("toClaudeJsonl: empty (or whitespace-only) text gets the placeholder", () => {
  const recs = lines(toClaudeJsonl(transcript([msg("user", "q", "2026-01-01T00:00:01Z"), msg("assistant", "  \n", "2026-01-01T00:00:02Z")]), { uuid: S, cwd: CWD }).text);
  assert.deepEqual(recs[2]!.message.content, [{ type: "text", text: NO_TEXT_PLACEHOLDER }]);
  assert.equal(NO_TEXT_PLACEHOLDER, "[no text content]");
});

test("toClaudeJsonl: consecutive same-role messages merge into one record (blank line between, latest timestamp)", () => {
  const recs = lines(toClaudeJsonl(transcript([
    msg("user", "first", "2026-01-01T00:00:01Z"),
    msg("assistant", "[tool bash] ls → a.txt", "2026-01-01T00:00:02Z"),
    msg("assistant", "Done.", "2026-01-01T00:00:03Z"),
    msg("user", "thanks", "2026-01-01T00:00:04Z"),
    msg("user", "", "2026-01-01T00:00:05Z"),
  ]), { uuid: S, cwd: CWD }).text);
  assert.deepEqual(recs.map((r) => r.type), ["user", "user", "assistant", "user"]);
  assert.deepEqual(recs[2]!.message.content, [{ type: "text", text: "[tool bash] ls → a.txt\n\nDone." }]);
  assert.equal(recs[2]!.timestamp, "2026-01-01T00:00:03.000Z");
  assert.equal(recs[3]!.message.content, "thanks", "an empty part of a merged run adds nothing");
});

test("toClaudeJsonl: over maxHistoryBytes keeps the provenance, the first user message and the newest messages that fit", () => {
  const messages: CanonicalMessage[] = [msg("assistant", "greeting before any user text", "2026-01-01T00:00:00.500Z")];
  for (let i = 0; i < 40; i++) {
    messages.push(msg(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"x".repeat(200)}`, new Date(Date.UTC(2026, 0, 1, 0, 0, 1 + i)).toISOString()));
  }
  const t = transcript(messages);
  const full = toClaudeJsonl(t, { uuid: S, cwd: CWD });
  assert.equal(full.truncated, false);
  const max = 3000;
  const { text, truncated } = toClaudeJsonl(t, { uuid: S, cwd: CWD, maxHistoryBytes: max });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, "utf8") <= max, `fits (${Buffer.byteLength(text)} <= ${max})`);
  const recs = lines(text);
  assert.equal(recs[0]!.isMeta, true);
  assert.match(recs[0]!.message.content as string, /^Imported from opencode session ses_demo \(started 2026-01-01T00:00:00Z\) by t3code-session-manager\. \d+ earlier messages were left out to fit the size limit\.$/);
  assert.match(recs[1]!.message.content as string, /^message 0 /, "first user message kept");
  const tail = recs.slice(2).map((r) => (r.type === "user" ? r.message.content : (r.message.content as { text: string }[])[0]!.text) as string);
  assert.ok(tail.length >= 2);
  assert.match(tail.at(-1)!, /^message 39 /, "newest kept");
  const nums = tail.map((x) => Number(/^message (\d+)/.exec(x)![1]));
  assert.deepEqual(nums, nums.map((_, k) => 40 - nums.length + k), "a contiguous newest slice");
  recs.forEach((r, i) => {
    assert.equal(r.uuid, uuidV5(`${S}:${i}`));
    assert.equal(r.parentUuid, i === 0 ? null : recs[i - 1]!.uuid);
  });
  assert.equal(toClaudeJsonl(t, { uuid: S, cwd: CWD, maxHistoryBytes: max }).text, text, "deterministic when truncated");
});

test("toClaudeJsonl: rejects a non-UUID session id (T3 ignores non-UUID Claude ids, S2)", () => {
  assert.throws(() => toClaudeJsonl(transcript(S3_MESSAGES), { uuid: "ses_demo", cwd: CWD }), /UUID/);
});

test("toClaudeJsonl: an invalid startedAt falls back to the first valid message time (provenance and invalid-time fallbacks)", () => {
  const recs = lines(toClaudeJsonl(transcript([msg("user", "a", "nope"), msg("assistant", "b", "2026-03-04T05:06:07.000Z")], { startedAt: "garbage" }), { uuid: S, cwd: CWD }).text);
  assert.deepEqual(recs.map((r) => r.timestamp), ["2026-03-04T05:06:07.000Z", "2026-03-04T05:06:07.001Z", "2026-03-04T05:06:07.002Z"]);
});

test("toClaudeJsonl: a first user message larger than the whole budget is clipped with a marker (the result fits)", () => {
  const t = transcript([msg("user", "q".repeat(10_000), "2026-01-01T00:00:01Z"), msg("assistant", "short answer", "2026-01-01T00:00:02Z")]);
  const max = 2000;
  const { text, truncated } = toClaudeJsonl(t, { uuid: S, cwd: CWD, maxHistoryBytes: max });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= max, `${Buffer.byteLength(text)} <= ${max}`);
  const recs = lines(text);
  assert.match(recs[1]!.message.content as string, /^q+… \[truncated by t3code-session-manager\]$/);
});

test("isConvertedTranscript: only a v5 id whose first record is t3sm's provenance for a convert harness (cheap: the id is checked first)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "t3sm-writer-"));
  try {
    const conv = join(dir, `${S2}.jsonl`);
    writeFileSync(conv, toClaudeJsonl(transcript(S3_MESSAGES), { uuid: S2, cwd: CWD }).text);
    assert.equal(await isConvertedTranscript(conv, S2), true);
    const claudeLike = toClaudeJsonl({ ...transcript(S3_MESSAGES), harness: "claude" }, { uuid: S2, cwd: CWD }).text;
    const notConvert = join(dir, "x.jsonl");
    writeFileSync(notConvert, claudeLike);
    assert.equal(await isConvertedTranscript(notConvert, S2), false, "provenance of a non-convert harness (e.g. a merge-style rewrite)");
    // Codex converts its compressed sessions (convert mode per session): its provenance is a conversion too.
    const codex = join(dir, "c.jsonl");
    writeFileSync(codex, toClaudeJsonl({ ...transcript(S3_MESSAGES), harness: "codex" }, { uuid: S2, cwd: CWD }).text);
    assert.equal(await isConvertedTranscript(codex, S2), true);
    const pi = join(dir, "p.jsonl");
    writeFileSync(pi, toClaudeJsonl({ ...transcript(S3_MESSAGES), harness: "pi" }, { uuid: S2, cwd: CWD }).text);
    assert.equal(await isConvertedTranscript(pi, S2), false, "pi is never converted");
    const native = join(dir, "n.jsonl");
    writeFileSync(native, `{"type":"user","message":{"role":"user","content":"hi"},"sessionId":"${S2}"}\n`);
    assert.equal(await isConvertedTranscript(native, S2), false);
    assert.equal(await isConvertedTranscript(join(dir, "does-not-exist.jsonl"), "11111111-1111-4111-8111-111111111111"), false, "a v4 id never opens the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
