import type { Action, HarnessId, Plan, PlanItem, PlanNote, SkipReason } from "../core/types.ts";

const HARNESSES: readonly HarnessId[] = ["claude", "codex", "pi", "opencode"];

/** Human wording for every skip reason (what happened, and whether it is the user's to fix). */
export const SKIP_EXPLANATION: Record<SkipReason, string> = {
  "already-in-t3": "already imported into T3 Code",
  "cwd-missing": "the project folder no longer exists on disk",
  "duplicate": "same session kept under another path (case variant); the other copy is imported",
  "mirror-copy": "an identical or shorter mirror of a session kept in another account",
  "backup-copy": "lives in a .bak backup folder",
  "active": "modified in the last 10 minutes, so it may be in use; try again later",
  "non-uuid-id": "the session id is not a UUID, which T3 Code cannot import",
  "no-session-id": "the transcript carries no session id",
  "subagent": "a sub-agent transcript, shown inside its parent session",
  "compressed": "Codex compressed this session and converting compressed sessions is off (`codex.convertCompressed: false` in config.json)",
  "too-large": "larger than 512 MiB once decompressed, too big to convert",
  "only-hidden": "holds only hidden or system records, nothing to show",
  "over-4gib": "larger than 4 GiB, too big to import",
  "no-cwd": "no working directory recorded, so the project is unknown",
  "cwd-unreadable": "the working directory could not be read from the transcript",
  "excluded": "matches an `exclude` pattern in config.json",
  "harness-unavailable": "no T3 Code provider instance exists for this harness",
  "compare-failed": "could not compare it with its duplicate (file busy); it will be retried on the next plan",
  "converted": "a transcript t3sm converted from another agent's session; imported through that session",
  "revision": "a merge revision t3sm wrote that was never merged; `t3sm merge` reuses or removes it",
};

/** Human wording for every plan note; a new PlanNote breaks compilation until it is described here. */
export const NOTE_EXPLANATION: Record<PlanNote, string> = {
  "duplicate-in-window": "has a duplicate inside the activity window",
  "diverged-fork": "diverged from a copy in another account; both histories are kept",
  "label-only-in-mirror": "its title or tag lives only in a discarded mirror copy",
  "truncated-over-32mib": "larger than 32 MiB; T3 Code reads only the first 32 MiB",
  "continued-outside-t3": "continued outside T3 Code after it was imported",
  "remapped-cwd": "its working directory was remapped by a `remap` rule in config.json",
  "in-t3-under-other-account": "already in T3 Code under another account; not imported a second time",
  "in-t3-as-other-form": "already in T3 Code in its other form (a Codex thread, or a converted Claude thread); not imported a second time",
};

/** Per-harness detail for a skip reason, shown under that reason when the plan skips sessions of that harness for it. */
export const SKIP_DETAIL: Partial<Record<SkipReason, Partial<Record<HarnessId, string>>>> = {
  "duplicate": { codex: "a second rollout file for the same Codex session (for example a sub-agent copy); the other file is the one planned" },
};
const HARNESS_NAME: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

export const SKIP_REASONS = Object.keys(SKIP_EXPLANATION) as SkipReason[];
const NOTES = Object.keys(NOTE_EXPLANATION) as PlanNote[];

export interface PlanSummary {
  byAction: Record<string, number>;
  byReason: Record<SkipReason, number>;
  byHarness: Record<HarnessId, number>;
  byInstance: Record<string, number>;
  notes: Record<PlanNote, number>;
}

function zero<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export function summarize(plan: Plan): PlanSummary {
  const s: PlanSummary = {
    byAction: { import: 0, "convert-import": 0, skip: 0 },
    byReason: zero(SKIP_REASONS), byHarness: zero(HARNESSES), byInstance: {}, notes: zero(NOTES),
  };
  for (const it of plan.items) {
    s.byAction[it.action.kind] = (s.byAction[it.action.kind] ?? 0) + 1;
    s.byHarness[it.session.harness]++;
    if (it.action.kind === "skip") s.byReason[it.action.reason]++;
    else s.byInstance[it.action.instanceId] = (s.byInstance[it.action.instanceId] ?? 0) + 1;
    for (const n of it.notes) s.notes[n]++;
  }
  return s;
}

