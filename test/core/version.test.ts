import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installChangedAt, installRoot, installStamp, packageVersion } from "../../src/core/version.ts";

function root(t: { after(fn: () => void): void }, parts: string[] = []): string {
  const base = mkdtempSync(join(tmpdir(), "t3sm-version-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const r = join(base, ...parts);
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, "package.json"), JSON.stringify({ name: "t3code-session-manager", version: "0.3.0" }));
  return r;
}

test("installStamp: a checkout (src/ next to bin/, outside node_modules) is stamped by package.json's mtime", (t) => {
  const r = root(t);
  mkdirSync(join(r, "src", "cli"), { recursive: true });
  writeFileSync(join(r, "src", "cli", "main.ts"), "");
  const s = installStamp(r);
  assert.deepEqual(s, { version: "0.3.0", stamp: `checkout:${statSync(join(r, "package.json")).mtimeMs}` });
});

test("installStamp: an installed package (under node_modules) is stamped by dist/build.json's builtAt; the version comes from package.json", (t) => {
  const r = root(t, ["node_modules", "t3code-session-manager"]);
  mkdirSync(join(r, "src", "cli"), { recursive: true });
  writeFileSync(join(r, "src", "cli", "main.ts"), ""); // ignored: under node_modules the package runs dist/
  mkdirSync(join(r, "dist"), { recursive: true });
  writeFileSync(join(r, "dist", "build.json"), JSON.stringify({ version: "0.2.9", builtAt: "2026-11-15T10:00:00.000Z" }));
  assert.deepEqual(installStamp(r), { version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" });
  const at = installChangedAt(r);
  assert.equal(typeof at, "number");
  assert.ok(at! >= statSync(join(r, "dist", "build.json")).mtimeMs);
});

test("installStamp: a dist/ without build.json, or a missing package.json, throws (the watcher then never restarts)", (t) => {
  const r = root(t, ["node_modules", "t3code-session-manager"]);
  mkdirSync(join(r, "dist"), { recursive: true });
  assert.throws(() => installStamp(r));
  writeFileSync(join(r, "dist", "build.json"), JSON.stringify({ version: "0.3.0" }));
  assert.throws(() => installStamp(r), /builtAt/);
  assert.throws(() => installStamp(join(r, "nope")));
  assert.equal(installChangedAt(join(r, "nope")), null);
});

test("installRoot and packageVersion describe this checkout", () => {
  const s = installStamp(installRoot());
  assert.equal(s.version, packageVersion());
  assert.match(s.stamp, /^checkout:\d/);
});

test("installReady: the bin and (installed) dist/cli/main.js exist, and the stamp file changed at least 30 s ago", async (t) => {
  const { installReady } = await import("../../src/core/version.ts");
  const r = root(t, ["node_modules", "t3code-session-manager"]);
  mkdirSync(join(r, "dist", "cli"), { recursive: true });
  writeFileSync(join(r, "dist", "build.json"), JSON.stringify({ version: "0.3.0", builtAt: "2026-11-15T10:00:00.000Z" }));
  const changed = installChangedAt(r)!;
  assert.equal(installReady(r, changed + 60_000), false, "no bin, no dist/cli/main.js");
  mkdirSync(join(r, "bin"), { recursive: true });
  writeFileSync(join(r, "bin", "t3sm.mjs"), "");
  assert.equal(installReady(r, changed + 60_000), false, "no dist/cli/main.js");
  writeFileSync(join(r, "dist", "cli", "main.js"), "");
  assert.equal(installReady(r, changed + 60_000), true);
  assert.equal(installReady(r, changed + 29_000), false, "changed less than 30 s ago");
  assert.equal(installReady(join(r, "gone"), changed + 60_000), false);
  const c = root(t);
  mkdirSync(join(c, "src", "cli"), { recursive: true });
  writeFileSync(join(c, "src", "cli", "main.ts"), "");
  mkdirSync(join(c, "bin"), { recursive: true });
  writeFileSync(join(c, "bin", "t3sm.mjs"), "");
  assert.equal(installReady(c, installChangedAt(c)! + 30_000), true, "a checkout needs no dist/");
});
