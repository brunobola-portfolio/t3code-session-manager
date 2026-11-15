// Progress feedback: a bar (one line redrawn in place on a TTY, milestone lines otherwise) and a spinner for waits over
// 300 ms. Both take the terminal, the style, and an injected clock; both leave the terminal clean when the process is
// interrupted (exit hook and SIGINT), which is why the cursor is only ever hidden while one of them is active.

import type { Fmt } from "./locale.ts";
import type { Style } from "./style.ts";
import { capsOf, type Term } from "./terminal.ts";
import { displayWidth, truncateEnd, wrapText } from "./text.ts";

export interface ProgressSink {
  start(total: number, label: string): void;
  tick(done: number, note?: string): void;
  end(summary: string): void;
  /** A notice line printed above the bar while it runs: clears the bar, prints, redraws. Plain line without cursor control. */
  note(line: string): void;
  /**
   * Releases the exit/SIGINT hooks and restores the cursor when the bar is still active (idempotent). Callers wrap the work
   * in try/finally: `try { bar.start(..); ...; bar.end(..) } finally { bar.dispose() }`.
   */
  dispose(): void;
}

/** The slice of `process` the hooks need; injected so tests can fire the events. */
export interface ExitProc {
  once(ev: string, cb: () => void): unknown;
  off(ev: string, cb: () => void): unknown;
  listenerCount?(ev: string): number;
  exit?(code: number): void;
}