export interface RenderOptions {
  /** accountId / instanceId -> display name (config accounts, T3 instances). Falls back to plan.instancesToCreate, then the id. */
  names?: Record<string, string>;
  /** Max sessions listed per skip reason. */
  listLimit?: number;
}

/** Escapes markdown/HTML metacharacters in untrusted text (names, titles, warnings). */
const esc = (s: string): string =>
  s.replace(/[\\<>&*_[\]`|]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : `\\${c}`)).replace(/\r?\n/g, " ");
/** A table cell: a whole-cell code span only needs the pipe escaped; anything else is fully escaped. */
const cell = (s: string): string => (/^`[^`]*`$/.test(s) ? s.replace(/\|/g, "\\|") : esc(s));
const code = (s: string): string => "`" + s.replace(/`/g, "'") + "`";

function table(head: string[], rows: string[][], numeric = true): string[] {
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map((_, i) => (numeric && i > 0 ? " ---: " : " --- ")).join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

const pl = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const sessions = (n: number): string => pl(n, "session", "sessions");

/**
 * The plan's line about Codex compressed sessions it converts (convert-import items flagged `compressed`), or null when
 * there are none: T3 Code cannot read them, so they continue as Claude threads, not Codex ones.
 */
export function compressedCodexLine(plan: Plan): string | null {
  const n = plan.items.filter((i) => i.action.kind === "convert-import" && i.session.harness === "codex" && i.session.flags?.includes("compressed")).length;
  if (n === 0) return null;
  return n === 1
    ? "1 Codex session was compressed by Codex; it is converted and continues as a Claude thread."
    : `${n} Codex sessions were compressed by Codex; they are converted and continue as Claude threads.`;
}

const KIND_LABEL: Record<Action["kind"], string> = { import: "Import as is", "convert-import": "Convert, then import", skip: "Skip" };

/**
 * Every warning plan.md lists (markdown, escaped): the planner's own warnings, then the hints derived from the plan
 * (mirror copies, backup copies, continued outside T3 Code, truncated, remapped, duplicates in the window). The
 * terminal summary counts this same list, so both always agree.
 */
export function planWarnings(plan: Plan, sum: PlanSummary = summarize(plan)): string[] {
  const warn = plan.warnings.map(esc);
  if (plan.mirrorCopies.length > 0) warn.push(`${pl(plan.mirrorCopies.length, "mirror copy", "mirror copies")} present. Run ${code("t3sm dedupe")} before ${code("t3sm apply")} so T3 cannot import stale copies under the wrong account.`);
  if (sum.byReason["backup-copy"] > 0) warn.push(`${sessions(sum.byReason["backup-copy"])} in .bak folders: ${code("t3sm quarantine")} moves them aside, reversibly.`);
  // `t3sm merge` handles Claude sessions only; other harnesses get their own line each.
  const continued = plan.items.filter((i) => i.notes?.includes("continued-outside-t3"));
  const claudeContinued = continued.filter((i) => i.session.harness === "claude").length;
  if (claudeContinued > 0) warn.push(`${sessions(claudeContinued)} continued outside T3 Code after import. The imported thread is stale; ${code("t3sm merge")} creates a revision thread with the new messages and archives the old one.`);
  for (const h of HARNESSES.filter((x) => x !== "claude")) {
    const n = continued.filter((i) => i.session.harness === h).length;
    if (n === 0) continue;
    const name = HARNESS_NAME[h];
    warn.push(n === 1
      ? `1 ${name} session changed since it was imported; t3sm cannot merge ${name} sessions yet — continue it in ${name} or in its T3 Code thread.`
      : `${n} ${name} sessions changed since they were imported; t3sm cannot merge ${name} sessions yet — continue them in ${name} or in their T3 Code thread.`);
  }
  if (sum.notes["truncated-over-32mib"] > 0) warn.push(`${sessions(sum.notes["truncated-over-32mib"])} larger than 32 MiB; T3 Code reads only the first 32 MiB of each.`);
  if (sum.notes["remapped-cwd"] > 0) warn.push(`${sessions(sum.notes["remapped-cwd"])} with a working directory remapped by a ${code("remap")} rule in config.json; check the Project accounts table.`);
  const elsewhere = plan.items.filter((i) => i.notes?.includes("in-t3-under-other-account"));
  if (elsewhere.length > 0) {
    const ex = elsewhere.slice(0, 10).map((i) => `${code(i.session.nativeId)} (${i.session.accountId ?? i.session.harness})`).join(", ");
    warn.push(`${sessions(elsewhere.length)} already in T3 Code under another account, so not imported again: ${ex}${elsewhere.length > 10 ? ", ..." : ""}. If that account is wrong, archive that thread in T3 Code and run ${code("t3sm plan")} again.`);
  }
  const otherForm = plan.items.filter((i) => i.notes?.includes("in-t3-as-other-form"));
  if (otherForm.length > 0) {
    // A converted (compressed) session's other form is its Codex thread; a native one's is its converted Claude thread.
    const ex = otherForm.slice(0, 10).map((i) => `${code(i.session.nativeId)} already in T3 Code as ${i.session.mode === "convert" ? "a Codex thread" : "a converted Claude thread"}`).join(", ");
    warn.push(`${sessions(otherForm.length)} already in T3 Code in another form, so not imported a second time: ${ex}${otherForm.length > 10 ? ", ..." : ""}.`);
  }
  const mismatch = plan.items.filter((i) => i.session.flags?.includes("id-mismatch")); // a hand-made or older plan may lack flags
  if (mismatch.length > 0) {
    const ex = mismatch.slice(0, 5).map((i) => `${code(i.session.nativeId)} in ${code(i.session.file.path)}`).join(", ");
    warn.push(`${sessions(mismatch.length)} whose file name differs from the session id inside; T3 Code imports each under the id inside (${ex}${mismatch.length > 5 ? ", ..." : ""}).`);
  }
  if (sum.notes["duplicate-in-window"] > 0) warn.push(`${sessions(sum.notes["duplicate-in-window"])} with a duplicate inside the activity window.`);
  return warn;
}

export function renderPlanMarkdown(plan: Plan, opts: RenderOptions = {}): string {
  const limit = opts.listLimit ?? 20;
  const names: Record<string, string> = { ...Object.fromEntries(plan.instancesToCreate.map((i) => [i.id, i.displayName])), ...opts.names };
  const nm = (id: string | null): string => (id === null ? "(none)" : names[id] !== undefined ? `${names[id]} (${id})` : id);
  const sum = summarize(plan);
  const L: string[] = [];

  L.push(`# t3sm plan ${plan.runId}`, "", `Generated ${plan.createdAt} for T3 Code ${plan.t3Version}. Nothing has been written yet: review this, then run ${code("t3sm apply")}.`, "");

  L.push("## Summary", "");
  L.push(...table(["Action", "Sessions"], (Object.keys(KIND_LABEL) as Action["kind"][]).map((k) => [KIND_LABEL[k], String(sum.byAction[k] ?? 0)])), "");
  const owner = (i: PlanItem): string => (i.action.kind === "skip" ? (i.session.accountId ?? "(no account)") : i.action.instanceId);
  const accountIds = [...new Set(plan.items.map(owner))].sort();
  const perAcct = accountIds.map((id) => {
    const mine = plan.items.filter((i) => owner(i) === id);
    const c = (k: Action["kind"]) => mine.filter((i) => i.action.kind === k).length;
    return [id === "(no account)" ? id : nm(id), String(c("import")), String(c("convert-import")), String(c("skip"))];
  });
  L.push(...table(["Account / instance", "Import", "Convert", "Skip"], perAcct), "");
  L.push(...table(["Harness", "Sessions"], HARNESSES.filter((h) => sum.byHarness[h] > 0).map((h) => [h, String(sum.byHarness[h])])), "");
  const zst = compressedCodexLine(plan);
  if (zst !== null) L.push(zst, "");

  L.push("## Accounts", "");
  if (plan.instancesToCreate.length === 0) L.push("No instances to create.", "");
  else L.push(...table(["Instance id", "Name", "Home"], plan.instancesToCreate.map((i) => [code(i.id), i.displayName, code(i.homePath)]), false), "");
  if (plan.pinDefault) {
    L.push(`T3 Code's default Claude instance ${code(plan.pinDefault.instanceId)} has no explicit home: \`t3sm apply\` pins it to ${code(plan.pinDefault.homePath)}, so a T3 Code started with CLAUDE_CONFIG_DIR set cannot move it.`, "");
  }

  L.push(`## Projects to create (${plan.projectsToCreate.length})`, "");
  if (plan.projectsToCreate.length === 0) L.push("None.", "");
  else {
    const acct = new Map(plan.projectAccounts.map((p) => [p.root, p]));
    L.push(...table(["Project", "Root", "Account", "Source"], plan.projectsToCreate.map((p) => {
      const a = acct.get(p.root);
      return [p.title, code(p.root), nm(a?.accountId ?? p.defaultInstanceId), a?.source ?? "-"];
    }), false), "");
  }

  L.push("## Project accounts", "", "Which subscription each project opens by default. Review this table: it decides where new threads in T3 Code start.", "");
  if (plan.projectAccounts.length === 0) L.push("None.", "");
  else L.push(...table(["Project root", "Account", "Source"], plan.projectAccounts.map((p) => [code(p.root), nm(p.accountId), p.source]), false), "");

  L.push("## Project defaults to set", "");
  if (plan.projectDefaults.length === 0) L.push("None.", "");
  else L.push(...table(["Project root", "Default instance"], plan.projectDefaults.map((p) => [code(p.root), nm(p.instanceId)]), false), "");

  L.push("## Duplicates across accounts", "");
  const rel = (r: "identical" | "prefix") => plan.mirrorCopies.filter((m) => m.relation === r).length;
  L.push(...table(["Relation", "Copies"], [
    ["identical (mirror)", String(rel("identical"))],
    ["prefix (shorter mirror)", String(rel("prefix"))],
    ["case-variant (same session, other path case)", String(sum.byReason.duplicate)],
    ["backup (.bak folders)", String(sum.byReason["backup-copy"])],
  ]), "");
  const forks = plan.items.filter((i) => i.notes.includes("diverged-fork"));
  L.push(`Diverged forks (both histories are kept and imported): ${forks.length}`, "");
  for (const f of forks) L.push(`- ${code(f.session.nativeId)} (${f.session.harness}, ${f.session.accountId ?? "no account"})`);
  if (forks.length) L.push("");
  const labels = plan.items.filter((i) => i.notes.includes("label-only-in-mirror"));
  L.push(`Label only in a mirror copy (the title or tag lives in the discarded copy): ${labels.length}`, "");
  for (const f of labels) L.push(`- ${code(f.session.nativeId)} (${f.session.harness}, ${f.session.accountId ?? "no account"})`);
  if (labels.length) L.push("");

  L.push("## Warnings", "");
  const warn = planWarnings(plan, sum);
  if (warn.length === 0) L.push("None.", "");
  else L.push(...warn.map((w) => `- ${w}`), "");

  L.push("## Skipped by reason", "");
  const skips = plan.items.filter((i): i is PlanItem & { action: { kind: "skip"; reason: SkipReason } } => i.action.kind === "skip");
  const shown = SKIP_REASONS.filter((r) => sum.byReason[r] > 0);
  if (shown.length === 0) L.push("Nothing skipped.", "");
  else {
    L.push(...table(["Reason", "Sessions"], shown.map((r) => [r, String(sum.byReason[r])])), "");
    for (const r of shown) {
      const mine = skips.filter((i) => i.action.reason === r);
      const ex = SKIP_EXPLANATION[r];
      L.push(`### ${r} (${mine.length})`, "", `${ex[0]!.toUpperCase()}${ex.slice(1)}.`, "");
      for (const [h, detail] of Object.entries(SKIP_DETAIL[r] ?? {}) as [HarnessId, string][]) {
        if (mine.some((i) => i.session.harness === h)) L.push(`${HARNESS_NAME[h]}: ${detail}.`, "");
      }
      for (const i of mine.slice(0, limit)) L.push(`- ${code(i.session.nativeId)} · ${i.session.harness} · ${i.session.accountId ?? "no account"}${i.session.cwd ? ` · ${code(i.session.cwd)}` : ""}`);
      if (mine.length > limit) L.push(`- ... and ${mine.length - limit} more (see plan.json)`);
      L.push("");
    }
  }

  L.push("## Residual limits", "",
    "- T3 Code shows at most 200 visible messages per imported thread.",
    "- Tool activity (commands, file edits) is not part of the imported timeline, only the conversation text.",
    "- Imported threads show the import time as their last activity.", "");
  return L.join("\n");
}

/** Compact terminal summary (about 20 lines, aligned, optional minimal ANSI). */
export function renderTerminalSummary(plan: Plan, opts: { color: boolean; planPath: string; names?: Record<string, string> }): string {
  const sum = summarize(plan);
  const b = (s: string) => (opts.color ? `\x1b[1m${s}\x1b[0m` : s);
  const d = (s: string) => (opts.color ? `\x1b[2m${s}\x1b[0m` : s);
  const names = { ...Object.fromEntries(plan.instancesToCreate.map((i) => [i.id, i.displayName])), ...opts.names };
  const rows: [string, string][] = [
    ["Import", String(sum.byAction.import ?? 0)],
    ["Convert + import", String(sum.byAction["convert-import"] ?? 0)],
    ["Skip", String(sum.byAction.skip ?? 0)],
    ["New instances", String(plan.instancesToCreate.length)],
    ["New projects", String(plan.projectsToCreate.length)],
    ["Mirror copies", String(plan.mirrorCopies.length)],
    ["Warnings", String(planWarnings(plan, sum).length)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  const vw = Math.max(...rows.map((r) => r[1].length));
  const out: string[] = [b(`Plan ${plan.runId}`) + d(`  (T3 Code ${plan.t3Version})`)];
  for (const [k, v] of rows) out.push(`  ${k.padEnd(w)}  ${v.padStart(vw)}`);
  const zst = compressedCodexLine(plan);
  if (zst !== null) out.push(`  ${zst}`);
  if (plan.pinDefault) out.push(`  Pin ${plan.pinDefault.instanceId} to ${plan.pinDefault.homePath} (T3 Code settings)`);
  const inst = Object.entries(sum.byInstance).sort((a, c) => c[1] - a[1]).slice(0, 5);
  if (inst.length) {
    out.push(d("  Imports by account"));
    const iw = Math.max(...inst.map(([id]) => (names[id] ?? id).length));
    for (const [id, n] of inst) out.push(`    ${(names[id] ?? id).padEnd(iw)}  ${String(n).padStart(vw)}`);
  }
  const top = SKIP_REASONS.filter((r) => sum.byReason[r] > 0).sort((a, c) => sum.byReason[c] - sum.byReason[a]).slice(0, 3);
  if (top.length) out.push(d(`  Top skips: ${top.map((r) => `${r} ${sum.byReason[r]}`).join(", ")}`));
  out.push("", `Full report: ${opts.planPath}`);
  out.push(plan.mirrorCopies.length > 0 ? `Next: ${b("t3sm dedupe")}, then ${b("t3sm apply")}.` : `Next: ${b("t3sm apply")}.`);
  return out.join("\n") + "\n";
}
