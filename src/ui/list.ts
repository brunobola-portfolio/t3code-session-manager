// The review list: long lists (folders to decide, conversations to move, project names, organize changes) reviewed
// with the keys instead of typed numbers. Zero dependencies, driven through an injectable Term. Without a terminal
// (or with `plain`) the same decisions are taken from numbered lines.
//
// Every caller string (label, detail, meta, prompts, edited values) is untrusted text: it goes through `shownText`
// once, before anything is drawn, so no escape or bidi character reaches the terminal. Per frame only one page of
// lines is built, and a filter keystroke is one pass over the items (lower-cased text is kept from the start).

import { CATALOGUES, fmt, wrap, type Catalogue, type Lang } from "../assistant/i18n.ts";
import { cleanText, shownText } from "../plan/names.ts";
import type { Term, TermKey } from "./terminal.ts";
import { wrapTo } from "./text.ts";

export interface ListItem {
  id: string; label: string; detail: string; meta?: string; checked: boolean;
  /** `prompt` asks the question, `value` is the current (and proposed) value, `choices` makes it a pick list. */
  editable?: { prompt: string; value: string; choices?: string[] };
}
export interface ListResult { confirmed: boolean; items: ListItem[] }

/** Work counters for tests (rows per frame, filter passes), never wall-clock time. */
export interface ListStats { frames: number; rowsRendered: number; maxRowsInFrame: number; filterPasses: number; filterVisits: number; sanitized: number }

export interface ListOptions { title: string; help: string; items: ListItem[]; lang: Lang; plain?: boolean; stats?: ListStats }

const MIN_WIDTH = 40;
/** Lines of a frame that are not list rows: title, help, status, two detail lines, footer, one spare. */
const CHROME = 7;
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const ERASE_LINE = "\x1b[2K";
const ERASE_BELOW = "\x1b[J";

interface Row {
  src: ListItem;
  checked: boolean;
  /** Current value of an editable row (raw: the caller's own, until edited). */
  value: string | null;
  label: string; detail: string; meta: string; shownValue: string; prompt: string; choices: string[];
  /** Lower-cased label and detail, for the filter. */
  hay: string;
}

export async function reviewList(term: Term, o: ListOptions): Promise<ListResult> {
  const m = CATALOGUES[o.lang];
  const rows = o.items.map((it): Row => {
    if (o.stats) o.stats.sanitized++;
    const value = it.editable ? it.editable.value : null;
    const label = shownText(it.label);
    const detail = shownText(it.detail);
    return {
      src: it, checked: it.checked, value, label, detail, meta: shownText(it.meta ?? ""),
      shownValue: value === null ? "" : shownText(value), prompt: it.editable ? shownText(it.editable.prompt) : "",
      choices: it.editable?.choices?.map((c) => shownText(c)) ?? [],
      hay: `${label}\n${detail}`.toLowerCase(),
    };
  });
  const result = (confirmed: boolean): ListResult => ({
    confirmed,
    items: rows.map((r) => {
      const out: ListItem = { ...r.src, checked: confirmed ? r.checked : r.src.checked };
      if (r.src.editable) out.editable = { ...r.src.editable, value: confirmed && r.value !== null ? r.value : r.src.editable.value };
      return out;
    }),
  });
  const ctx: Ctx = { term, m, title: shownText(o.title), help: shownText(o.help), rows, stats: o.stats };
  return o.plain || !term.isTTY ? plainList(ctx) : interactiveList(ctx, result);
}

interface Ctx { term: Term; m: Catalogue; title: string; help: string; rows: Row[]; stats: ListStats | undefined }

// ---------------- interactive ----------------

type Mode = "list" | "filter" | "edit" | "choice" | "help";

const isPrintable = (k: TermKey): boolean => k.ch !== "" && !k.ctrl && !k.meta && k.ch >= " " && k.ch !== "";

