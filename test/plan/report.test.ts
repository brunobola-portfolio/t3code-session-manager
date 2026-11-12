import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Plan, PlanItem, PlanNote, SkipReason } from "../../src/core/types.ts";
import { planWarnings, renderPlanMarkdown, renderTerminalSummary, summarize, NOTE_EXPLANATION, SKIP_EXPLANATION } from "../../src/plan/report.ts";
import { sess, uuid } from "./helpers.ts";

const ALL_REASONS: SkipReason[] = [
  "already-in-t3", "cwd-missing", "duplicate", "mirror-copy", "backup-copy", "active", "non-uuid-id", "no-session-id",
  "subagent", "only-hidden", "over-4gib", "no-cwd", "cwd-unreadable", "excluded", "harness-unavailable", "compare-failed",
];

function fixedPlan(): Plan {
  let n = 0;
  const items: PlanItem[] = [];
  const imp = (accountId: string, notes: PlanNote[] = [], harness: "claude" | "codex" = "claude"): void => {
    n++;
    items.push({
      session: sess({ harness, accountId: harness === "claude" ? accountId : null, nativeId: uuid(n) }),
      action: { kind: "import", projectRoot: "C:/work/demo", instanceId: accountId, expectedThreadId: `import:${accountId}:${uuid(n)}` },
      notes,
    });
  };
  imp("claudeAgent");
  imp("claude-org", ["diverged-fork"]);
  imp("claude-org", ["truncated-over-32mib", "continued-outside-t3"]);
  imp("claudeAgent", ["duplicate-in-window", "label-only-in-mirror"]);
  n++;
  items.push({
    session: sess({ harness: "pi", accountId: null, nativeId: uuid(900) }),
    action: { kind: "convert-import", projectRoot: "C:/work/demo", instanceId: "claude-org", expectedThreadId: "import:claude-org:x", uuid: uuid(901), targetFile: "C:/Users/demo/.claude-org/projects/C--work-demo/x.jsonl" },
    notes: [],
  });
  ALL_REASONS.forEach((reason, i) => {
    const count = reason === "already-in-t3" ? 22 : 1; // 22 exercises the "first 20" cut
    for (let k = 0; k < count; k++) {
      items.push({ session: sess({ nativeId: uuid(2000 + i * 100 + k), accountId: i % 2 ? "claude-org" : "claudeAgent" }), action: { kind: "skip", reason }, notes: [] });
    }
  });
  return {
    version: 1, runId: "20261111-120000-abcd", createdAt: "2026-11-11T12:00:00.000Z", t3Version: "0.0.30",
    instancesToCreate: [{ id: "claude-org", driver: "claudeAgent", displayName: "Claude · Org", accentColor: "#00AAFF", homePath: "C:/Users/demo/.claude-org", environment: [] }],
    projectsToCreate: [{ root: "C:/work/demo", title: "demo", defaultInstanceId: "claude-org" }],
    projectAccounts: [
      { root: "C:/work/demo", accountId: "claude-org", source: "vscode-pin" },
      { root: "C:/work/other|pipe", accountId: "claudeAgent", source: "recent-activity" },
    ],
    projectDefaults: [{ root: "C:/work/demo", instanceId: "claude-org" }],
    mirrorCopies: [
      { path: "C:/Users/demo/.claude/projects/C--work-demo/a.jsonl", nativeId: uuid(1), keptPath: "C:/Users/demo/.claude-org/projects/C--work-demo/a.jsonl", relation: "identical" },
      { path: "C:/Users/demo/.claude/projects/C--work-demo/b.jsonl", nativeId: uuid(2), keptPath: "C:/Users/demo/.claude-org/projects/C--work-demo/b.jsonl", relation: "prefix" },
    ],
    items,
    warnings: ["Project C:/work/old is archived in T3 Code and will be reused."],
  };
}

