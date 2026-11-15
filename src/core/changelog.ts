// CHANGELOG.md (Keep a Changelog): the `## [X.Y.Z] - YYYY-MM-DD` release sections, for `t3sm changelog` and for what
// `t3sm update` shows before and after an update. `## [Unreleased]` and anything that is not a release version are left
// out; a section runs until the next `## ` heading.

import { compareSemver, parseSemver } from "./semver.ts";

export interface ChangelogSection {
  /** The release version, without a `v` ("0.3.0"). */
  version: string;
  /** The heading line as written (`## [0.3.0] - 2026-11-15`). */
  heading: string;
  /** The section's text after the heading, trimmed. */
  body: string;
}

/** The release sections of a CHANGELOG, in file order. */
export function changelogSections(text: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let cur: { version: string; heading: string; lines: string[] } | null = null;
  const close = (): void => { if (cur) out.push({ version: cur.version, heading: cur.heading, body: cur.lines.join("\n").trim() }); cur = null; };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("## ")) {
      close();
      const v = /^## \[([^\]]+)\]/.exec(line)?.[1];
      const p = v === undefined ? null : parseSemver(v);
      if (p !== null) cur = { version: p.join("."), heading: line.trimEnd(), lines: [] };
      continue;
    }
    // Link references (`[0.3.0]: https://...`, usually after the last section) belong to no section.
    if (/^\[[^\]]+\]:\s/.test(line)) continue;
    cur?.lines.push(line);
  }
  close();
  return out;
}

/** The sections of the versions newer than `after` and at most `upTo` (inclusive), newest first. */
export function sectionsBetween(text: string, after: string, upTo: string): ChangelogSection[] {
  return changelogSections(text)
    .filter((s) => compareSemver(s.version, after) > 0 && compareSemver(s.version, upTo) <= 0)
    .sort((a, b) => compareSemver(b.version, a.version));
}

/** The sections as printed: heading, blank line, body, blank line between sections. */
export function renderSections(sections: ChangelogSection[]): string {
  return sections.map((s) => `${s.heading}\n\n${s.body}\n`).join("\n");
}