/** At most `w` columns: cut with an ellipsis. */
function clip(s: string, w: number, ell: string): string {
  const cs = Array.from(s);
  if (cs.length <= w) return s;
  if (w <= ell.length) return cs.slice(0, w).join("");
  return cs.slice(0, w - ell.length).join("") + ell;
}

async function interactiveList(c: Ctx, result: (confirmed: boolean) => ListResult): Promise<ListResult> {
  const { term, rows } = c;
  const uni = term.unicode;
  const sym = { on: uni ? "[✓]" : "[x]", off: "[ ]", cur: uni ? "›" : ">", ell: uni ? "…" : "...", arrow: uni ? "→" : "->" };
  const paint = (s: string, code: string): string => (term.color ? `\x1b[${code}m${s}\x1b[0m` : s);

  let mode: Mode = "list";
  let filter = "";
  let vis: number[] = rows.map((_, i) => i);
  let cursor = 0;
  let top = 0;
  let buf = "";
  let choice = 0;
  let note = "";
  let prevLines = 0;
  let done = false;
  const sub: { off?: () => void } = {};

  const width = (): number => Math.max(MIN_WIDTH, term.columns);
  const pageSize = (): number => Math.max(3, term.rows - CHROME);
  const cur = (): Row | undefined => (vis[cursor] === undefined ? undefined : rows[vis[cursor]!]);

  /** One pass over every row; the cursor stays on the same row when it is still shown. */
  const refilter = (text: string): void => {
    const keep = vis[cursor];
    const q = text.toLowerCase();
    if (c.stats) c.stats.filterPasses++;
    const next: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (c.stats) c.stats.filterVisits++;
      if (q === "" || rows[i]!.hay.includes(q)) next.push(i);
    }
    vis = next;
    const at = keep === undefined ? -1 : vis.indexOf(keep);
    cursor = at >= 0 ? at : 0;
    top = 0;
  };
  const move = (to: number): void => { cursor = Math.max(0, Math.min(vis.length - 1, to)); };
  const marked = (): number => rows.reduce((n, r) => n + (r.checked ? 1 : 0), 0);

  const rowLine = (r: Row, selected: boolean, w: number): string => {
    const prefix = `${selected ? sym.cur : " "} ${r.checked ? sym.on : sym.off} `;
    const text = r.value !== null ? `${r.label} ${sym.arrow} ${r.shownValue}` : r.label;
    const avail = w - 1 - Array.from(prefix).length;
    let body: string;
    if (r.meta !== "" && Array.from(text).length + 2 + Array.from(r.meta).length <= avail) {
      body = text + " ".repeat(avail - Array.from(text).length - Array.from(r.meta).length) + r.meta;
    } else if (r.meta !== "" && avail - Array.from(r.meta).length - 2 >= 10) {
      body = clip(text, avail - Array.from(r.meta).length - 2, sym.ell) + "  " + r.meta;
    } else body = clip(text, avail, sym.ell);
    const line = prefix + body;
    return selected ? paint(line, "7") : line;
  };

  const footer = (w: number): string => {
    const full = c.m.listFooter;
    return Array.from(full).length <= w - 1 ? full : c.m.listFooterShort;
  };

  const frame = (): string[] => {
    const w = width();
    const line = (s: string): string => clip(s, w - 1, sym.ell);
    const L: string[] = [];
    if (mode === "help") {
      L.push(paint(line(c.m.listHelpTitle), "1"));
      for (const l of wrap(c.m.listHelpBody, w - 3)) L.push(line(`  ${l}`));
      L.push(paint(line(c.m.listAnyKey), "2"));
      return L;
    }
    const ps = pageSize();
    L.push(paint(line(c.title), "1"));
    L.push(paint(line(c.help), "2"));

    // status line
    let status: string;
    if (mode === "filter") status = `${c.m.listFilterPrompt}: ${shownText(buf)}_`;
    else if (mode === "edit") status = `${cur()?.prompt ?? ""}: ${shownText(buf)}_`;
    else if (mode === "choice") status = cur()?.prompt ?? "";
    else {
      status = filter === "" ? fmt(c.m.listStatus, { marked: marked(), total: rows.length })
        : `${fmt(c.m.listStatusFiltered, { marked: marked(), total: rows.length, shown: vis.length })} (${c.m.listFilterPrompt}: ${shownText(filter)})`;
      if (note !== "") status = note;
    }
    L.push(line(status));

    // the page of lines
    let drawn = 0;
    if (mode === "choice") {
      const r = cur();
      const cs = r?.choices ?? [];
      const from = choice >= ps ? choice - ps + 1 : 0;
      for (let i = from; i < Math.min(cs.length, from + ps); i++) {
        const l = `${i === choice ? sym.cur : " "} ${cs[i]!}`;
        L.push(line(i === choice ? paint(l, "7") : l));
        drawn++;
      }
    } else if (rows.length === 0) {
      L.push(line(c.m.listEmpty));
    } else if (vis.length === 0) {
      L.push(line(c.m.listNoMatches));
    } else {
      if (cursor < top) top = cursor;
      if (cursor >= top + ps) top = cursor - ps + 1;
      const end = Math.min(vis.length, top + ps);
      for (let i = top; i < end; i++) { L.push(rowLine(rows[vis[i]!]!, i === cursor, w)); drawn++; }
    }
    if (c.stats) { c.stats.frames++; c.stats.rowsRendered += drawn; c.stats.maxRowsInFrame = Math.max(c.stats.maxRowsInFrame, drawn); }

    // detail of the selected line, or the hint of the current mode
    if (mode === "list") {
      const r = cur();
      if (r !== undefined && r.detail !== "") {
        const parts = wrap(r.detail, w - 3);
        const shown = parts.slice(0, 2).map((p, i) => (i === 1 && parts.length > 2 ? p + sym.ell : p));
        for (const p of shown) L.push(paint(line(`  ${p}`), "2"));
      }
    } else {
      const hint = mode === "filter" ? c.m.listFilterHint : mode === "edit" ? c.m.listEditHint : c.m.listChoiceHint;
      L.push(paint(line(`  ${hint}`), "2"));
    }
    L.push(paint(line(footer(w)), "2"));
    return L;
  };

  const draw = (): void => {
    const lines = frame();
    const up = prevLines > 1 ? `\x1b[${prevLines - 1}A` : "";
    term.write((prevLines > 0 ? `\r${up}` : "") + lines.map((l) => ERASE_LINE + l).join("\n") + ERASE_BELOW);
    prevLines = lines.length;
  };

  const erase = (): void => {
    if (prevLines === 0) return;
    const up = prevLines > 1 ? `\x1b[${prevLines - 1}A` : "";
    term.write(`\r${up}${ERASE_BELOW}`);
    prevLines = 0;
  };

  const startEdit = (): void => {
    const r = cur();
    note = "";
    if (r === undefined || r.value === null) { note = c.m.listNoEdit; return; }
    if (r.choices.length > 0) {
      const at = (r.src.editable!.choices ?? []).indexOf(r.value);
      choice = at >= 0 ? at : 0;
      mode = "choice";
    } else { buf = r.shownValue; mode = "edit"; }
  };

  /** Returns the result when the key ends the list. */
  const onKey = (k: TermKey): ListResult | null => {
    if (k.ctrl && k.name === "c") return result(false);
    if (mode === "help") { mode = "list"; return null; }
    if (mode === "filter") {
      if (k.name === "return") { filter = buf; mode = "list"; }
      else if (k.name === "escape") { filter = ""; buf = ""; refilter(""); mode = "list"; }
      else if (k.name === "backspace") { buf = Array.from(buf).slice(0, -1).join(""); refilter(buf); }
      else if (isPrintable(k)) { buf += k.ch; refilter(buf); }
      return null;
    }
    if (mode === "edit") {
      const r = cur();
      if (k.name === "return") {
        const v = cleanText(buf);
        if (r !== undefined && v !== "") { r.value = v; r.shownValue = shownText(v); }
        mode = "list";
      } else if (k.name === "escape") mode = "list";
      else if (k.name === "backspace") buf = Array.from(buf).slice(0, -1).join("");
      else if (isPrintable(k)) buf += k.ch;
      return null;
    }
    if (mode === "choice") {
      const r = cur();
      const n = r?.choices.length ?? 0;
      if (k.name === "up") choice = Math.max(0, choice - 1);
      else if (k.name === "down") choice = Math.min(n - 1, choice + 1);
      else if (k.name === "return") {
        const v = r?.src.editable?.choices?.[choice];
        if (r !== undefined && v !== undefined) { r.value = v; r.shownValue = r.choices[choice]!; }
        mode = "list";
      } else if (k.name === "escape") mode = "list";
      return null;
    }
    // list
    note = "";
    const ps = pageSize();
    if (k.ctrl || k.meta) return null;
    switch (k.name) {
      case "up": move(cursor - 1); return null;
      case "down": move(cursor + 1); return null;
      case "pageup": move(cursor - ps); return null;
      case "pagedown": move(cursor + ps); return null;
      case "home": move(0); return null;
      case "end": move(vis.length - 1); return null;
      case "space": { const r = cur(); if (r) r.checked = !r.checked; return null; }
      case "return": return result(true);
      case "escape": return result(false);
      default: break;
    }
    switch (k.ch) {
      case "k": move(cursor - 1); break;
      case "j": move(cursor + 1); break;
      case "a": for (const i of vis) rows[i]!.checked = true; break;
      case "n": for (const i of vis) rows[i]!.checked = false; break;
      case "e": startEdit(); break;
      case "/": buf = ""; mode = "filter"; break;
      case "?": mode = "help"; break;
      case "q": return result(false);
      default: break;
    }
    return null;
  };

  term.setRaw(true);
  try {
    term.write(HIDE);
    return await new Promise<ListResult>((resolve, reject) => {
      const finish = (r: ListResult): void => { if (!done) { done = true; resolve(r); } };
      const fail = (e: unknown): void => { if (!done) { done = true; reject(e); } };
      sub.off = term.onKey((k) => {
        if (done) return;
        try {
          const r = onKey(k);
          if (r) finish(r); else draw();
        } catch (e) { fail(e); }
      }, () => finish(result(false))); // input closed: cancel
      try { draw(); } catch (e) { fail(e); }
    });
  } finally {
    done = true;
    try { sub.off?.(); } catch { /* keep restoring */ }
    try { erase(); } catch { /* the terminal may be gone; the cursor and raw mode still go back */ }
    try { term.write(SHOW); } catch { /* same */ }
    term.setRaw(false);
  }
}

