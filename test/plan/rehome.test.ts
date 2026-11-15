import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferProjectRoot } from "../../src/plan/rehome.ts";

const HOME = "C:/Users/demo";
const w = { platform: "win32" as const, home: HOME };

async function withFile<T>(lines: unknown[], fn: (f: string) => Promise<T>, raw = ""): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-rehome-"));
  try {
    const f = join(dir, "s.jsonl");
    await writeFile(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + raw);
    return await fn(f);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const edit = (p: string, name = "Edit") => ({
  type: "assistant", cwd: HOME,
  message: { content: [{ type: "tool_use", name, input: { file_path: p } }] },
});
const bash = (command: string) => ({
  type: "assistant", cwd: HOME,
  message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
});
const many = (n: number, root: string) => Array.from({ length: n }, (_, i) => edit(`${root}/src/f${i}.ts`));

test("63 of 80 paths in one root gives that root with share 0.7875", async () => {
  const lines = [...many(63, "D:/work/app"), ...many(17, "D:/other/x")];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app", "D:/other/x"], w));
  assert.deepEqual(g, { root: "D:/work/app", hits: 63, total: 80, share: 63 / 80 });
});

test("home cwd on every record is excluded from total; paths inside home still count", async () => {
  const lines = [...many(5, "D:/work/app"), edit("C:/Users/demo/notes/a.md"), { type: "user", cwd: HOME }];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.hits, 5);
  assert.equal(g?.total, 6);
});

test("4 hits only gives null", async () => {
  assert.equal(await withFile(many(4, "D:/work/app"), (f) => inferProjectRoot(f, ["D:/work/app"], w)), null);
});

test("two roots 50/50 gives null", async () => {
  const lines = [...many(10, "D:/a"), ...many(10, "D:/b")];
  assert.equal(await withFile(lines, (f) => inferProjectRoot(f, ["D:/a", "D:/b"], w)), null);
});

test("share below 0.6 gives null", async () => {
  const lines = [...many(10, "D:/a"), ...many(8, "D:/zzz")];
  assert.equal(await withFile(lines, (f) => inferProjectRoot(f, ["D:/a"], w)), null);
});

test("nested roots count for the deepest", async () => {
  const lines = [...many(6, "D:/work/app/packages/ui"), ...many(1, "D:/work/app/readme")];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app", "D:/work/app/packages/ui"], w));
  assert.equal(g?.root, "D:/work/app/packages/ui");
  assert.equal(g?.hits, 6);
});

test("a sibling with a shared name prefix is not inside the root", async () => {
  const lines = many(8, "D:/work/app-old");
  assert.equal(await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w)), null);
});

test("relative paths are ignored", async () => {
  const lines = [...many(5, "D:/work/app"), edit("src/a.ts"), edit("./b.ts"), bash("cd sub && ls")];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.total, 5);
});

test("4 path spellings count for the same root on win32", async () => {
  const lines = [
    edit("D:\\work\\app\\a.ts"), edit("d:/work/app/b.ts"), edit("\\\\?\\D:\\work\\app\\c.ts"),
    edit("D:/WORK/App/d.ts"), edit("D:\\work\\app\\sub\\..\\e.ts"),
  ];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.hits, 5);
});

test("cd in Bash: bare, quoted, cd /d, after &&", async () => {
  const lines = [
    bash("cd D:\\work\\app && npm test"), bash('cd "D:/work/app/src"'), bash("cd 'D:/work/app'; ls"),
    bash("cd /d D:\\work\\app\\test"), bash("ls && cd D:/work/app/x"),
  ];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.hits, 5);
});

test("path, notebook_path and tool input cwd are collected; record cwd inside a root counts", async () => {
  const tool = (input: Record<string, unknown>) => ({
    type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input }] },
  });
  const lines = [
    tool({ path: "D:/work/app/a" }), tool({ notebook_path: "D:/work/app/n.ipynb" }), tool({ cwd: "D:/work/app" }),
    { type: "user", cwd: "D:/work/app/src" }, tool({ file_path: "D:/work/app/z" }),
  ];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.hits, 5);
});

test("corrupt lines are tolerated", async () => {
  const g = await withFile(many(6, "D:/work/app"), (f) => inferProjectRoot(f, ["D:/work/app"], w), "{not json\n[1]\n");
  assert.equal(g?.hits, 6);
});

test("posix: case matters and windows-style paths are ignored", async () => {
  const p = { platform: "linux" as const, home: "/home/demo" };
  const lines = [...many(5, "/code/App"), edit("/code/app/x.ts"), edit("D:/work/app/y.ts")];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["/code/App"], p));
  assert.equal(g?.hits, 5);
  assert.equal(g?.total, 6);
});

test("win32: Git Bash drive paths in cd (/d/..., /c/...) count as D:/..., C:/...; cmd's cd /d still works", async () => {
  const lines = [
    bash("cd /d/work/app && npm test"), bash("cd /D/work/app/src"), bash('cd "/d/work/app"'), bash("ls; cd /d/work/app/x"),
    bash("cd /d D:\\work\\app\\test"), bash("cd /c/Users/demo/other"),
  ];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app", "C:/Users/demo/other"], w));
  assert.deepEqual(g && { root: g.root, hits: g.hits, total: g.total }, { root: "D:/work/app", hits: 5, total: 6 });
});

test("posix: a /d/... cd target stays a POSIX path (no drive mapping)", async () => {
  const p = { platform: "linux" as const, home: "/home/demo" };
  const g = await withFile(Array.from({ length: 5 }, () => bash("cd /d/work/app")), (f) => inferProjectRoot(f, ["/d/work/app"], p));
  assert.equal(g?.root, "/d/work/app");
  assert.equal(g?.hits, 5);
});

test("PowerShell tool commands: Set-Location (with or without -Path) and cd, any case, quoted or bare", async () => {
  const ps = (command: string) => ({ type: "assistant", cwd: HOME, message: { content: [{ type: "tool_use", name: "PowerShell", input: { command } }] } });
  const lines = [
    ps("Set-Location D:\\work\\app; npm test"), ps("cd 'D:/work/app/src'"), ps('Set-Location -Path "D:/work/app"'),
    ps("npm test; cd D:/work/app/x"), ps("set-location -LiteralPath D:\\work\\app\\test"),
    // Not a PowerShell tool: its Set-Location is not read.
    bash("Set-Location D:/work/app"),
  ];
  const g = await withFile(lines, (f) => inferProjectRoot(f, ["D:/work/app"], w));
  assert.equal(g?.hits, 5);
  assert.equal(g?.total, 5);
});

test("minHits is overridable; no roots gives null", async () => {
  const g = await withFile(many(2, "D:/a"), (f) => inferProjectRoot(f, ["D:/a"], { ...w, minHits: 2 }));
  assert.equal(g?.hits, 2);
  assert.equal(await withFile([], (f) => inferProjectRoot(f, [], w)), null);
});