test("renderPlanMarkdown matches the committed snapshot", () => {
  const md = renderPlanMarkdown(fixedPlan());
  const snap = new URL("../fixtures/report/plan.md", import.meta.url);
  if (!existsSync(snap) || process.env["UPDATE_SNAPSHOT"] === "1") {
    mkdirSync(new URL(".", snap), { recursive: true });
    writeFileSync(snap, md);
  }
  assert.equal(md, readFileSync(snap, "utf8"));
});

test("markdown has every section in order and explains every skip reason", () => {
  const md = renderPlanMarkdown(fixedPlan());
  const heads = ["# t3sm plan", "## Summary", "## Accounts", "## Projects to create", "## Project accounts", "## Project defaults to set",
    "## Duplicates across accounts", "## Warnings", "## Skipped by reason", "## Residual limits"];
  let at = -1;
  for (const h of heads) {
    const p = md.indexOf(h);
    assert.ok(p > at, `${h} missing or out of order`);
    at = p;
  }
  for (const r of ALL_REASONS) {
    assert.ok(SKIP_EXPLANATION[r].length > 10);
    assert.ok(md.includes(`### ${r} (`), r);
  }
  assert.match(md, /and 2 more/);
  assert.match(md, /t3sm dedupe.*before.*t3sm apply/);
  assert.match(md, /t3sm quarantine/);
  assert.match(md, /C:\/work\/other\\\|pipe/);
});

test("summarize counts actions, reasons, harnesses, instances and notes", () => {
  const s = summarize(fixedPlan());
  assert.equal(s.byAction["import"], 4);
  assert.equal(s.byAction["convert-import"], 1);
  assert.equal(s.byReason["already-in-t3"], 22);
  assert.equal(s.byReason["compare-failed"], 1);
  assert.equal(s.byHarness.pi, 1);
  assert.equal(s.byHarness.opencode, 0);
  assert.equal(s.byInstance["claude-org"], 3);
  assert.equal(s.notes["diverged-fork"], 1);
  assert.equal(s.notes["remapped-cwd"], 0);
});

test("terminal summary is short, plain without colour, ends with path and next step", () => {
  const plain = renderTerminalSummary(fixedPlan(), { color: false, planPath: "X/plan.md" });
  assert.ok(plain.split("\n").length <= 26);
  assert.ok(!plain.includes("\x1b"));
  const lines = plain.trimEnd().split("\n");
  assert.equal(lines.at(-2), "Full report: X/plan.md");
  assert.match(lines.at(-1)!, /t3sm dedupe.*t3sm apply/);
  assert.ok(renderTerminalSummary(fixedPlan(), { color: true, planPath: "p" }).includes("\x1b["));
  const clean = fixedPlan();
  clean.mirrorCopies = [];
  assert.match(renderTerminalSummary(clean, { color: false, planPath: "p" }), /Next: t3sm apply\.\n$/);
});

test("hostile names, titles and warnings are escaped in the markdown", () => {
  const p = fixedPlan();
  const hostile = ["<img onerror=x>", "a*b*c", "[x](y)", "a|b", "_u_ & <b>"];
  p.instancesToCreate = hostile.map((h, i) => ({ id: `h${i}`, driver: "claudeAgent" as const, displayName: h, accentColor: null, homePath: "C:/h", environment: [] }));
  p.projectsToCreate = hostile.map((h) => ({ root: "C:/work/demo", title: h, defaultInstanceId: null }));
  p.warnings = hostile;
  const md = renderPlanMarkdown(p, { names: { "claude-org": "[x](y)" } });
  assert.ok(!md.includes("<img"), "raw tag survives");
  assert.ok(!md.includes("<b>"));
  assert.ok(md.includes("&lt;img onerror=x&gt;"));
  assert.ok(md.includes("a\\*b\\*c"));
  assert.ok(md.includes("\\[x\\](y)"));
  assert.ok(md.includes("a\\|b"));
  assert.ok(!md.replaceAll("\\[", "").includes("[x]"), "unescaped link text");
  // table rows keep their column count despite the pipe
  for (const line of md.split("\n").filter((l) => l.startsWith("| a\\|b"))) assert.ok(line.endsWith("|"));
});

