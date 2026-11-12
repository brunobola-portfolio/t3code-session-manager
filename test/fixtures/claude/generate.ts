// Regenerates the synthetic Claude fixtures: node test/fixtures/claude/generate.ts
// Synthetic text only, no personal data.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const CWD = "C:/work/demo";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (i: number) => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;

type Rec = Record<string, unknown>;
const user = (i: number, text: string, extra: Rec = {}): Rec =>
  ({ type: "user", message: { role: "user", content: text }, uuid: U(100 + i), timestamp: ts(i), cwd: CWD, ...extra });
const asst = (i: number, text: string, extra: Rec = {}): Rec =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, uuid: U(100 + i), timestamp: ts(i), cwd: CWD, ...extra });
const toolResult = (i: number): Rec =>
  ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, uuid: U(100 + i), timestamp: ts(i), cwd: CWD });

function write(rel: string, lines: (Rec | string)[]): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

rmSync(join(root, "home-a"), { recursive: true, force: true });
rmSync(join(root, "home-b"), { recursive: true, force: true });

const normal = (): Rec[] => [
  { type: "mode", mode: "normal" },
  user(1, "hello"), asst(2, "hi there"), toolResult(3), user(4, "thanks"), asst(5, "welcome"),
];

// home-a
write(`home-a/projects/C--work-demo/${U(1)}.jsonl`, normal());
write(`home-a/projects/C--work-demo/${U(2)}.jsonl`, [user(1, "one"), "{ this line is not json", asst(2, "two")]);
write(`home-a/projects/C--work-demo/${U(3)}.jsonl`, [
  user(1, "provenance", { isMeta: true }), asst(2, "meta too", { isMeta: true }), user(3, "compact", { isCompactSummary: true }),
]);
write(`home-a/projects/C--work-demo/not-a-uuid.jsonl`, [user(1, "hello"), asst(2, "hi")]);
write(`home-a/projects/C--work-demo/${U(4)}.jsonl`, [
  user(1, "main"), asst(2, "side", { isSidechain: true }), user(3, "side user", { isSidechain: true }), asst(4, "main reply"),
]);
write(`home-a/projects/C--work-demo/${U(5)}.jsonl`, [{ type: "summary", summary: "no cwd here" }, { type: "user", message: { role: "user", content: "x" } }]);
write(`home-a/projects/C--work-demo/${U(6)}.jsonl`, [{ type: "mode", mode: "normal" }, { type: "user", message: { role: "user", content: "x" }, timestamp: ts(1) }]);
write(`home-a/projects/C--work-demo/${U(12)}.jsonl`, [
  user(1, "run it"),
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, uuid: U(102), timestamp: ts(2), cwd: CWD },
  toolResult(3), asst(4, "done"),
]);
write(`home-a/projects/C--work-demo/notes.txt`, ["not a transcript"]);
write(`home-a/projects/C--work-demo/${U(1)}/subagents/agent-1.jsonl`, [user(1, "subagent")]);
// same uuid under case-variant dir names, in different accounts (one Windows FS cannot hold both)
write(`home-a/projects/D--Work-X/${U(7)}.jsonl`, [user(1, "same", { cwd: "D:/Work/X" }), asst(2, "same", { cwd: "D:/Work/X" })]);
// backups
write(`home-a/projects/D--Work-X.bak-20260630-111703/${U(8)}.jsonl`, [user(1, "bak", { cwd: "D:/Work/X" }), asst(2, "bak", { cwd: "D:/Work/X" })]);
write(`home-a/projects/.bak-20260701/D--Work-X/${U(9)}.jsonl`, [user(1, "bak2", { cwd: "D:/Work/X" }), asst(2, "bak2", { cwd: "D:/Work/X" })]);

// home-b
write(`home-b/projects/d--Work-X/${U(7)}.jsonl`, [user(1, "same", { cwd: "d:/Work/X" }), asst(2, "same", { cwd: "d:/Work/X" })]);
write(`home-b/projects/C--work-demo/${U(10)}.jsonl`, normal());
write(`home-b/projects/C--work-other/${U(11)}.jsonl`, [user(1, "other", { cwd: "C:/work/other" }), asst(2, "reply", { cwd: "C:/work/other" })]);
