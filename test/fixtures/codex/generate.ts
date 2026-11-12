// Regenerates the synthetic Codex fixtures: node test/fixtures/codex/generate.ts
// Record structure copied from a real rollout file; every value is synthetic.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const CWD = "C:/work/demo";
export const ID = (n: number) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ts = (i: number) => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
type Rec = Record<string, unknown>;

const meta = (id: string, extra: Rec = {}, withCwd = true): Rec => ({
  timestamp: ts(0), ordinal: 0, type: "session_meta",
  payload: { session_id: id, id, timestamp: ts(0), ...(withCwd ? { cwd: CWD } : {}), originator: "demo", ...extra },
});
const turnCtx = (i: number): Rec => ({ timestamp: ts(i), ordinal: i, type: "turn_context", payload: { turn_id: `turn-${i}`, cwd: CWD, model: "demo-model" } });
const msg = (i: number, role: string, text: string, turn = "turn-1"): Rec => ({
  timestamp: ts(i), ordinal: i, type: "response_item",
  payload: {
    type: "message", id: `msg-${i}`, role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn },
  },
});
const evUser = (i: number, text: string): Rec => ({ timestamp: ts(i), ordinal: i, type: "event_msg", payload: { type: "user_message", message: text } });
const tokens = (i: number): Rec => ({ timestamp: ts(i), ordinal: i, type: "token_usage_record", payload: { turn_id: "turn-1", usage: {} } });

function write(rel: string, lines: (Rec | string)[]): void {
  const p = join(root, "home", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
const name = (day: string, n: number) => `sessions/2026/01/${day}/rollout-2026-01-${day}T00-00-00-${ID(n)}.jsonl`;

rmSync(join(root, "home"), { recursive: true, force: true });
// normal: env-context user + duplicated prompt (response copy + event copy) + assistant. T3 drops every
// response-item user of a turn whose prompt an event_msg repeats (env-context included) => 2 messages
write(name("01", 1), [meta(ID(1)), turnCtx(1), msg(2, "developer", "synthetic rules"), msg(3, "user", "<environment_context>synthetic</environment_context>"),
  msg(4, "user", "hello synthetic"), evUser(5, "hello synthetic"), msg(6, "assistant", "hi synthetic"), tokens(7)]);
// corrupt middle line; id from payload.session_id only
write(name("01", 2), [{ ...meta(ID(2)), payload: { session_id: ID(2), cwd: CWD } }, msg(2, "user", "q"), "{ this is not json", msg(4, "assistant", "a")]);
// no session_meta and no cwd anywhere
write(name("01", 3), [msg(1, "user", "q"), msg(2, "assistant", "a")]);
// subagent session: T3 excludes it from cwd discovery
write(name("02", 4), [meta(ID(4), { source: { subagent: { parent: ID(1) } } }), msg(2, "user", "q"), msg(3, "assistant", "a")]);
// only hidden records (developer + assistant, no user)
write(name("02", 5), [meta(ID(5)), msg(1, "developer", "rules"), msg(2, "assistant", "a")]);
// recently modified (test sets the mtime)
write(name("02", 6), [meta(ID(6)), msg(1, "user", "q"), msg(2, "assistant", "a")]);
// no session_meta (no id) but a turn_context carries the cwd: T3 never imports it
write(name("03", 8), [turnCtx(1), msg(2, "user", "q"), msg(3, "assistant", "a")]);
// ignored: not a rollout file, and outside sessions/YYYY/MM/DD
write("sessions/2026/01/01/notes.jsonl", [meta(ID(7)), msg(1, "user", "q")]);
write("session_index.jsonl", [{ id: ID(1), thread_name: "synthetic", updated_at: ts(1) }]);
