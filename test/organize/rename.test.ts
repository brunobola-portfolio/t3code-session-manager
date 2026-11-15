import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestProjectTitles } from "../../src/organize/rename.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import type { T3Project } from "../../src/t3/api.ts";

// Synthetic fixtures only: invented ids and `C:/work/...` folders.

const project = (id: string, root: string, title: string, o: Partial<T3Project> = {}): T3Project =>
  ({ id, title, workspaceRoot: root, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null, ...o });
const created = (projectId: string, root: string, title?: string): JournalEntry =>
  (title === undefined ? { t: "project-created", runId: "r0", projectId, root } : { t: "project-created", runId: "r0", projectId, root, title });
const O = { maxLength: 40, platform: "win32" as const };
const pairs = (xs: { target: string; previous: unknown; next: unknown }[]) => xs.map((a) => [a.target, a.previous, a.next]);

test("suggestProjectTitles: only projects t3sm created whose title is still t3sm's (journaled title, else the folder name)", () => {
  const projects = [
    project("old", "C:/work/shop/src", "src"), // old entry, no title: t3sm named it after the folder
    project("new", "C:/work/shop/api", "api"), // journaled title "api"
    project("mine", "C:/work/lib/src", "src"), // the user's own project
    project("renamed", "C:/work/blog/app", "Blog"), // t3sm named it "app", the user renamed it
    project("clean", "C:/work/demo", "demo"), // already clean
    project("gone", "C:/work/old/src", "src", { deleted: true }),
  ];
  const journal = [
    created("old", "C:/work/shop/src"), created("new", "C:/work/shop/api", "api"), created("renamed", "C:/work/blog/app", "app"),
    created("clean", "C:/work/demo", "demo"), created("gone", "C:/work/old/src"),
  ];
  const out = suggestProjectTitles(projects, journal, O);
  assert.deepEqual(pairs(out), [["new", "api", "shop/api"], ["old", "src", "shop/src"]]);
  assert.ok(out.every((a) => a.kind === "project-title" && a.projectId === a.target));
});

test("suggestProjectTitles: titles stay unique against every project and against each other", () => {
  const projects = [
    project("a", "C:/one/shop/src", "src"),
    project("b", "C:/two/shop/src", "src"),
    project("c", "C:/x/y", "shop/src"), // the user's project already holds the plain clean name
  ];
  const out = suggestProjectTitles(projects, [created("a", "C:/one/shop/src"), created("b", "C:/two/shop/src")], O);
  const titles = out.map((a) => String(a.next).toLowerCase());
  assert.equal(new Set([...titles, "shop/src"]).size, titles.length + 1, JSON.stringify(out));
  assert.deepEqual(pairs(out), [["a", "src", "shop/src · one"], ["b", "src", "shop/src · two"]]);
});

test("suggestProjectTitles: a project t3sm renamed is judged on that rename; an undone rename is never proposed again", () => {
  const p = project("a", "C:/work/shop/src", "shop/src");
  const renamed: JournalEntry = { t: "organize-change", runId: "r1", kind: "project-title", target: "a", previous: "src", next: "shop/src" };
  // Still t3sm's name, and already clean: nothing.
  assert.deepEqual(suggestProjectTitles([p], [created("a", "C:/work/shop/src"), renamed], O), []);
  // The rename was undone (title back to "src", which differs from t3sm's last name): left alone.
  assert.deepEqual(suggestProjectTitles([{ ...p, title: "src" }], [created("a", "C:/work/shop/src"), renamed], O), []);
  // With a smaller limit the next suggestion follows t3sm's own last name.
  const short = suggestProjectTitles([p], [created("a", "C:/work/shop/src"), renamed], { ...O, maxLength: 6 });
  assert.equal(short.length, 1);
  assert.equal(short[0]!.previous, "shop/src");
});

test("suggestProjectTitles: the General folder keeps its fixed title", () => {
  const g = project("g", "C:/Users/demo/T3 General", "General");
  assert.deepEqual(suggestProjectTitles([g], [created("g", g.workspaceRoot, "General")], { ...O, generalFolder: "c:/users/demo/t3 general" }), []);
  assert.equal(suggestProjectTitles([g], [created("g", g.workspaceRoot, "General")], O).length, 1, "without the folder it would be renamed");
});