test("compressed Codex sessions are explained in the skip section", () => {
  const p = fixedPlan();
  p.items.push({ session: sess({ harness: "codex", accountId: null, cwd: null, flags: ["compressed"] }), action: { kind: "skip", reason: "compressed" }, notes: [] });
  const md = renderPlanMarkdown(p);
  assert.match(md, /### compressed \(1\)\n\nCodex compressed this session and converting compressed sessions is off \(`codex\.convertCompressed: false` in config\.json\)\.\n/);
});

test("in-t3-as-other-form: plan.md says which form T3 already holds (a Codex thread, or a converted Claude thread)", () => {
  const p = fixedPlan();
  const conv = { ...sess({ harness: "codex", accountId: null, nativeId: uuid(7101), flags: ["compressed"] }), mode: "convert" as const };
  const plain = sess({ harness: "codex", accountId: null, nativeId: uuid(7102) });
  for (const s of [conv, plain]) p.items.push({ session: s, action: { kind: "skip", reason: "already-in-t3" }, notes: ["in-t3-as-other-form"] });
  const md = renderPlanMarkdown(p);
  assert.match(md, new RegExp(`${uuid(7101)}\`? already in T3 Code as a Codex thread`));
  assert.match(md, new RegExp(`${uuid(7102)}\`? already in T3 Code as a converted Claude thread`));
  assert.equal(NOTE_EXPLANATION["in-t3-as-other-form"], "already in T3 Code in its other form (a Codex thread, or a converted Claude thread); not imported a second time");
});

test("continued-outside-t3: only Claude sessions are pointed at `t3sm merge`; Codex ones get their own wording", () => {
  const base = fixedPlan(); // one Claude session carries continued-outside-t3
  const claudeLine = /1 session continued outside T3 Code after import\. The imported thread is stale; `t3sm merge` creates/;
  const cx = (n: number) => ({ session: sess({ harness: "codex", accountId: null, nativeId: uuid(n) }), action: { kind: "skip" as const, reason: "already-in-t3" as const }, notes: ["continued-outside-t3" as const] });
  const p = fixedPlan();
  p.items.push(cx(7201), cx(7202));
  const w = planWarnings(p).join("\n");
  assert.match(w, claudeLine);
  assert.ok(w.includes("2 Codex sessions changed since they were imported; t3sm cannot merge Codex sessions yet — continue them in Codex or in their T3 Code thread."), w);
  const one = fixedPlan();
  one.items = one.items.filter((i) => !i.notes.includes("continued-outside-t3"));
  one.items.push(cx(7203));
  const w1 = planWarnings(one).join("\n");
  assert.ok(w1.includes("1 Codex session changed since it was imported; t3sm cannot merge Codex sessions yet — continue it in Codex or in its T3 Code thread."), w1);
  assert.ok(!w1.includes("t3sm merge"), "no merge advice when no Claude session continued");
  assert.match(planWarnings(base).join("\n"), claudeLine);
});

test("a second rollout file for one Codex session is explained under duplicate", () => {
  const p = fixedPlan();
  p.items.push({ session: { ...sess({ harness: "codex", accountId: null, flags: ["compressed", "duplicate-file"] }), mode: "convert" }, action: { kind: "skip", reason: "duplicate" }, notes: [] });
  const md = renderPlanMarkdown(p);
  assert.match(md, /### duplicate \(2\)\n\n[^\n]+\n\nCodex: a second rollout file for the same Codex session \(for example a sub-agent copy\); the other file is the one planned\.\n/);
  assert.ok(!renderPlanMarkdown(fixedPlan()).includes("Codex: a second rollout"), "only when a Codex session is skipped for it");
});

test("compressed Codex sessions converted by this plan get one Summary line in plan.md and the terminal summary; too-large is explained", () => {
  const p = fixedPlan();
  const zst = (n: number) => ({ ...sess({ harness: "codex", accountId: null, nativeId: uuid(n), flags: ["compressed"] }), mode: "convert" as const });
  for (const n of [7001, 7002]) {
    p.items.push({ session: zst(n), action: { kind: "convert-import", projectRoot: "C:/work/demo", instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${uuid(n)}`, uuid: uuid(n), targetFile: `C:/Users/demo/.claude/projects/C--work-demo/${uuid(n)}.jsonl` }, notes: [] });
  }
  p.items.push({ session: zst(7003), action: { kind: "skip", reason: "already-in-t3" }, notes: [] }); // converted earlier: not counted
  p.items.push({ session: { ...zst(7004), flags: ["compressed", "too-large"] }, action: { kind: "skip", reason: "too-large" }, notes: [] });
  const md = renderPlanMarkdown(p);
  const line = "2 Codex sessions were compressed by Codex; they are converted and continue as Claude threads.";
  assert.ok(md.slice(md.indexOf("## Summary"), md.indexOf("## Accounts")).includes(line), md.slice(0, 1500));
  assert.ok(renderTerminalSummary(p, { color: false, planPath: "p" }).includes(line));
  assert.match(md, /### too-large \(1\)\n\nLarger than 512 MiB once decompressed, too big to convert\.\n/);
  assert.equal(SKIP_EXPLANATION["too-large"], "larger than 512 MiB once decompressed, too big to convert");
  // None converted: no line.
  assert.ok(!renderPlanMarkdown(fixedPlan()).includes("were compressed by Codex"));
});

test("terminal Warnings count equals the warning lines in plan.md (plan warnings plus generated hints)", () => {
  const warningLines = (md: string): number => {
    const sec = md.slice(md.indexOf("## Warnings"), md.indexOf("## Skipped by reason"));
    return sec.split("\n").filter((l) => l.startsWith("- ")).length;
  };
  const shown = (p: Plan): number => Number(/^\s+Warnings\s+(\d+)$/m.exec(renderTerminalSummary(p, { color: false, planPath: "p" }))![1]);
  const p = fixedPlan(); // mirror copies, a backup copy, continued/truncated/duplicate notes and one plan warning
  assert.equal(warningLines(renderPlanMarkdown(p)), 6);
  assert.equal(shown(p), 6);
  assert.deepEqual(planWarnings(p).length, 6);
  const quiet = fixedPlan();
  quiet.mirrorCopies = [];
  quiet.warnings = [];
  quiet.items = quiet.items.filter((i) => i.notes.length === 0 && !(i.action.kind === "skip" && i.action.reason === "backup-copy"));
  assert.equal(warningLines(renderPlanMarkdown(quiet)), 0);
  assert.equal(shown(quiet), 0);
});

test("remapped-cwd is described and warned about", () => {
  const p = fixedPlan();
  p.items[0]!.notes.push("remapped-cwd");
  assert.match(renderPlanMarkdown(p), /1 session with a working directory remapped by a `remap` rule/);
});

test("the report tolerates a hand-made or older plan whose sessions carry no flags (scripts/build-assets.js)", async () => {
  const { renderTerminalSummary, renderPlanMarkdown } = await import("../../src/plan/report.ts");
  const p = { version: 1, runId: "r", createdAt: "2026-11-11T00:00:00Z", t3Version: "x", instancesToCreate: [], projectsToCreate: [], projectAccounts: [], projectDefaults: [], mirrorCopies: [], warnings: [],
    items: [{ session: { harness: "claude", nativeId: "n", accountId: "a", cwd: "C:/w", file: { path: "C:/w/n.jsonl" } }, action: { kind: "skip", reason: "active" }, notes: [] }] } as never;
  assert.doesNotThrow(() => renderTerminalSummary(p, { color: false, planPath: "plan.md" }));
  assert.doesNotThrow(() => renderPlanMarkdown(p));
});
