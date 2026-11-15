// Which `t3sm help <topic>` explains a reason a screen shows (a failed import, a held project, an undecided question,
// an error). The topics themselves are docs/help/<topic>.md and <topic>.pt.md (shipped in dist/help, read by
// src/cli/commands/help.ts); test/cli/help.test.ts checks that every topic named here exists in both languages.
// Screens print "t3sm help <topic>" instead of pointing at a docs file the user does not have.

/** Every topic a screen may name. */
export const HELP_TOPICS = [
  "not-imported", "t3-native", "orphaned", "held", "decisions", "history", "updates", "watcher", "cwd-unreadable",
  "instance-unavailable", "project-mismatch", "convert", "errors",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** The kinds of import failure: FailReason, and ConvertFailReason without its detail ("read-failed: ..."). */
export type ReasonKind = "not-imported" | "cwd-unreadable-in-t3" | "instance-unavailable" | "project-mismatch" | "no-reader"
  | "target-outside-accounts" | "target-exists" | "read-failed" | "write-failed" | "target-folder";
const KINDS: ReadonlySet<string> = new Set<ReasonKind>([
  "not-imported", "cwd-unreadable-in-t3", "instance-unavailable", "project-mismatch", "no-reader", "target-outside-accounts",
  "target-exists", "read-failed", "write-failed", "target-folder",
]);

/** The kind of an import failure's reason ("convert: read-failed: x" -> "read-failed"); null for any other reason. */
export function reasonKind(reason: string): ReasonKind | null {
  const k = reason.trim().replace(/^convert: /, "").replace(/:.*$/, "");
  return KINDS.has(k) ? (k as ReasonKind) : null;
}

const KIND_TOPIC: Record<ReasonKind, HelpTopic> = {
  "not-imported": "not-imported", "cwd-unreadable-in-t3": "cwd-unreadable", "instance-unavailable": "instance-unavailable",
  "project-mismatch": "project-mismatch", "no-reader": "convert", "target-outside-accounts": "convert", "target-exists": "convert",
  "read-failed": "convert", "write-failed": "convert", "target-folder": "convert",
};

/**
 * The topic for a reason code: an import failure (`not-imported`, `cwd-unreadable-in-t3`, a conversion's `read-failed:
 * ...`), a skip or plan reason (`orphaned-in-t3`, `t3-native-unknown`, `undecided`, `project-in-use`), or a status area
 * (`watcher`, `update-failed`, `history`). Anything unknown gets the general "errors" topic.
 */
export function helpTopicFor(reason: string): HelpTopic {
  const kind = reasonKind(reason);
  if (kind !== null) return KIND_TOPIC[kind];
  const r = reason.trim();
  if (r === "cwd-unreadable" || r === "no-cwd") return "cwd-unreadable";
  if (r === "harness-unavailable") return "instance-unavailable";
  if (r === "orphaned-in-t3" || r === "orphaned") return "orphaned";
  if (r === "t3-native-unknown" || r === "t3-native") return "t3-native";
  if (r === "held" || r === "project-in-use" || r === "active" || r === "in-use") return "held";
  if (r === "undecided" || r === "decisions") return "decisions";
  if (r === "history" || r.startsWith("history:")) return "history";
  if (r === "updates" || r.startsWith("update")) return "updates";
  if (r === "watcher" || r.startsWith("watcher") || r === "sync-failing") return "watcher";
  return "errors";
}

/** The command that opens the topic. */
export function helpCommand(reason: string): string {
  return `t3sm help ${helpTopicFor(reason)}`;
}