// ---------------- plain (no terminal, or --plain) ----------------

/** "2 5-7" -> [2, 5, 6, 7]; null when a token is not a number or a range inside 1..max. */
function parseNumbers(text: string, max: number): number[] | null {
  const out: number[] = [];
  for (const tok of text.split(/[\s,]+/).filter((t) => t !== "")) {
    const mm = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!mm) return null;
    const a = Number(mm[1]);
    const b = mm[2] === undefined ? a : Number(mm[2]);
    if (a < 1 || b > max || a > b) return null;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

async function plainList(c: Ctx): Promise<ListResult> {
  const { term, m, rows } = c;
  // Every line fits the terminal: a longer one is wrapped, its continuation under its text (a narrow window, a pipe).
  const cols = (): number => Math.max(1, Math.floor(term.columns) || 80);
  const fit = (s: string): string[] => {
    // A numbered line ("1. [x] label") hangs under its label; anything else as wrapTo does it.
    const item = /^ *\d+\. \[[x ]\] /.exec(s);
    return wrapTo(s, cols(), item ? { hang: item[0].trimStart().length } : {});
  };
  const say = (s: string): void => term.write(fit(s).map((l) => l + "\n").join(""));
  /** A question: the lines before its last one are printed, the last one is the prompt (with room for the answer). */
  const ask = (q: string): Promise<string | null> => {
    const ls = wrapTo(q.trimEnd(), Math.max(1, cols() - 4));
    if (ls.length > 1) term.write(ls.slice(0, -1).map((l) => l + "\n").join(""));
    return term.readLine(ls.at(-1)! + (q.endsWith(" ") ? " " : ""));
  };
  const original = rows.map((r) => ({ checked: r.checked, value: r.value }));
  const show = (): void => {
    say(c.title);
    if (c.help !== "") say(c.help);
    say("");
    rows.forEach((r, i) => {
      const text = r.value !== null ? `${r.label} -> ${r.shownValue}` : r.label;
      say(`${String(i + 1).padStart(String(rows.length).length)}. ${r.checked ? "[x]" : "[ ]"} ${text}${r.meta !== "" ? `  (${r.meta})` : ""}`);
      if (r.detail !== "") say(`${" ".repeat(String(rows.length).length + 2)}${r.detail}`);
    });
    if (rows.length === 0) say(m.listEmpty);
    say("");
    say(m.listPlainMore);
  };
  const out = (confirmed: boolean): ListResult => ({
    confirmed,
    items: rows.map((r, i) => {
      const o: ListItem = { ...r.src, checked: confirmed ? r.checked : original[i]!.checked };
      if (r.src.editable) o.editable = { ...r.src.editable, value: confirmed && r.value !== null ? r.value : r.src.editable.value };
      return o;
    }),
  });

  try {
    return await plainLoop();
  } finally {
    term.dispose?.();
  }

  async function plainLoop(): Promise<ListResult> {
  show();
  for (;;) {
    const line = await ask(`${m.listPlainPrompt}: `);
    if (line === null) return out(false);
    const t = line.trim();
    if (t === "") return out(true);
    const lower = t.toLowerCase();
    if (lower === "q") return out(false);
    if (lower === "a" || lower === "n") { for (const r of rows) r.checked = lower === "a"; show(); continue; }
    const ed = /^e\s*(\d+)$/i.exec(t);
    if (ed) {
      const n = Number(ed[1]);
      const r = rows[n - 1];
      if (r === undefined) { say(fmt(m.listPlainBad, { text: shownText(t, 40) })); continue; }
      if (r.value === null) { say(fmt(m.listPlainNoEdit, { n })); continue; }
      if (r.choices.length > 0) {
        r.choices.forEach((ch, i) => say(`  ${i + 1}. ${ch}`));
        const ans = await ask(m.listPlainChoiceAsk);
        if (ans === null) return out(false);
        if (ans.trim() === "") continue;
        const pick = parseNumbers(ans.trim(), r.choices.length);
        const v = pick && pick.length === 1 ? r.src.editable!.choices?.[pick[0]! - 1] : undefined;
        if (v === undefined) say(m.listPlainBadChoice);
        else { r.value = v; r.shownValue = r.choices[pick![0]! - 1]!; }
      } else {
        const ans = await ask(fmt(m.listPlainEditAsk, { prompt: r.prompt, value: r.shownValue }));
        if (ans === null) return out(false);
        const v = cleanText(ans);
        if (v !== "") { r.value = v; r.shownValue = shownText(v); }
      }
      continue;
    }
    const nums = parseNumbers(t, rows.length);
    if (nums === null || nums.length === 0) { say(fmt(m.listPlainBad, { text: shownText(t, 40) })); continue; }
    for (const n of nums) rows[n - 1]!.checked = !rows[n - 1]!.checked;
    show();
  }
  }
}
