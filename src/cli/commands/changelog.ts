// t3sm changelog [--since <version>]: the release notes of the installed t3sm, read from its own CHANGELOG.md (shipped
// in the package). Default: the installed version's section; --since: every release newer than that version, up to the
// installed one, newest first. Read-only.

import { readFileSync } from "node:fs";
import { changelogSections, sectionsBetween } from "../../core/changelog.ts";
import { packageVersion } from "../../core/version.ts";
import { parseSemver } from "../../core/semver.ts";
import { parseFlags } from "./quarantine.ts";
import { renderNotes } from "./update.ts";
import { cliUi } from "../ui.ts";
import { flagsOf } from "../flags.ts";
import { noteLines } from "../screen.ts";
import type { Io } from "../main.ts";

export interface ChangelogDeps {
  /** The installed version (default: this install's package.json). */
  readVersion?: () => string;
  /** This install's CHANGELOG.md, or null when it cannot be read. */
  readChangelog?: () => string | null;
}

/** This install's CHANGELOG.md (src/ and dist/ both sit two folders below the package root), or null. */
export function installedChangelog(): string | null {
  try { return readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8"); } catch { return null; }
}

export async function changelogCommand(args: string[], io: Io, deps: ChangelogDeps = {}): Promise<number> {
  const spec = flagsOf("changelog");
  const p = parseFlags(args, io, "changelog", spec.bool, spec.valued);
  if (!p) return 2;
  const ui = cliUi(io);
  const since = p.values.get("--since");
  if (since !== undefined && parseSemver(since) === null) {
    io.stderr(`${ui.t("changelog.badSince", { since: JSON.stringify(since) })}\n`);
    return 2;
  }
  const version = (deps.readVersion ?? packageVersion)();
  const text = (deps.readChangelog ?? installedChangelog)();
  if (text === null) {
    io.stderr(`${ui.t("changelog.missing")}\n`);
    return 1;
  }
  if (parseSemver(version) === null) {
    io.stderr(`${ui.t("changelog.notRelease", { version: JSON.stringify(version) })}\n`);
    return 1;
  }
  const v = parseSemver(version)!.join(".");
  // Without --since: just this version's own section.
  const sections = since === undefined ? changelogSections(text).filter((s) => s.version === v).slice(0, 1) : sectionsBetween(text, since, v);
  if (sections.length === 0) {
    const msg = since === undefined ? ui.t("changelog.none", { version: v }) : ui.t("changelog.noneNewer", { since: parseSemver(since)!.join("."), version: v });
    io.stdout(noteLines(ui.s, "ok", msg, ui.width).join("\n") + "\n");
    return 0;
  }
  // The notes are written in English; drawn like a help topic (headings, bullets, wrapped to the window).
  // In another language, one muted line says so (they are not translated).
  const hint = ui.lang === "en" ? [] : [ui.s("muted", ui.t("changelog.inEnglish")), ""];
  io.stdout([...hint, ...renderNotes(ui, sections)].join("\n") + "\n");
  return 0;
}
