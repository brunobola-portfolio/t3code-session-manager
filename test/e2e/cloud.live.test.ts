// Read-only, against the real service (spec 2026-11-26 §7): the user's own `claude` lists the default account's cloud
// sessions through its control requests. No transcript, no write, no model call (no tokens). Skips unless T3_E2E=1.
// Run with CLAUDE_CONFIG_DIR removed (the child must use ~/.claude, never an inherited account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudChildEnv, listCloudSessions, openCloud } from "../../src/cloud/client.ts";
import { isArchived, isCloudOnly } from "../../src/cloud/decode.ts";
import { findOnPath } from "../../src/ops/doctorDeps.ts";

test("live cloud: list the ~/.claude account's cloud sessions (T3_E2E=1)", { skip: process.env.T3_E2E !== "1", timeout: 180_000 }, async (t) => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "remove CLAUDE_CONFIG_DIR first");
  const bin = findOnPath("claude", process.platform, process.env.PATH ?? process.env.Path ?? "", process.env.PATHEXT);
  if (bin === null) { t.skip("claude is not on PATH"); return; }
  const home = homedir();
  const env = cloudChildEnv(process.env, join(home, ".claude"), home, process.platform);
  assert.equal(env["CLAUDE_CONFIG_DIR"], undefined, "~/.claude runs with CLAUDE_CONFIG_DIR unset");
  const t0 = Date.now();
  const conn = await openCloud({ bin, env });
  try {
    const rows = await listCloudSessions(conn);
    const cloudOnly = rows.filter(isCloudOnly);
    console.log(`live: rows=${rows.length} cloud=${cloudOnly.length} open=${cloudOnly.filter((s) => !isArchived(s)).length} in ${Date.now() - t0} ms`);
    for (const s of rows) assert.match(s.id, /^session_/);
  } finally {
    await conn.close();
  }
});
