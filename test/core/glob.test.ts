import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp } from "../../src/core/glob.ts";

test("** matches any depth, case-insensitive on win32", () => {
  const re = globToRegExp("D:/Projects/**", "win32");
  assert.equal(re.test("d:/projects/a/b"), true);
  assert.equal(re.test("d:/other/a"), false);
});

test("leading and trailing **", () => {
  const re = globToRegExp("**/node_modules/**", "linux");
  assert.equal(re.test("C:/x/node_modules/y"), true);
  assert.equal(re.test("/node_modules/y"), true);
  assert.equal(re.test("/x/node_modules"), true);
  assert.equal(re.test("/x/node_modules_extra/y"), false);
});

test("* does not cross /", () => {
  const re = globToRegExp("/a/*/c", "linux");
  assert.equal(re.test("/a/b/c"), true);
  assert.equal(re.test("/a/b/x/c"), false);
});

test("case-sensitive on linux; regex specials are literal", () => {
  assert.equal(globToRegExp("/A/b", "linux").test("/a/b"), false);
  assert.equal(globToRegExp("/a.b/(x)", "linux").test("/aXb/(x)"), false);
  assert.equal(globToRegExp("/a.b/(x)", "linux").test("/a.b/(x)"), true);
});
