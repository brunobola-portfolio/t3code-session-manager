// Static guarantees behind the README's Safety section: t3sm never opens T3 Code's database or edits its settings
// file. It reaches T3 Code only through the `t3` CLI and its RPC/HTTP API (src/t3/), and reads exactly one file of
// T3 Code's data folder: userdata/server-runtime.json (where the server listens). These checks scan the source, so a
// change that starts touching T3 Code's files directly fails here before it can ship.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src");

function sources(dir = SRC): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push({ rel: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
  }
  return out;
}

/** The code of a file without comments, so documentation mentioning a path never counts as using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("no source file refers to T3 Code's database (statev2.sqlite or any T3 sqlite)", () => {
  for (const f of sources()) {
    assert.doesNotMatch(f.text, /statev2/i, `${f.rel} mentions statev2`);
    assert.doesNotMatch(code(f.text), /["'`][^"'`]*\.t3[\\/][^"'`]*\.sqlite/i, `${f.rel} builds a path to a T3 sqlite file`);
  }
});

test("node:sqlite is used only by the OpenCode adapter (on a private copy, see test/sources/opencode.test.ts)", () => {
  const users = sources().filter((f) => /node:sqlite/.test(code(f.text))).map((f) => f.rel);
  assert.deepEqual(users, ["sources/opencode.ts"]);
});

test("the only T3 Code data file t3sm opens is userdata/server-runtime.json, read-only; its CLI is found in .t3/bin", () => {
  const uses: string[] = [];
  for (const f of sources()) {
    for (const line of code(f.text).split("\n")) {
      if (!/["'`]\.t3["'`]/.test(line)) continue;
      uses.push(`${f.rel}: ${line.trim()}`);
      const runtime = /"userdata",\s*"server-runtime\.json"/.test(line) && /readFile\(/.test(line);
      const cli = /"bin"/.test(line) && !/write|append|rename|unlink|rm\(|utimes/i.test(line);
      assert.ok(runtime || cli, `unexpected use of T3 Code's folder: ${f.rel}: ${line.trim()}`);
    }
  }
  assert.ok(uses.length >= 2, `expected the runtime read and the CLI lookup, found:\n${uses.join("\n")}`);
});

test("T3 Code settings change only through the server.updateSettings RPC, never by writing settings.json", () => {
  for (const f of sources()) {
    const c = code(f.text);
    for (const line of c.split("\n")) {
      if (!/settings\.json/.test(line)) continue;
      // .vscode/settings.json is read for account pins; nothing writes any settings.json.
      assert.doesNotMatch(line, /write|append|rename|atomicWrite|copyFile/i, `${f.rel} writes a settings.json: ${line.trim()}`);
    }
  }
  const api = sources().find((f) => f.rel === "t3/api.ts");
  assert.ok(api && /server\.updateSettings/.test(api.text), "t3/api.ts changes settings through server.updateSettings");
});
