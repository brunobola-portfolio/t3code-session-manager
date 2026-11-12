import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCwd, sameCwd, encodeClaudeProjectDir, expandHome, stateDir } from "../../src/core/paths.ts";

test("normalizeCwd: win32 drive, slashes, trailing slash", () => {
  assert.equal(normalizeCwd("d:\\Projects\\X\\", "win32"), "D:/Projects/X");
  assert.equal(normalizeCwd("D:/Projects/X/", "win32"), "D:/Projects/X");
});

test("normalizeCwd: resolves . and ..", () => {
  assert.equal(normalizeCwd("C:\\a\\.\\b\\..\\c", "win32"), "C:/a/c");
  assert.equal(normalizeCwd("/a/./b/../c/", "linux"), "/a/c");
});

test("normalizeCwd: strips long-path prefix (300 chars)", () => {
  const parts = Array.from({ length: 30 }, () => "abcdefghi");
  const deep = "C:\\" + parts.join("\\");
  assert.ok(deep.length > 260);
  assert.equal(normalizeCwd("\\\\?\\" + deep, "win32"), "C:/" + parts.join("/"));
  assert.equal(normalizeCwd("\\\\?\\UNC\\srv\\share\\x", "win32"), "//srv/share/x");
});

test("normalizeCwd: UNC and WSL", () => {
  assert.equal(normalizeCwd("\\\\srv\\share\\x", "win32"), "//srv/share/x");
  assert.equal(normalizeCwd("\\\\wsl.localhost\\Ubuntu\\home\\u", "win32"), "//wsl.localhost/Ubuntu/home/u");
});

test("normalizeCwd: roots keep their slash, posix keeps case", () => {
  assert.equal(normalizeCwd("c:\\", "win32"), "C:/");
  assert.equal(normalizeCwd("/", "linux"), "/");
  assert.equal(normalizeCwd("/A/b/", "linux"), "/A/b");
});

test("sameCwd: case rules per platform", () => {
  assert.equal(sameCwd("D:/a/Ação", "d:\\A\\ação", "win32"), true);
  assert.equal(sameCwd("/a/B", "/a/b", "linux"), false);
  assert.equal(sameCwd("/a/B", "/a/b", "darwin"), true);
});

test("encodeClaudeProjectDir", () => {
  assert.equal(encodeClaudeProjectDir("D:\\Projects\\Acme-App"), "D--Projects-Acme-App");
  assert.equal(encodeClaudeProjectDir("C:\\Users\\demo"), "C--Users-demo");
  assert.equal(encodeClaudeProjectDir("/home/a b/ç"), "-home-a-b--");
});

test("expandHome and stateDir", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/x/y", "/h"), "/h/x/y");
  assert.equal(expandHome("~\\x", "C:/h"), "C:/h/x");
  assert.equal(expandHome("/abs", "/h"), "/abs");
  assert.equal(expandHome("a~b", "/h"), "a~b");
  assert.equal(stateDir({ T3SM_HOME: "/custom" }, "/h"), "/custom");
  assert.equal(stateDir({}, "/h"), "/h/.t3code-session-manager");
  assert.equal(stateDir({ T3SM_HOME: "" }, "/h"), "/h/.t3code-session-manager");
});

test("normalizeCwd: bare drive letter becomes the drive root", () => {
  assert.equal(normalizeCwd("D:", "win32"), "D:/");
  assert.equal(normalizeCwd("d:", "win32"), "D:/");
});

test("tildePath: inside home -> ~/..., case-folded on win32; outside -> normalized", async () => {
  const { tildePath } = await import("../../src/core/paths.ts");
  const bs = (s: string) => s.replace(/\//g, String.fromCharCode(92));
  assert.equal(tildePath(bs("c:/Users/Demo/.claude-org/"), bs("C:/Users/demo"), "win32"), "~/.claude-org");
  assert.equal(tildePath(bs("C:/Users/demo"), "C:/Users/demo", "win32"), "~");
  assert.equal(tildePath(bs("C:/Users/demolition/x"), bs("C:/Users/demo"), "win32"), "C:/Users/demolition/x");
  assert.equal(tildePath("/home/Demo/x", "/home/demo", "linux"), "/home/Demo/x");
  assert.equal(tildePath("/home/demo/a/b", "/home/demo", "linux"), "~/a/b");
});
