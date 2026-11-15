// The one renderer of t3sm's help: the usage overview, each command's help and the global options (src/cli/help.en.ts
// and help.pt.ts), styled with the UI kit and fitted to the window. The texts keep a small fixed shape (see help.en.ts);
// this file reads it: the usage forms as commands, headings in bold, options and commands as a two-column list whose
// descriptions wrap under their column (stacked under the option on a narrow window), paragraphs and bullets wrapped,
// `backticks` as commands. Nothing is ever cut: what does not fit wraps.

import type { Lang } from "../assistant/i18n.ts";
import type { CliUi } from "../i18n/cli.ts";
import { displayWidth } from "../ui/text.ts";
import { fitLine, richAtoms, wrapAtoms } from "./screen.ts";
import * as en from "./help.en.ts";
import * as pt from "./help.pt.ts";

export interface HelpTexts { usage: string; global: string; commands: Record<string, string> }

export const HELP_TEXTS: Record<Lang, HelpTexts> = {
  en: { usage: en.USAGE, global: en.GLOBAL, commands: en.COMMANDS },
  pt: { usage: pt.USAGE, global: pt.GLOBAL, commands: pt.COMMANDS },
};

/** A command's help text and the global options, in `lang`; null for an unknown command. */
export function commandHelp(name: string, lang: Lang): string | null {
  const h = HELP_TEXTS[lang];
  return Object.hasOwn(h.commands, name) ? h.commands[name]! + h.global : null;
}

/** The usage overview and the global options, in `lang`. */
export function usageHelp(lang: Lang): string {
  return HELP_TEXTS[lang].usage + HELP_TEXTS[lang].global;
}

const OPTION_HEADINGS = new Set(["Options:", "Opções:"]);
const USAGE_RE = /^(Usage|Uso):/;

type Segment = { pre: false; text: string } | { pre: true; line: string };
interface Item { term: string; col: number | null; desc: Segment[] }
type Block =
  | { kind: "usage"; label: string; forms: string[] }
  | { kind: "items"; heading: string; items: Item[] }
  | { kind: "form"; heading: string; body: string[] }
  | { kind: "para"; lines: string[] };

const indentOf = (l: string): number => /^ */.exec(l)![0].length;

function parseItems(lines: string[]): Item[] {
  const items: Item[] = [];
  for (const l of lines) {
    if (indentOf(l) === 2) {
      const m = /^ {2}(.+?)(?: {2,}(\S.*))?$/.exec(l)!;
      const col = m[2] !== undefined ? l.length - m[2].length : null;
      items.push({ term: m[1]!.trim(), col, desc: m[2] !== undefined ? [{ pre: false, text: m[2] }] : [] });
      continue;
    }
    const it = items.at(-1);
    if (!it) continue;
    const trimmed = l.trim();
    // A continued line with aligned columns inside (status --help's JSON keys) is kept as it is.
    if (/\S {2,}\S/.test(trimmed)) it.desc.push({ pre: true, line: l });
    else {
      const last = it.desc.at(-1);
      if (last && !last.pre) last.text += " " + trimmed;
      else it.desc.push({ pre: false, text: trimmed });
    }
  }
  return items;
}

export function parseHelp(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const first = lines[0]!;
    const rest = lines.slice(1);
    const m = USAGE_RE.exec(first);
    if (m) {
      blocks.push({ kind: "usage", label: m[0], forms: [first.slice(m[0].length).trim(), ...rest.map((l) => l.trim())].filter((f) => f !== "") });
      continue;
    }
    const indentedRest = rest.length > 0 && indentOf(first) === 0 && rest.every((l) => indentOf(l) >= 2);
    if (indentedRest && /^t3sm /.test(first) && !rest.some((l) => /\S {2,}\S/.test(l.trim()))) {
      blocks.push({ kind: "form", heading: first, body: rest.map((l) => l.trim()) });
      continue;
    }
    if (indentedRest && indentOf(rest[0]!) === 2 && !/^ {2}- /.test(rest[0]!)) {
      blocks.push({ kind: "items", heading: first, items: parseItems(rest) });
      continue;
    }
    blocks.push({ kind: "para", lines });
  }
  return blocks;
}

/** Every `--option` a help text offers: in its usage forms and in its Options list (prose mentions are not offers). */
export function helpFlags(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => { for (const m of s.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) out.add(m[0]); };
  for (const b of parseHelp(text)) {
    if (b.kind === "usage") b.forms.forEach(add);
    else if (b.kind === "items" && OPTION_HEADINGS.has(b.heading)) b.items.forEach((i) => add(i.term));
  }
  return [...out];
}

const rtrim = (l: string): string => l.replace(/ +$/, "");

