// What every command prints with: the language, its catalogue, the style (colour and symbols), the locale formatter
// and the width, from the Io that `main` set up once (`Io.lang`, `Io.caps`: the global --lang and --no-color). Also the
// one parser of those global flags, and the one yes/no confirmation every writing command asks through.
//
// An Io without `lang` (a test, or a caller that bypasses main) is English; without `caps`, the capabilities are
// detected from its env and isTTY. --json, plan.md, journal.jsonl and logs/sync.log never go through here.

import { isLang, resolveLang, type Lang } from "../assistant/i18n.ts";
import { detectCaps, type Caps } from "../ui/caps.ts";
import type { Term } from "../ui/terminal.ts";
import { cliT, makeCliUi, type CliKey, type CliUi } from "../i18n/cli.ts";
import type { Io } from "./main.ts";

// The catalogues live in src/i18n/cli.ts (ops/ and plan/ use them without importing the CLI); re-exported here.
export { CLI_CATALOGUES, cliT, isCliKey, makeCliUi, type CliCatalogue, type CliKey, type CliUi } from "../i18n/cli.ts";

/**
 * The language of an Io for something that depends on it beyond text (the General folder's default name): main's
 * `Io.lang`, else resolved from the Io's env and config.json "language" (a direct call that bypassed main).
 */
export function langOf(io: { lang?: Lang; env: NodeJS.ProcessEnv }, configLang: unknown): Lang {
  return io.lang ?? resolveLang(null, io.env, configLang);
}

/** The capabilities of an Io:what main resolved, else detected from its env and isTTY (colour only on a TTY). */
export function capsOfIo(io: Io, platform: NodeJS.Platform = process.platform): Caps {
  return io.caps ?? detectCaps(io.env, platform, { isTTY: io.isTTY });
}

export function cliUi(io: Io, o: { now?: () => number; platform?: NodeJS.Platform } = {}): CliUi {
  return makeCliUi(capsOfIo(io, o.platform), io.lang ?? "en", o.now ?? Date.now);
}

/**
 * The Io's stdout as the progress bar's terminal: its width (read again at every frame on a TTY, the window can be
 * resized), its capabilities, and writes to io.stdout. Keys and line input are not part of it (never asked here).
 */
export function ioTerm(io: Io, ui: CliUi): Term {
  const caps = ui.s.caps;
  return {
    isTTY: io.isTTY,
    get columns() { return (io.isTTY ? process.stdout.columns : undefined) || caps.columns || 80; },
    rows: 24,
    color: caps.color > 0,
    caps,
    unicode: caps.unicode,
    write: (s) => io.stdout(s),
    onKey: () => () => undefined,
    setRaw: () => undefined,
    readLine: async () => null,
  };
}

export type GlobalFlags = { lang: Lang | null; noColor: boolean; rest: string[] } | { error: string };

/**
 * The global options, anywhere on the command line: `--lang en|pt` (or `--lang=pt`) and `--no-color`. They are taken
 * out of argv, so no command has to know them. `--` ends them: it and everything after it go to the command as they
 * are. An invalid --lang is a usage error, worded in English (the language is not known yet).
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  let lang: Lang | null = null;
  let noColor = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { rest.push(...argv.slice(i)); break; }
    if (a === "--no-color") { noColor = true; continue; }
    if (a === "--lang" || a.startsWith("--lang=")) {
      const v = a === "--lang" ? argv[++i] : a.slice("--lang=".length);
      if (!isLang(v)) return { error: "--lang must be en or pt. Run `t3sm --help`.\n" };
      lang = v;
      continue;
    }
    rest.push(a);
  }
  return { lang, noColor, rest };
}

/** A usage error or a refusal, on stderr in the Io's language (the caller returns exit 2). */
export function usageLine(io: { lang?: Lang; stderr(s: string): void }, key: CliKey, vars: Record<string, string | number> = {}): void {
  io.stderr(`${cliT(io.lang ?? "en", key, vars)}\n`);
}

/** "Unknown option: <a>. Run t3sm <command> --help." in the Io's language. */
export function unknownOption(io: { lang?: Lang; stderr(s: string): void }, option: string, command: string | null): void {
  usageLine(io, "common.unknownOption", { option, help: command === null ? "t3sm --help" : `t3sm ${command} --help` });
}

const YES = new Set(["yes", "y"]);
const YES_PT = new Set(["sim", "s"]);

function isYes(io: Io, answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return YES.has(a) || ((io.lang ?? "en") === "pt" && YES_PT.has(a));
}

/**
 * The yes/no question of every writing command: "<question> Type yes to continue: " ("Escreve sim para continuar: "
 * in Portuguese). Only yes / y (and in Portuguese sim / s) go ahead; Enter, anything else, Ctrl+C or closed input is no.
 */
export async function confirm(io: Io, question: string): Promise<boolean> {
  return isYes(io, await io.prompt(`${question} ${cliT(io.lang ?? "en", "confirm.typeYes")}`));
}

/** confirm, with d (details) as a third answer. */
export async function confirmOrDetails(io: Io, question: string): Promise<"yes" | "no" | "details"> {
  const a = await io.prompt(`${question} ${cliT(io.lang ?? "en", "confirm.typeYesOrDetails")}`);
  if (a.trim().toLowerCase() === "d") return "details";
  return isYes(io, a) ? "yes" : "no";
}
