// Words several screens share: the organize questions by name, and a project folder by its last name.

import type { CliKey } from "./cli.ts";

/** The organize questions (organize.decided / decisionsPending keys) in words. */
export const DECISION_WORDS: Readonly<Record<string, CliKey>> = {
  home: "status.decision.home", "t3-refused": "status.decision.t3Refused", temp: "status.decision.temp",
  system: "status.decision.system", automated: "status.decision.automated", orphaned: "status.decision.orphaned",
};

/** A project root's last folder name (what the user knows the project by). */
export const folderName = (root: string): string => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
