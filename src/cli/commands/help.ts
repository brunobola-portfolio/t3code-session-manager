// t3sm help [<topic> | <command>]: what a message on a t3sm screen means, why it happens and what to do. The topics
// are short Markdown files shipped with t3sm: docs/help/<topic>.md (English) and <topic>.pt.md (European Portuguese),
// copied into dist/help by the build. A topic is drawn as wrapped text in the user's language (English when it has no
// translation): headings in bold, lists as bullets, `code` as a command, links as their text. Without a topic: the list
// of topics with their titles. An unknown topic: exit 2 with the list. A command's name: that command's --help.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Lang } from "../../assistant/i18n.ts";
import { HELP_TOPICS } from "../helpTopics.ts";
import { commandHelp, renderHelpText } from "../helpText.ts";
import { fitLine, richAtoms, wrapAtoms } from "../screen.ts";
import { cliUi, type CliUi } from "../ui.ts";
import { displayWidth } from "../../ui/text.ts";
import type { Io } from "../main.ts";

export interface HelpDeps {
  /** The folder holding the topic files (default: this install's, see helpDir). */
  dir?: string;
}

/**
 * This install's help folder: dist/help next to the compiled commands (an installed package), else the checkout's
 * docs/help (src/ runs straight from the sources). Null when neither exists.
 */
export function helpDir(): string | null {
  for (const rel of ["../../help/", "../../../docs/help/"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return null;
}

/** A topic's Markdown in `lang`, else in English; null when the topic has no file. */
export function readTopic(dir: string, topic: string, lang: Lang): string | null {
  const names = lang === "pt" ? [`${topic}.pt.md`, `${topic}.md`] : [`${topic}.md`];
  for (const n of names) {
    try { return readFileSync(`${dir.replace(/[\\/]+$/, "")}/${n}`, "utf8"); } catch { /* the next one */ }
  }
  return null;
}

/** A topic's one-line summary: its title (the first `# ` heading). */
export function topicSummary(md: string): string {
  return /^# +(.+?)\s*$/m.exec(md)?.[1] ?? "";
}

/** Inline Markdown as plain text with `code` kept in backticks for richAtoms: links become their text, emphasis goes. */
function inline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, "$1$2")
    .replace(/(^|\W)_([^_\s][^_]*)_(?!\w)/g, "$1$2");
}

/**
 * Markdown as styled lines that fit `width`: `#` headings bold (a blank line before each but the first), paragraphs
 * wrapped, `- ` / `1. ` lists as hanging bullets, fenced code as indented commands (fitted, never re-wrapped), inline
 * `code` as a command. Tables and HTML are not used in the topics.
 */
export function renderMarkdown(ui: CliUi, md: string, width: number = ui.width): string[] {
  const { s } = ui;
  const w = Math.max(20, width);
  const out: string[] = [];
  const blank = (): void => { if (out.length > 0 && out.at(-1) !== "") out.push(""); };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let item: { lead: string; text: string } | null = null;
  const flushPara = (): void => {
    if (para.length > 0) { blank(); out.push(...wrapAtoms(richAtoms(s, inline(para.join(" "))), w, w)); para = []; }
  };
  const flushItem = (): void => {
    if (!item) return;
    const lead = `  ${item.lead} `;
    const hang = displayWidth(lead);
    wrapAtoms(richAtoms(s, inline(item.text)), w - hang, w - hang).forEach((l, i) => out.push((i === 0 ? s("muted", lead) : " ".repeat(hang)) + l));
    item = null;
  };
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      flushPara(); flushItem(); inList = false;
      blank();
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) {
        const code = lines[i]!.replace(/\s+$/, "");
        if (code === "") { out.push(""); continue; }
        for (const c of fitLine("    " + code, w, 2)) out.push(s("key", c));
      }
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flushPara(); flushItem(); inList = false;
      blank();
      out.push(...fitLine(s("title", inline(h[2]!).replace(/`/g, "")), w));
      continue;
    }
    const li = /^\s*(?:[-*+]|(\d+)\.)\s+(.*)$/.exec(l);
    if (li) {
      flushPara(); flushItem();
      if (!inList) blank();
      inList = true;
      item = { lead: li[1] !== undefined ? `${li[1]}.` : s.sym.bullet, text: li[2]! };
      continue;
    }
    if (l.trim() === "") { flushPara(); flushItem(); inList = false; continue; }
    if (item && /^\s+\S/.test(l)) { item.text += " " + l.trim(); continue; }
    flushItem(); inList = false;
    para.push(l.trim());
  }
  flushPara(); flushItem();
  return out.map((x) => x.replace(/ +$/, ""));
}

/** The topics with their summaries in `lang` (English summary when a translation is missing). */
export function renderTopicList(ui: CliUi, dir: string | null, width: number = ui.width): string[] {
  const { s } = ui;
  const rows = HELP_TOPICS.map((t) => ({ t, sum: dir === null ? "" : topicSummary(readTopic(dir, t, ui.lang) ?? "") }));
  const nameW = Math.max(...rows.map((r) => displayWidth(r.t)));
  const col = 2 + nameW + 2;
  const out = [...fitLine(s("title", ui.t("help.topicsTitle")), width), ""];
  for (const r of rows) {
    if (width >= 50) {
      wrapAtoms(r.sum.split(" "), width - col, width - col).forEach((l, i) => out.push((i === 0 ? "  " + s("key", r.t) + " ".repeat(col - 2 - displayWidth(r.t)) : " ".repeat(col)) + l));
      if (r.sum === "") out.push("  " + s("key", r.t));
    } else {
      out.push("  " + s("key", r.t));
      for (const l of wrapAtoms(r.sum.split(" "), width - 4, width - 4)) out.push("    " + l);
    }
  }
  out.push("", ...wrapAtoms(richAtoms(s, ui.t("help.topicsHint")), width, width));
  return out.map((x) => x.replace(/ +$/, ""));
}

export async function helpCommand(args: string[], io: Io, deps: HelpDeps = {}): Promise<number> {
  const ui = cliUi(io);
  const width = ui.width;
  const dir = deps.dir ?? helpDir();
  const extra = args.filter((a) => a !== "--help" && a !== "-h");
  if (extra.length > 1 || extra.some((a) => a.startsWith("-"))) {
    io.stderr(`${ui.t("help.usage")}\n`);
    return 2;
  }
  if (extra.length === 0) { io.stdout(renderTopicList(ui, dir, width).join("\n") + "\n"); return 0; }
  const name = extra[0]!;
  if ((HELP_TOPICS as readonly string[]).includes(name)) {
    const md = dir === null ? null : readTopic(dir, name, ui.lang);
    if (md === null) { io.stderr(`${ui.t("help.missing", { topic: name })}\n`); return 1; }
    io.stdout(renderMarkdown(ui, md, width).join("\n") + "\n");
    return 0;
  }
  const cmd = commandHelp(name, ui.lang);
  if (cmd !== null) { io.stdout(renderHelpText(ui, cmd, width).join("\n") + "\n"); return 0; }
  io.stderr([ui.t("help.unknown", { topic: name }), "", ...renderTopicList(ui, dir, width)].join("\n") + "\n");
  return 2;
}
