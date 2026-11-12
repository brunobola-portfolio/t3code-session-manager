import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveEntry } from "../../bin/entry.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A fake checkout layout: <root>/bin/t3sm.mjs (+ entry.mjs), optional src/cli/main.ts and dist/cli/main.js. */
function layout(root: string, o: { src?: string; dist?: string }): string {
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(join(REPO, "bin", "t3sm.mjs"), join(root, "bin", "t3sm.mjs"));
  cpSync(join(REPO, "bin", "entry.mjs"), join(root, "bin", "entry.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const main = (body: string) => `export async function main(args, io) { io.stdout(${JSON.stringify(body)} + "\\n"); return 0; }\n`;
  if (o.src) { mkdirSync(join(root, "src", "cli"), { recursive: true }); writeFileSync(join(root, "src", "cli", "main.ts"), main(o.src)); }
  if (o.dist) { mkdirSync(join(root, "dist", "cli"), { recursive: true }); writeFileSync(join(root, "dist", "cli", "main.js"), main(o.dist)); }
  return join(root, "bin", "t3sm.mjs");
}

const run = (bin: string) => spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", timeout: 30_000 });

test("resolveEntry: a checkout (src present, not under node_modules) runs src even when a dist exists", () => {
  const bin = pathToFileURL("/work/t3sm/bin/t3sm.mjs");
  const all = () => true;
  assert.deepEqual(resolveEntry(bin, all), { kind: "src", url: new URL("../src/cli/main.ts", bin).href });
  const onlyDist = (u: URL) => u.href.endsWith("/dist/cli/main.js");
  assert.deepEqual(resolveEntry(bin, onlyDist), { kind: "dist", url: new URL("../dist/cli/main.js", bin).href });
  assert.deepEqual(resolveEntry(bin, () => false), { kind: "none" });
});

test("resolveEntry: an installed package (under node_modules) runs dist even when src is shipped", () => {
  const bin = pathToFileURL("/x/node_modules/t3code-session-manager/bin/t3sm.mjs");
  assert.deepEqual(resolveEntry(bin, () => true), { kind: "dist", url: new URL("../dist/cli/main.js", bin).href });
  assert.deepEqual(resolveEntry(bin, (u) => u.href.endsWith("/src/cli/main.ts")), { kind: "none" });
});

test("bin/t3sm.mjs: checkout with a stale dist runs src; dist only runs dist; neither says to build", () => {
  const root = mkdtempSync(join(tmpdir(), "t3sm-bin-"));
  try {
    const both = run(layout(join(root, "both"), { src: "from-src", dist: "from-dist" }));
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout.trim(), "from-src");
    const dist = run(layout(join(root, "dist-only"), { dist: "from-dist" }));
    assert.equal(dist.stdout.trim(), "from-dist");
    const installed = run(layout(join(root, "node_modules", "pkg"), { src: "from-src", dist: "from-dist" }));
    assert.equal(installed.stdout.trim(), "from-dist");
    const none = run(layout(join(root, "none"), {}));
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Run `npm run build`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