/** A paragraph's lines with "- " bullets: the text wrapped to `width`, each bullet hanging under its text. */
function paragraph(ui: CliUi, lines: string[], width: number, indent = 0): string[] {
  const { s } = ui;
  const out: string[] = [];
  const parts: { bullet: boolean; text: string }[] = [];
  for (const l of lines) {
    const b = /^\s*- (.*)$/.exec(l);
    if (b) { parts.push({ bullet: true, text: b[1]! }); continue; }
    const last = parts.at(-1);
    if (last && (last.bullet ? indentOf(l) >= 4 : true)) last.text += " " + l.trim();
    else parts.push({ bullet: false, text: l.trim() });
  }
  const pad = " ".repeat(indent);
  for (const p of parts) {
    const atoms = richAtoms(s, p.text);
    if (!p.bullet) { for (const l of wrapAtoms(atoms, width - indent, width - indent)) out.push(pad + l); continue; }
    const lead = `${pad}  ${s.sym.bullet} `;
    const hang = displayWidth(lead);
    wrapAtoms(atoms, width - hang, width - hang).forEach((l, i) => out.push((i === 0 ? s("muted", lead) : " ".repeat(hang)) + l));
  }
  return out.map(rtrim);
}

function renderItems(ui: CliUi, b: Extract<Block, { kind: "items" }>, width: number): string[] {
  const { s } = ui;
  const out = fitLine(s("title", b.heading), width);
  const cols = b.items.map((i) => i.col).filter((c): c is number => c !== null);
  // The column the text was laid out for: the one most items use.
  const count = new Map<number, number>();
  for (const c of cols) count.set(c, (count.get(c) ?? 0) + 1);
  const col = [...count.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 4;
  const wide = width >= 60 && col <= Math.floor(width / 2);
  for (const it of b.items) {
    const term = it.term;
    const termLines = (w: number): string[] => (displayWidth(term) <= w ? [term] : fitLine(term, w));
    if (it.desc.length === 0) { for (const l of termLines(width - 2)) out.push("  " + s("key", l)); continue; }
    const descCol = wide ? col : 4;
    let firstRoom: number;
    if (wide && 2 + displayWidth(term) + 2 <= width - 10) {
      // On the term's line, at the column (or right after a term wider than it), then under the column.
      const start = Math.max(col, 2 + displayWidth(term) + 2);
      firstRoom = width - start;
      let first = true;
      for (const seg of it.desc) {
        if (seg.pre) { pushPre(out, seg.line, it.col ?? col, descCol, width); first = false; continue; }
        wrapAtoms(richAtoms(s, seg.text), first ? firstRoom : width - descCol, width - descCol).forEach((l, i) => {
          if (first && i === 0) out.push(rtrim("  " + s("key", term) + " ".repeat(start - 2 - displayWidth(term)) + l));
          else out.push(rtrim(" ".repeat(descCol) + l));
        });
        first = false;
      }
      continue;
    }
    for (const l of termLines(width - 2)) out.push("  " + s("key", l));
    for (const seg of it.desc) {
      if (seg.pre) { pushPre(out, seg.line, it.col ?? col, descCol, width); continue; }
      for (const l of wrapAtoms(richAtoms(s, seg.text), width - descCol, width - descCol)) out.push(rtrim(" ".repeat(descCol) + l));
    }
  }
  return out;
}

/** A continued line with aligned columns, moved from the text's column to `descCol` (its own alignment kept), fitted. */
function pushPre(out: string[], line: string, srcCol: number, descCol: number, width: number): void {
  const rel = Math.max(0, indentOf(line) - srcCol);
  const text = " ".repeat(descCol + rel) + line.trim();
  if (displayWidth(text) <= width) { out.push(text); return; }
  // Too wide: the aligned head ("  key      ") stays as it is, the rest wraps under its own column.
  const m = /^(\s*\S+ {2,})(\S.*)$/.exec(text);
  const head = m ? displayWidth(m[1]!) : width;
  if (!m || head > width - 12) { out.push(...fitLine(text, width, 2)); return; }
  wrapAtoms(m[2]!.split(/ +/), width - head, width - head).forEach((l, i) => out.push((i === 0 ? m[1]! : " ".repeat(head)) + l));
}

function renderUsage(ui: CliUi, b: Extract<Block, { kind: "usage" }>, width: number): string[] {
  const { s } = ui;
  const label = b.label + " ";
  const lw = displayWidth(label);
  const out: string[] = [];
  const beside = lw <= Math.floor(width / 3);
  if (!beside) out.push(s("title", b.label));
  const ind = beside ? lw : 2;
  b.forms.forEach((f, n) => {
    const atoms = f.split(/ +/).map((a) => s("key", a));
    wrapAtoms(atoms, width - ind, width - ind - 2).forEach((l, i) => {
      if (i === 0) out.push(rtrim((beside && n === 0 ? s("title", b.label) + " " : " ".repeat(ind)) + l));
      else out.push(rtrim(" ".repeat(ind + 2) + l));
    });
  });
  return out;
}

/** A help text (or several, concatenated) as styled lines that fit `width`. */
export function renderHelpText(ui: CliUi, text: string, width: number = ui.width): string[] {
  const w = Math.max(20, width);
  const out: string[] = [];
  for (const b of parseHelp(text)) {
    if (out.length > 0) out.push("");
    if (b.kind === "usage") out.push(...renderUsage(ui, b, w));
    else if (b.kind === "items") out.push(...renderItems(ui, b, w));
    else if (b.kind === "form") out.push(...fitLine(ui.s("key", b.heading), w), ...paragraph(ui, b.body, w, 2));
    else out.push(...paragraph(ui, b.lines, w));
  }
  return out;
}