export interface ProgressOptions {
  proc?: ExitProc;
  /**
   * The catalogue words for "time left": a template with `{t}` for the time ("{t} left" / "faltam {t}"), or a word put
   * before it. The language is passed in, never guessed.
   */
  words: { left: string };
  /** The milestone line that starts a bar off a terminal ends with the total, "(412)" (default true). */
  showTotal?: boolean;
}

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[K";

/**
 * Runs `abort` once when the process exits, and on SIGINT when nothing else handles it (then exits 130). When another
 * SIGINT owner exists (a graceful stop-after-this-wave handler) the bar or spinner keeps working: only the exit hook
 * stays, so the cursor is still restored when the process ends. Returns the unhook.
 */
function hookExit(proc: ExitProc, abort: () => void, release: () => void): () => void {
  const onExit = (): void => { unhook(); abort(); };
  const onSigint = (): void => {
    if ((proc.listenerCount?.("SIGINT") ?? 0) > 0) {
      // Someone else owns Ctrl+C. It may re-raise the signal once it is the last listener, and death by signal emits no
      // "exit": give the cursor back now. The bar or spinner stays usable.
      release();
      return;
    }
    onExit();
    proc.exit?.(130);
  };
  const unhook = (): void => { proc.off("exit", onExit); proc.off("SIGINT", onSigint); };
  proc.once("exit", onExit);
  proc.once("SIGINT", onSigint);
  return unhook;
}

/**
 * Control, format, line / paragraph separator, surrogate and private-use characters (ESC, CR/LF, bidi overrides such as
 * U+202E, U+2028, U+2029, ...) become one space: progress text is safe by itself. U+200D (zero-width joiner) and the
 * emoji tag characters U+E0020 to U+E007F stay, so an emoji sequence joined by a ZWJ, or a subdivision flag, is kept whole.
 */
const flat = (s: string): string => s.replace(/(?:(?![\u200D\u{E0020}-\u{E007F}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}])+/gu, " ");
/** Cursor control available: a TTY that is not TERM=dumb. */
const canRedraw = (t: Term): boolean => { const c = capsOf(t); return c.cursor ?? c.isTTY; };

export function progressBar(t: Term, s: Style, fmt: Fmt, clock: () => number, o: ProgressOptions): ProgressSink {
  const proc: ExitProc = o.proc ?? process;
  const left = o.words.left;
  const sep = ` ${s.sym.sep} `;
  const ell = s.sym.ellipsis;
  let active = false;
  let total = 0;
  let label = "";
  let startMs = 0;
  let lastDraw = -Infinity;
  let lastCols = -1;
  let lastStep = 0;
  let unhook: (() => void) | null = null;
  let live = false;
  let lastDone = 0;
  let lastNote: string | undefined;

  const bar = (done: number, w: number): string => {
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    const full = Math.round(w * ratio);
    return s("muted", s.sym.barL) + s("accent", s.sym.barFull.repeat(full)) + s("muted", s.sym.barEmpty.repeat(w - full) + s.sym.barR);
  };

  /** The most informative single line that fits `limit` cells. */
  const line = (done: number, note: string | undefined, limit: number): string => {
    const elapsed = clock() - startMs;
    const counts = `${fmt.n(done)}/${fmt.n(total)}`;
    const rate = elapsed >= 1000 && done > 0 ? (done * 1000) / elapsed : 0;
    const rateText = rate > 0 ? (rate >= 1 ? `${fmt.n(rate)}/s` : "<1/s") : "";
    const eta = (d: string): string => (left.includes("{t}") ? left.replace("{t}", d) : `${left} ${d}`);
    const etaText = rate > 0 && done < total ? eta(fmt.dur(((total - done) / rate) * 1000)) : "";
    const stats = (withRate: boolean, withEta: boolean): string => counts + (withRate && rateText ? sep + rateText : "") + (withEta && etaText ? sep + etaText : "");
    const tries: [number, boolean, boolean][] = [[20, true, true], [12, true, true], [12, true, false], [10, false, false], [6, false, false]];
    for (const [bw, r, e] of tries) {
      const st = stats(r, e);
      const used = bw + 2 + 1 + displayWidth(st);
      if (used > limit) continue;
      const text = note ?? label;
      const room = limit - used - displayWidth(sep);
      const tail = text !== "" && room >= 6 ? s("muted", sep + truncateEnd(flat(text), room, ell)) : "";
      return bar(done, bw) + " " + s("num", st) + tail;
    }
    return s("num", truncateEnd(counts, limit, ell));
  };

  const draw = (done: number, note: string | undefined, force: boolean): void => {
    const cols = t.columns || 80;
    const now = clock();
    if (!force && cols === lastCols && now - lastDraw < 33) return;
    lastDraw = now;
    lastCols = cols;
    lastDone = done;
    lastNote = note;
    t.write("\r" + line(done, note, Math.max(1, cols - 1)) + "\x1b[K");
  };

  const abort = (): void => {
    if (!active) return;
    active = false;
    unhook?.();
    unhook = null;
    if (live) t.write(SHOW + "\n");
  };

  const milestone = (text: string): void => t.write(truncateEnd(flat(text), Math.max(1, t.columns || 80), ell) + "\n");

  return {
    start(n, l) {
      unhook?.(); // a second start must not leak the first one's hooks
      unhook = null;
      active = true;
      live = canRedraw(t);
      total = Math.max(0, n);
      label = l;
      startMs = clock();
      lastStep = 0;
      lastDraw = -Infinity;
      if (live) {
        t.write(HIDE);
        unhook = hookExit(proc, abort, () => t.write(SHOW));
        draw(0, undefined, true);
      } else milestone(total > 0 && o.showTotal !== false ? `${l} (${fmt.n(total)})` : l);
    },
    tick(done, note) {
      if (!active) return;
      if (live) { draw(done, note, done >= total && total > 0); return; }
      if (total <= 0) return;
      const step = Math.min(90, Math.floor((done * 10) / total) * 10);
      if (step > lastStep) {
        lastStep = step;
        milestone(`  ${step}%  ${fmt.n(done)}/${fmt.n(total)}${note ? sep + note : ""}`);
      }
    },
    end(summary) {
      if (!active) return;
      active = false;
      unhook?.();
      unhook = null;
      const cols = Math.max(2, t.columns || 80);
      // Off a cursor terminal the summary is one line, so the 12-line cap holds.
      if (live) t.write(CLEAR + wrapText(flat(summary), cols - 1).join("\n") + "\n" + SHOW);
      else {
        const all = wrapText(flat(summary), cols);
        const two = all.length > 2 ? [all[0]!, truncateEnd(all.slice(1).join(" "), cols, ell)] : all;
        t.write(two.join("\n") + "\n");
      }
    },
    note(text) {
      const lines = wrapText(flat(text), Math.max(1, (t.columns || 80) - 1)).join("\n") + "\n";
      if (active && live) { t.write(CLEAR + lines); draw(lastDone, lastNote, true); }
      else t.write(lines);
    },
    dispose: abort,
  };
}

export interface SpinnerOptions { proc?: ExitProc; /** Frame period (default 80 ms). */ intervalMs?: number }

/**
 * A spinner for a wait of unknown length. Silent for the first 300 ms (by `clock`) and never drawn without cursor control
 * (no TTY, TERM=dumb). `stop(final)` always prints `final` as a line: replacing the spinner line when it was shown, plainly
 * otherwise. Safe to stop twice; `dispose()` stops without a final line (use it in a finally).
 */
export function spinner(t: Term, s: Style, label: string, clock: () => number, o: SpinnerOptions = {}): { stop(final?: string): void; dispose(): void } {
  if (!canRedraw(t)) {
    let done = false;
    return { stop(final) { if (!done && final) t.write(flat(final) + "\n"); done = true; }, dispose() { done = true; } };
  }
  const proc: ExitProc = o.proc ?? process;
  const start = clock();
  const frames = [...s.sym.spin];
  let i = 0;
  let shown = false;
  let stopped = false;
  let unhook: (() => void) | null = null;
  const abort = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unhook = null;
    if (shown) t.write(CLEAR + SHOW);
  };
  const timer = setInterval(() => {
    if (stopped || clock() - start < 300) return;
    if (!shown) { shown = true; t.write(HIDE); unhook = hookExit(proc, abort, () => t.write(SHOW)); }
    const room = Math.max(1, (t.columns || 80) - 3);
    t.write("\r" + s("accent", frames[i++ % frames.length]!) + " " + truncateEnd(flat(label), room, s.sym.ellipsis) + "\x1b[K");
  }, o.intervalMs ?? 80);
  timer.unref();
  const stop = (final?: string): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unhook?.();
      unhook = null;
      if (shown) t.write(CLEAR + (final ? flat(final) + "\n" : "") + SHOW);
      else if (final) t.write(flat(final) + "\n");
  };
  return { stop, dispose: () => stop() };
}
