// The terminal as the review screens see it: a small injectable surface (size, colour, write, keys, raw mode, one
// line of input) so tests drive them with a fake, plus the Node implementation. Zero dependencies: `readline` and raw
// mode only.

import { createInterface, emitKeypressEvents } from "node:readline";
import { detectCaps, detectUnicode, type Caps } from "./caps.ts";

/**
 * One key press. `name` is the key's name for special keys ("up", "down", "pageup", "pagedown", "home", "end",
 * "return", "escape", "space", "backspace", "tab") and the letter for plain ones; `ch` is the typed text ("" for a
 * special key without one).
 */
export interface TermKey { name: string; ch: string; ctrl: boolean; meta: boolean }

export interface Term {
  /** Both input and output are a terminal. */
  isTTY: boolean;
  /** Read at every frame (the window can be resized). */
  columns: number;
  rows: number;
  /** Colours allowed (`caps.color > 0`): NO_COLOR, TERM=dumb and a missing TTY turn them off, FORCE_COLOR forces them. */
  color: boolean;
  /** Everything detected about the terminal, set by nodeTerm (colour depth, Unicode, TTY, columns at creation). */
  caps?: Caps;
  /** Unicode symbols are safe (otherwise the screens draw ASCII). */
  unicode: boolean;
  write(s: string): void;
  /** Key presses until the returned function is called. `onEnd` runs once when the input ends or closes. */
  onKey(cb: (k: TermKey) => void, onEnd?: () => void): () => void;
  /** Raw mode on / off. Turning it off also stops reading keys. Safe to call twice. */
  setRaw(on: boolean): void;
  /** One line after `question`; null when the input closed (or Ctrl+C). */
  readLine(question: string): Promise<string | null>;
  /** Releases what readLine opened (one input interface for the term's lifetime). Safe to call twice. */
  dispose?(): void;
}

/** The Term's capabilities: `term.caps` when present, else rebuilt from its colour/unicode/isTTY/columns fields (test fakes). */
export function capsOf(term: Term): Caps {
  if (term.caps) return term.caps;
  return { color: term.color ? 1 : 0, unicode: term.unicode, isTTY: term.isTTY, columns: term.columns || 80 };
}

/** Node's keypress event as a TermKey. */
export function toTermKey(str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } | undefined): TermKey {
  const ctrl = key?.ctrl === true;
  const meta = key?.meta === true;
  const raw = key?.name ?? str ?? "";
  const name = raw === "enter" ? "return" : raw; // a bare 

  const ch = str !== undefined && str.length > 0 && !ctrl && !meta && str >= " " && str !== "\x7f" ? str : "";
  return { name, ch, ctrl, meta };
}

export { detectUnicode };

export interface NodeTermOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where the exit hook goes (default: the process). */
  proc?: { once(ev: "exit", cb: () => void): unknown; off(ev: "exit", cb: () => void): unknown };
}

export function nodeTerm(o: NodeTermOptions = {}): Term {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  const caps = detectCaps(env, platform, { isTTY, columns: stdout.columns, hasColors: typeof stdout.hasColors === "function" ? (n) => stdout.hasColors(n) : undefined });
  const proc = o.proc ?? process;
  let keysWired = false;
  let raw = false;
  // A process.exit or a signal skips the screens' own cleanup: while raw mode is on, an exit hook gives the terminal back.
  const onExit = (): void => {
    try { stdout.write("[?25h"); } catch { /* gone */ }
    if (raw) { try { stdin.setRawMode(false); } catch { /* gone */ } raw = false; }
  };
  // One input interface for the term's lifetime: lines that arrive together (piped input) are queued, not lost.
  let rl: ReturnType<typeof createInterface> | null = null;
  const queue: string[] = [];
  const waiters: ((l: string | null) => void)[] = [];
  const open = (): void => {
    if (rl !== null) return;
    const r = createInterface({ input: stdin, crlfDelay: Infinity });
    rl = r;
    r.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
    r.on("close", () => { rl = null; for (const w of waiters.splice(0)) w(null); });
    r.on("SIGINT", () => r.close());
  };
  return {
    isTTY,
    get columns() { return stdout.columns || 80; },
    get rows() { return stdout.rows || 24; },
    color: caps.color > 0,
    caps,
    unicode: caps.unicode,
    write: (s) => void stdout.write(s),
    onKey(cb, onEnd) {
      if (!keysWired) { emitKeypressEvents(stdin); keysWired = true; }
      const h = (str: string | undefined, key: Parameters<typeof toTermKey>[1]): void => cb(toTermKey(str, key));
      let ending = false;
      const end = (): void => { if (!ending) { ending = true; onEnd?.(); } };
      stdin.on("keypress", h);
      if (onEnd) { stdin.once("end", end); stdin.once("close", end); }
      return () => { stdin.off("keypress", h); stdin.off("end", end); stdin.off("close", end); };
    },
    setRaw(on) {
      if (!isTTY || typeof stdin.setRawMode !== "function") return;
      stdin.setRawMode(on);
      if (on) { stdin.resume(); if (!raw) proc.once("exit", onExit); raw = true; }
      else { stdin.pause(); proc.off("exit", onExit); raw = false; }
    },
    readLine(question) {
      stdout.write(question);
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (stdin.readableEnded) return Promise.resolve(null);
      open();
      return new Promise((resolve) => void waiters.push(resolve));
    },
    dispose() { const r = rl; rl = null; queue.length = 0; r?.close(); },
  };
}
