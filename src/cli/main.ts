import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describeError, renderError } from "./errors.ts";
import { resolveLang, type Lang } from "../assistant/i18n.ts";
import { loadConfig } from "../core/config.ts";
import { stateDir } from "../core/paths.ts";
import { detectCaps, type Caps } from "../ui/caps.ts";
import { cliUi, parseGlobalFlags, unknownOption, usageLine } from "./ui.ts";
import { scanCommand } from "./commands/scan.ts";
import { planCommand } from "./commands/plan.ts";
import { statsCommand } from "./commands/stats.ts";
import { accountsCommand } from "./commands/accounts.ts";
import { applyCommand } from "./commands/apply.ts";
import { dedupeCommand, quarantineCommand } from "./commands/quarantine.ts";
import { rollbackCommand, runsCommand } from "./commands/rollback.ts";
import { syncCommand } from "./commands/sync.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { mergeCommand } from "./commands/merge.ts";
import { recoverCommand } from "./commands/recover.ts";
import { projectsCommand } from "./commands/projects.ts";
import { startCommand } from "./commands/start.ts";
import { updateCommand } from "./commands/update.ts";
import { changelogCommand } from "./commands/changelog.ts";
import { organizeCommand } from "./commands/organize.ts";
import { statusCommand } from "./commands/status.ts";
import { helpCommand } from "./commands/help.ts";
import { journalCommand } from "./commands/journal.ts";
import { commandHelp, renderHelpText, usageHelp } from "./helpText.ts";

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  isTTY: boolean;
  prompt(q: string): Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Called when a writing command found the lock taken and did nothing (cli/locked.ts); the assistant listens. */
  onLockBusy?: () => void;
  /**
   * The language of the human text, resolved once in main: --lang > T3SM_LANG > config.json "language" > LC_ALL >
   * LC_MESSAGES > LANG > the OS locale > en. Absent (a test, a direct call): English. `t3sm start` resolves its own.
   */
  lang?: Lang;
  /** --lang as given on the command line (main takes it out of argv; the assistant offers to save it). */
  langFlag?: Lang;
  /** What the terminal can do, resolved once in main (--no-color and NO_COLOR give colour 0). Absent: detected from env and isTTY. */
  caps?: Caps;
}

export type CommandHandler = (args: string[], io: Io) => Promise<number>;

/** Later tasks register their commands here. */
export const commands: Record<string, CommandHandler> = {
  doctor: (a, io) => doctorCommand(a, io),
  scan: (a, io) => scanCommand(a, io),
  plan: (a, io) => planCommand(a, io),
  stats: (a, io) => statsCommand(a, io),
  accounts: (a, io) => accountsCommand(a, io),
  apply: (a, io) => applyCommand(a, io),
  quarantine: (a, io) => quarantineCommand(a, io),
  dedupe: (a, io) => dedupeCommand(a, io),
  rollback: (a, io) => rollbackCommand(a, io),
  runs: (a, io) => runsCommand(a, io),
  sync: (a, io) => syncCommand(a, io),
  schedule: (a, io) => scheduleCommand(a, io),
  merge: (a, io) => mergeCommand(a, io),
  recover: (a, io) => recoverCommand(a, io),
  projects: (a, io) => projectsCommand(a, io),
  start: (a, io) => startCommand(a, io, { main }),
  update: (a, io) => updateCommand(a, io),
  changelog: (a, io) => changelogCommand(a, io),
  organize: (a, io) => organizeCommand(a, io),
  status: (a, io) => statusCommand(a, io),
  journal: (a, io) => journalCommand(a, io),
  help: (a, io) => helpCommand(a, io),
};

/** A help text (src/cli/help.en.ts, help.pt.ts) in the Io's language, styled and fitted to its width. */
function printHelp(io: Io, text: (lang: Lang) => string): void {
  const ui = cliUi(io);
  io.stdout(renderHelpText(ui, text(ui.lang)).join("\n") + "\n");
}

function readVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

/** An error as the error panel (what happened, what to do, the command that helps), in the Io's language; its exit code. */
function report(e: unknown, io: Io): number {
  const { code } = describeError(e);
  io.stderr(renderError(e, cliUi(io)).join("\n") + "\n");
  return code;
}

/** config.json "language" of the state folder, or null (missing or unreadable config: doctor reports that). */
async function configLanguage(env: NodeJS.ProcessEnv): Promise<unknown> {
  const home = homedir();
  return loadConfig(stateDir(env, home), home).then((c) => c?.language ?? null, () => null);
}

/**
 * The Io a command runs with: its language and capabilities resolved once. `start` gets only the flag (it resolves the
 * language itself, with the config of its own home). --no-color also sets NO_COLOR, so every command and child honours it.
 */
async function withUi(io: Io, g: { lang: Lang | null; noColor: boolean }, command: string): Promise<Io> {
  const env = g.noColor ? { ...io.env, NO_COLOR: "1" } : io.env;
  const out = process.stdout;
  const detected = io.caps ?? detectCaps(env, process.platform, {
    isTTY: io.isTTY, columns: io.isTTY ? out.columns : undefined,
    hasColors: io.isTTY && typeof out.hasColors === "function" ? (n) => out.hasColors(n) : undefined,
  });
  const caps: Caps = g.noColor ? { ...detected, color: 0 } : detected;
  const flag = g.lang ?? io.langFlag;
  const lang = command === "start" ? (g.lang ?? io.lang) : g.lang ?? io.lang ?? resolveLang(null, env, await configLanguage(env));
  return { ...io, env, caps, ...(lang ? { lang } : {}), ...(flag ? { langFlag: flag } : {}) };
}

export async function main(rawArgv: string[], io: Io): Promise<number> {
  // The global options (--lang, --no-color) are parsed here, once, and taken out of argv.
  const g = parseGlobalFlags(rawArgv);
  if ("error" in g) { io.stderr(g.error); return 2; }
  const argv = g.rest;
  // Plain `t3sm` on a terminal: the guided assistant. Not on a terminal: the usage, as always.
  if (argv.length === 0 && io.isTTY) {
    const uio = await withUi(io, g, "start");
    try { return await commands["start"]!([], uio); } catch (e) { return report(e, uio); }
  }
  const i = argv.findIndex((a) => !a.startsWith("-"));
  const lead = i === -1 ? argv : argv.slice(0, i);
  for (const f of lead) {
    if (f === "-h" || f === "--help" || f === "-v" || f === "--version") continue;
    unknownOption(await withUi(io, g, "help"), f, null);
    return 2;
  }
  if (i === -1) {
    if (lead.includes("-v") || lead.includes("--version")) io.stdout(`${readVersion()}\n`);
    else printHelp(await withUi(io, g, "help"), usageHelp);
    return 0;
  }
  const name = argv[i]!;
  const wantsHelp = lead.includes("-h") || lead.includes("--help") || argv.slice(i + 1).some((a) => a === "-h" || a === "--help");
  if (wantsHelp && commandHelp(name, "en") !== null) {
    printHelp(await withUi(io, g, "help"), (lang) => commandHelp(name, lang)!);
    return 0;
  }
  const handler = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!handler) {
    usageLine(await withUi(io, g, "help"), "common.unknownCommand", { name });
    return 2;
  }
  const uio = await withUi(io, g, name);
  try {
    // Everything after the command name, including flags (but the global ones), goes to the handler.
    return await handler(argv.slice(i + 1), uio);
  } catch (e) {
    return report(e, uio);
  }
}
