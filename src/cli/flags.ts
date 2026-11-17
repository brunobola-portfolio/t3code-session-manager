// The options each command accepts, in one place: the commands' parsers read their lists from here, and a test checks
// that every option a help text shows (src/cli/help.en.ts, help.pt.ts) is one of them and that each one is documented.
// The global options (--lang, --no-color) are parsed by main for every command and are not repeated per command.

/** Options without a value, and options that take one (`--run <id>`), per command. */
export const FLAG_SPECS = {
  doctor: { bool: ["--json", "--repair"], valued: [] },
  scan: { bool: ["--json"], valued: [] },
  plan: { bool: ["--json", "--allow-untested", "--html"], valued: [] },
  stats: { bool: ["--json"], valued: [] },
  accounts: { bool: ["--init", "--force", "--apply", "--yes", "--allow-untested", "--show-emails"], valued: ["--rename", "--color"] },
  apply: { bool: ["--yes", "--allow-untested", "--quiet", "--dry-run", "--verbose"], valued: ["--plan", "--only"] },
  quarantine: { bool: ["--yes", "--dry-run"], valued: [] },
  dedupe: { bool: ["--yes", "--dry-run"], valued: ["--plan"] },
  rollback: { bool: ["--yes", "--dry-run", "--instances", "--archive-threads", "--allow-untested"], valued: ["--run"] },
  runs: { bool: ["--json"], valued: [] },
  sync: { bool: ["--quiet", "--allow-untested", "--watch", "--dry-run", "--verbose"], valued: [] },
  schedule: { bool: ["--watch", "--dry-run", "--yes"], valued: [] },
  merge: { bool: ["--all", "--dry-run", "--yes", "--allow-untested"], valued: ["--session"] },
  recover: { bool: ["--yes", "--dry-run", "--allow-untested"], valued: [] },
  projects: { bool: ["--json", "--allow-untested", "--yes", "--dry-run", "--force", "--suggest"], valued: [] },
  start: { bool: [], valued: [] },
  update: { bool: ["--yes", "--dry-run", "--check", "--auto-run"], valued: ["--from", "--source", "--auto"] },
  changelog: { bool: [], valued: ["--since"] },
  organize: {
    bool: ["--dry-run", "--yes", "--allow-untested", "--plain", "--no-delete", "--no-archive-folders"],
    valued: ["--undo", "--only", "--auto-settle", "--history", "--min", "--no-pin"],
  },
  status: { bool: ["--json"], valued: [] },
  journal: { bool: ["--yes", "--dry-run"], valued: ["--older-than"] },
  help: { bool: [], valued: [] },
} as const satisfies Record<string, { bool: readonly string[]; valued: readonly string[] }>;

export type CommandName = keyof typeof FLAG_SPECS;

/** `t3sm projects` per subcommand (the table, set, unset, rename); together they are FLAG_SPECS.projects. */
export const PROJECTS_FLAGS = {
  list: ["--json", "--allow-untested"],
  set: ["--yes", "--dry-run", "--force", "--allow-untested"],
  unset: ["--dry-run"],
  rename: ["--suggest", "--yes", "--dry-run", "--allow-untested"],
} as const satisfies Record<string, readonly string[]>;

/** Every option a command accepts (with and without a value). */
export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(FLAG_SPECS).map(([k, v]) => [k, [...v.bool, ...v.valued]]),
);

/** The options of every command, parsed by main. */
export const GLOBAL_FLAGS: readonly string[] = ["--lang", "--no-color", "--help", "-h"];

/** A command's options as the mutable lists `parseFlags` takes. */
export function flagsOf(cmd: CommandName): { bool: string[]; valued: string[] } {
  return { bool: [...FLAG_SPECS[cmd].bool], valued: [...FLAG_SPECS[cmd].valued] };
}
