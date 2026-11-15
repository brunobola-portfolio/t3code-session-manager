// Conversations that could not be imported (apply, sync), as a person can act on them: the project, the conversation
// (its title, never its id), why in words (never a reason code) and what to do, then one line with the `t3sm help`
// topics that explain the reasons. Titles and folders come from transcripts and T3 Code: untrusted, through shownText.

import type { ImportFailure } from "../apply/apply.ts";
import { shownText } from "../plan/names.ts";
import { table, type Column } from "../ui/components.ts";
import { displayWidth } from "../ui/text.ts";
import { reasonKind, helpTopicFor, type ReasonKind } from "./helpTopics.ts";
import { fitLine, flowAtoms, richAtoms } from "./screen.ts";
import type { CliKey, CliUi } from "./ui.ts";
import { folderName } from "./words.ts";

/** Rows shown before "and N more" (and the failures whose titles are read). */
export const FAILURES_SHOWN = 20;
/** Narrower than this the failures are a list: four columns would cut the title or what to do. */
const TABLE_MIN = 100;

/** Why each kind of failure happened, and what to do about it. */
const WORDS: Record<ReasonKind, { why: CliKey; todo: CliKey }> = {
  "not-imported": { why: "fail.why.notImported", todo: "fail.todo.notImported" },
  "cwd-unreadable-in-t3": { why: "fail.why.cwdUnreadable", todo: "fail.todo.cwdUnreadable" },
  "instance-unavailable": { why: "fail.why.instanceUnavailable", todo: "fail.todo.instanceUnavailable" },
  "project-mismatch": { why: "fail.why.projectMismatch", todo: "fail.todo.projectMismatch" },
  "no-reader": { why: "fail.why.noReader", todo: "fail.todo.noReader" },
  "target-outside-accounts": { why: "fail.why.targetOutside", todo: "fail.todo.targetOutside" },
  "target-exists": { why: "fail.why.targetExists", todo: "fail.todo.targetExists" },
  "read-failed": { why: "fail.why.readFailed", todo: "fail.todo.readFailed" },
  "write-failed": { why: "fail.why.writeFailed", todo: "fail.todo.writeFailed" },
  "target-folder": { why: "fail.why.targetFolder", todo: "fail.todo.targetFolder" },
};

/** The catalogue words for a reason code; a code t3sm does not know gets the general words. */
export function failureWords(reason: string): { why: CliKey; todo: CliKey } {
  const k = reasonKind(reason);
  return k !== null ? WORDS[k] : { why: "fail.why.other", todo: "fail.todo.other" };
}

interface Row { project: string; conversation: string; why: string; todo: string; todoAtoms: string[] }

/**
 * "More help: t3sm help not-imported, cwd-unreadable, convert": the topics after one `t3sm help`, separated by commas
 * (never "-" or "·", which an ASCII console would draw as a dash); a topic is never split.
 */
export function helpLine(ui: CliUi, reasons: readonly string[], width: number = ui.width): string[] {
  const { s } = ui;
  const topics = [...new Set(reasons.map(helpTopicFor))];
  if (topics.length === 0) return [];
  const atoms = [s("muted", s.sym.arrow), ...ui.t("common.moreHelp", { command: "" }).trim().split(/\s+/),
    ...topics.map((tp, i) => s("key", i === 0 ? `t3sm help ${tp}` : tp) + (i < topics.length - 1 ? s("muted", ",") : ""))];
  return flowAtoms(atoms, width, 2);
}

/**
 * The failures, titled ("could not be imported", or with `dry` "would fail to import"), at most FAILURES_SHOWN of
 * them. A table when every column fits whole in a window of 100 columns or more; otherwise one entry per conversation
 * ("project · title", then "why · what to do"), so nothing is ever cut. Then the help topics, on one line.
 */
export function failureTable(ui: CliUi, failures: readonly ImportFailure[], width: number = ui.width, o: { dry?: boolean } = {}): string[] {
  if (failures.length === 0) return [];
  const { s, t } = ui;
  const shown = failures.slice(0, FAILURES_SHOWN);
  const rows: Row[] = shown.map((f) => {
    const w = failureWords(f.reason);
    return {
      project: shownText(folderName(f.projectRoot), 60),
      conversation: f.title !== null && f.title.trim() !== "" ? shownText(f.title, 80) : t("common.untitled"),
      // What to do may name a command (`t3sm apply`): the table shows it plain, the list keeps it whole.
      why: t(w.why), todo: t(w.todo).replace(/`/g, ""), todoAtoms: richAtoms(s, t(w.todo)),
    };
  });
  const out = fitLine(`${s("err", s.sym.err)} ${s("title", t(o.dry ? "fail.titleDry" : "fail.title", { n: failures.length }))}`, width, 2);
  const cols: Column[] = [
    { header: t("fail.col.project"), get: (r) => (r as Row).project },
    { header: t("fail.col.conversation"), get: (r) => (r as Row).conversation },
    { header: t("fail.col.why"), get: (r) => (r as Row).why },
    { header: t("fail.col.todo"), get: (r) => (r as Row).todo },
  ];
  const natural = cols.reduce((a, c) => a + Math.max(displayWidth(c.header), ...rows.map((r) => displayWidth(c.get(r)))), 0) + 2 * (cols.length - 1);
  if (width >= TABLE_MIN && natural <= width) out.push(...table(s, cols, rows, width));
  else {
    for (const r of rows) {
      out.push(...fitLine(`${s("title", r.project)} ${s("muted", s.sym.sep)} ${r.conversation}`, width, 2));
      out.push(...flowAtoms([...r.why.split(/\s+/), s("muted", s.sym.sep), ...r.todoAtoms], Math.max(1, width - 2), 2).map((l) => `  ${l}`));
    }
  }
  if (failures.length > shown.length) out.push(...fitLine(s("muted", `${s.sym.ellipsis} ${t("common.andMore", { n: failures.length - shown.length })} (t3sm runs)`), width));
  out.push(...helpLine(ui, shown.map((f) => f.reason), width));
  return out;
}

