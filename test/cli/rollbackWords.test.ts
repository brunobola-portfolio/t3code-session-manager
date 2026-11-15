// What rollback kept or skipped, and why, in the user's language: the engine's reasons are English (--json); the
// screen words each known one from the catalogue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderRollback, rollbackWhy } from "../../src/cli/commands/rollback.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import type { RollbackReport } from "../../src/ops/rollback.ts";

const ui = (lang: "en" | "pt") => makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 200 }, lang);

/**
 * Every reason the engine (src/ops/rollback.ts) can give, read from its source: the string and template literals on the
 * lines that set a reason (a kept merge, a skipped default, a failed move back, a thread left for review, the T3 part),
 * each `${...}` filled with a sample value. A new reason there without words here fails this test.
 */
function engineReasons(): string[] {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "ops", "rollback.ts"), "utf8");
  const setsReason = /t3Unavailable\s*(\?\?)?=|kept\.set\(|reason: |needsReview\(|left active|KeptReason =/;
  const out = new Set<string>();
  for (const line of src.split("\n")) {
    if (!setsReason.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
    for (const m of line.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)) {
      const lit = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, "R2");
      // Not a reason: an empty string or a code-like value (a JSON key, the journal kind).
      if (lit.length < 8 || !/ /.test(lit)) continue;
      out.add(lit);
    }
  }
  return [...out];
}
const REASONS = [...engineReasons(), "changed since (now none)"];

test("the engine's reasons are found in its source (the list below is not empty or stale)", () => {
  assert.ok(REASONS.length >= 15, REASONS.join("\n"));
  for (const known of ["revision continued", "project no longer exists in T3 Code", "could not read T3 projects (R2)", "left active: its original thread R2 could not be unarchived"]) {
    assert.ok(REASONS.includes(known), `${known} not found in src/ops/rollback.ts:\n${REASONS.join("\n")}`);
  }
});

test("rollbackWhy: every reason the engine gives has words in both languages; an unknown one stays as it is", () => {
  for (const r of REASONS) {
    const pt = rollbackWhy(ui("pt"), r);
    assert.notEqual(pt, r, `no Portuguese for: ${r}`);
    assert.doesNotMatch(pt, /\b(revision|continued|rewritten|unreachable|followed|connected|running|reachable|project|changed|since|failed|left active|session's)\b/, pt);
    assert.ok(rollbackWhy(ui("en"), r).length > 0);
  }
  assert.match(rollbackWhy(ui("pt"), "followed again by run R2; roll back R2 first"), /R2/);
  assert.match(rollbackWhy(ui("pt"), "changed since (now claude-work)"), /claude-work/);
  assert.match(rollbackWhy(ui("pt"), "T3 Code not reachable (ECONNRESET)"), /ECONNRESET/);
  assert.equal(rollbackWhy(ui("pt"), "something new"), "something new");
});

test("rollback in Portuguese: kept merges, skipped defaults, threads left for review and the T3 part are worded", () => {
  const r = {
    runId: null, targetRunId: "R1", command: "merge", filesRemoved: [], filesKeptModified: [], filesKeptActive: [], foldersRemoved: [], foldersKept: [],
    filesKeptRewritten: [], filesKeptRefreshed: [], unquarantined: [], unquarantineConflicts: [], alreadyRestored: [], unquarantineMissing: [],
    unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [{ projectId: "p1", reason: "project no longer exists in T3 Code" }],
    instanceChanges: [], instancesCreated: [], projectsCreated: [], threadsToReview: [], threadsVerified: true, threadsArchived: [], parkedThreads: [],
    threadsUnarchived: [], mergesKept: [{ nativeId: "s1", revisionFile: "C:/work/demo/r.jsonl", reason: "revision continued" }],
    needsReview: [{ threadId: "t1", reason: "left active: it is the session's only active thread (its original thread is archived and could not be brought back)" }],
    organize: [], t3Unavailable: "T3 Code not running", errors: [],
  } as unknown as RollbackReport;
  const out = renderRollback(ui("pt"), r, true, { changes: new Map(), names: { threads: new Map(), projects: new Map() } as never }).join("\n");
  assert.match(out, /p1: o projeto já não existe no T3 Code/);
  assert.match(out, /s1: a revisão foi continuada depois/);
  assert.match(out, /t1: fica ativa: é a única thread ativa da sessão/);
  assert.match(out, /o T3 Code não está a correr/);
  assert.doesNotMatch(out, /no longer exists|revision continued|left active|not running/);
});

test("rollback: the T3 part's reason and every worded reason show the home folder as ~", () => {
  const home = "C:/Users/demo";
  const r = {
    runId: null, targetRunId: "R1", command: "apply", filesRemoved: [], filesKeptModified: [], filesKeptActive: [], foldersRemoved: [], foldersKept: [],
    filesKeptRewritten: [], filesKeptRefreshed: [], unquarantined: [], unquarantineConflicts: [], alreadyRestored: [], unquarantineMissing: [],
    unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [{ projectId: "p1", reason: `failed: EPERM ${home}/.t3/state.json` }],
    instanceChanges: [], instancesCreated: [], projectsCreated: [], threadsToReview: [], threadsVerified: true, threadsArchived: [], parkedThreads: [],
    threadsUnarchived: [], mergesKept: [], needsReview: [], organize: [], t3Unavailable: `T3 Code not reachable (EACCES ${home}/.t3/runtime.json)`, errors: [],
  } as unknown as RollbackReport;
  for (const lang of ["en", "pt"] as const) {
    const out = renderRollback(ui(lang), r, true, { changes: new Map(), names: {} as never }, 200, home).join("\n");
    assert.match(out, /~\/\.t3\/runtime\.json/, lang);
    assert.match(out, /~\/\.t3\/state\.json/, lang);
    assert.doesNotMatch(out, /Users\/demo/, lang);
  }
});

test("rollback: an instance change shows an email-shaped display name masked (previous, next and the note)", () => {
  const r = {
    runId: null, targetRunId: "R1", command: "accounts", filesRemoved: [], filesKeptModified: [], filesKeptActive: [], foldersRemoved: [], foldersKept: [],
    filesKeptRewritten: [], filesKeptRefreshed: [], unquarantined: [], unquarantineConflicts: [], alreadyRestored: [], unquarantineMissing: [],
    unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [],
    instanceChanges: [{ instanceId: "org", kind: "updated", previous: { displayName: "olduser@example.com", accentColor: null }, next: { displayName: "Org" }, status: "changed-since", note: 'now "newuser@example.com" no colour' }],
    instancesCreated: [], projectsCreated: [], threadsToReview: [], threadsVerified: true, threadsArchived: [], parkedThreads: [],
    threadsUnarchived: [], mergesKept: [], needsReview: [], organize: [], t3Unavailable: null, errors: [],
  } as unknown as RollbackReport;
  const out = renderRollback(ui("en"), r, true, { changes: new Map(), names: {} as never }, 200).join("\n");
  assert.match(out, /o\*\*\*@example\.com/);
  assert.match(out, /n\*\*\*@example\.com/);
  assert.doesNotMatch(out, /olduser|newuser/);
});
