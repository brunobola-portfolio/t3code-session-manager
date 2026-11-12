// Regenerates the synthetic Pi fixtures: node test/fixtures/pi/generate.ts
// Record structure copied from a real Pi v3 session file; every value is synthetic.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const CWD = "C:/work/demo";
export const ID = (n: number) => `0190bbbb-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ts = (i: number) => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
type Rec = Record<string, unknown>;

const session = (id: string | null, withCwd = true): Rec =>
  ({ type: "session", version: 3, ...(id ? { id } : {}), timestamp: ts(0), ...(withCwd ? { cwd: CWD } : {}) });
const entry = (id: string, parent: string | null, i: number, extra: Rec): Rec => ({ type: "message", id, parentId: parent, timestamp: ts(i), ...extra });
const user = (id: string, parent: string | null, i: number, text: string): Rec =>
  entry(id, parent, i, { message: { role: "user", content: [{ type: "text", text }], timestamp: 1793744563500 + i } });
const asst = (id: string, parent: string | null, i: number, text: string): Rec =>
  entry(id, parent, i, { message: { role: "assistant", content: [{ type: "text", text }], api: "demo", provider: "demo", model: "demo", stopReason: "stop", timestamp: 1793744563500 + i } });
const sys = (id: string, parent: string | null): Rec =>
  entry(id, parent, 1, { message: { role: "system", content: "", sections: { preamble: "synthetic" }, timestamp: 1793744563500 } });
const modelChange: Rec = { type: "model_change", id: "e1", parentId: null, timestamp: ts(1), provider: "demo", modelId: "demo" };
const info: Rec = { type: "session_info", id: "e2", parentId: "e1", timestamp: ts(1), name: "synthetic" };

function write(rel: string, lines: (Rec | string)[]): void {
  const p = join(root, "home", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
const dir = ".pi/agent/sessions/--C--work-demo--";
const file = (n: number) => `${dir}/2026-01-01T00-00-0${n}-000Z_${ID(n)}.jsonl`;

rmSync(join(root, "home"), { recursive: true, force: true });
// normal, with an abandoned branch (b1,b2); active branch m1,a1,c1,c2 => 4 messages
write(file(1), [session(ID(1)), modelChange, info, sys("s0", "e2"), user("m1", "s0", 2, "q1"), asst("a1", "m1", 3, "r1"),
  user("b1", "a1", 4, "abandoned"), asst("b2", "b1", 5, "abandoned"), user("c1", "a1", 6, "q2"), asst("c2", "c1", 7, "r2")]);
// corrupt middle line
write(file(2), [session(ID(2)), user("m1", null, 2, "q"), "{ this is not json", asst("a1", "m1", 3, "r")]);
// no session id and no cwd: id falls back to the file stem
write(file(3), [session(null, false), user("m1", null, 2, "q"), asst("a1", "m1", 3, "r")]);
// only hidden: system + assistant, no user
write(file(4), [session(ID(4)), sys("s0", null), asst("a1", "s0", 2, "r")]);
// recently modified (test sets the mtime)
write(file(5), [session(ID(5)), user("m1", null, 2, "q"), asst("a1", "m1", 3, "r")]);
// flat layout: custom session dir holds .jsonl directly; non-UUID id is fine
write(".pi/agent/sessions/flat-one.jsonl", [session("pi-flat-id"), user("m1", null, 2, "q"), asst("a1", "m1", 3, "r")]);
// ignored: not jsonl
write(`${dir}/readme.txt`, ["not a session"]);
