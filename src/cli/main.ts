import { readFileSync } from "node:fs";
import { describeError } from "./errors.ts";
import { scanCommand } from "./commands/scan.ts";
import { planCommand } from "./commands/plan.ts";
import { accountsCommand } from "./commands/accounts.ts";
import { applyCommand } from "./commands/apply.ts";
import { dedupeCommand, quarantineCommand } from "./commands/quarantine.ts";
import { rollbackCommand, runsCommand } from "./commands/rollback.ts";
import { syncCommand } from "./commands/sync.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { mergeCommand } from "./commands/merge.ts";
import { projectsCommand } from "./commands/projects.ts";
import { startCommand } from "./commands/start.ts";
import { updateCommand } from "./commands/update.ts";

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  isTTY: boolean;
  prompt(q: string): Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Called when a writing command found the lock taken and did nothing (cli/locked.ts); the assistant listens. */
  onLockBusy?: () => void;
}

export type CommandHandler = (args: string[], io: Io) => Promise<number>;

/** Later tasks register their commands here. */
export const commands: Record<string, CommandHandler> = {
  doctor: (a, io) => doctorCommand(a, io),
  scan: (a, io) => scanCommand(a, io),
  plan: (a, io) => planCommand(a, io),
  accounts: (a, io) => accountsCommand(a, io),
  apply: (a, io) => applyCommand(a, io),
  quarantine: (a, io) => quarantineCommand(a, io),
  dedupe: (a, io) => dedupeCommand(a, io),
  rollback: (a, io) => rollbackCommand(a, io),
  runs: (a, io) => runsCommand(a, io),
  sync: (a, io) => syncCommand(a, io),
  schedule: (a, io) => scheduleCommand(a, io),
  merge: (a, io) => mergeCommand(a, io),
  projects: (a, io) => projectsCommand(a, io),
  start: (a, io) => startCommand(a, io, { main }),
  update: (a, io) => updateCommand(a, io),
};

const USAGE = `t3sm brings your Claude Code, Codex, Pi and OpenCode sessions into T3 Code.

Usage: t3sm [command] [options]

Start here
  t3sm                   Guided set-up, step by step (\`t3sm start --lang pt\` in Portuguese)

Import
  t3sm doctor            Check this machine, T3 Code and the accounts (read-only)
  t3sm plan              Build the import plan in plan.md (changes no session)
  t3sm apply             Import the planned sessions (--dry-run, --only "<folder>")

Accounts and projects
  t3sm accounts          Your Claude subscriptions and their T3 Code instances
  t3sm projects          The account each project uses (set "<folder>" <account>)

Keep in sync
  t3sm sync              Import what is new since the last run (--watch keeps going)
  t3sm schedule          Run sync in the background: install [--watch] | remove | status
  t3sm merge             Bring sessions continued in a terminal into T3 Code

Clean up and undo
  t3sm quarantine        Move backup folders to a reversible quarantine
  t3sm dedupe            Move the plan's mirror copies to a reversible quarantine
  t3sm runs              List what each run did
  t3sm rollback          Undo a run (--run <id>)

Maintenance
  t3sm scan              Count sessions per agent and account (no T3 Code needed)
  t3sm update            Update t3sm to the newest release
  t3sm --version         Show the version

Every command explains itself: t3sm <command> --help
Commands that write ask first; --dry-run shows what they would do.
`;

const COMMAND_HELP: Record<string, string> = {
  doctor: `Usage: t3sm doctor [--json] [--repair]

Check everything t3sm depends on and say what to fix: Node, the state folder,
config.json, the lock, interrupted runs, the shell's CLAUDE_CONFIG_DIR, T3 Code
(running, version, CLI, a read-only session), its Claude instances and the
account each one is signed in to (emails masked), accounts found on this
machine but missing from config.json, backup and quarantine folders, the
harnesses (Claude Code, Codex, Pi) and the background sync. Read-only: it opens
one read-only T3 Code session and revokes it before exiting. Exit 1 when a
check fails.

Options:
  --json     Print the checks as JSON
  --repair   Restore transcript file times left bumped by an interrupted run
             (takes the lock; the only thing doctor ever writes)
`,
  accounts: `Usage: t3sm accounts [--show-emails] [--allow-untested]
       t3sm accounts --init [--force]
       t3sm accounts --apply [--yes] [--allow-untested]
       t3sm accounts --rename <id> "<Display Name>" [--color "#RRGGBB"]

With no option: read-only table of config accounts against T3 Code instances
(signed-in email, masked like b***@example.com; auth, availability, where each
account was found) with warnings for shared emails, accounts without an
instance, signed-out instances and discovered accounts missing from config.json.

Accounts are discovered from ~/.claude, ~/.claude-* folders, CLAUDE_CONFIG_DIR
in shell profiles (PowerShell, bash, zsh, fish; the alias or function name
becomes the account id), .vscode/settings.json pins, the current shell and the
homes of existing T3 instances. A folder counts only when it holds projects/.

Options:
  --init     Write config.json with every discovered account (never emails)
  --force    With --init, overwrite an existing config.json
  --apply    Create the missing instances and pin claudeAgent to ~/.claude
  --yes      Skip the confirmation (required when not on a terminal)
  --rename   Set the T3 Code picker label (and colour) of an instance, and mirror it in config.json
  --show-emails  Show the signed-in emails in full in the table (masked by default)
`,
  apply: `Usage: t3sm apply [--plan <path>] [--yes | --dry-run] [--only <root>] [--quiet] [--allow-untested]

Import the sessions of a plan into T3 Code: create the missing instances and
projects, set the per-project default account, then import in waves (old
transcripts get a short, journaled file-time bump so T3 Code's own importer
takes them; every time is restored afterwards). Ctrl+C restores the current
wave and stops. Exit 5 when some sessions could not be imported.

Options:
  --plan <path>      Plan to apply (default: the latest runs/*/plan.json)
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Run every check (read-only T3 Code session), print the
                     summary and what would be done, write nothing
  --only <root>      Apply only the sessions of this project folder
  --quiet            No progress output (and nothing when another run holds the lock)
  --allow-untested   Continue with a T3 Code version t3sm was not tested against

T3 Code imports every recent transcript of a project at once, from every
account. So while a project is imported, its other recent transcripts (mirror
and backup copies, excluded ones, later waves) are parked: their file time is
set 7 days into the future, which T3 Code skips, and put back right after (a
crash is repaired by the next t3sm run). A project with a session in use right
now waits for the next run. Mirror copies in the window are reported: run
\`t3sm dedupe\` so T3 Code's own Welcome import cannot take them either.

A plan older than 24 h, or made against another T3 Code version, is refused:
run \`t3sm plan\` again.
`,
  quarantine: `Usage: t3sm quarantine [--yes | --dry-run]

Move the backup folders inside each account's projects/ folder (\`.bak-*\`,
\`<dir>.bak\`, \`<dir>.bak-YYYYMMDD-HHMMSS\`) to
<account home>/session-manager-quarantine/backups/. Nothing is deleted: each
move is a rename on the same drive (file times kept), journaled, and undone
by \`t3sm rollback --run <id>\`. A folder holding a file changed in the last
10 minutes is skipped.

Options:
  --yes       Skip the confirmation (required when not on a terminal)
  --dry-run   Only list what would move
`,
  dedupe: `Usage: t3sm dedupe [--plan <path>] [--yes | --dry-run]

Move the plan's mirror copies (a session copied into a second account that is
identical to, or an older prefix of, the copy that is kept) to
<account home>/session-manager-quarantine/mirror/<project folder>/, together
with the session's sidecar folder. Each copy is compared again right before it
moves; forks, active files and copies whose kept copy is gone are skipped.
Undo with \`t3sm rollback --run <id>\`.

Options:
  --plan <path>   Plan to use (default: the latest runs/*/plan.json; older than 24 h is refused)
  --yes           Skip the confirmation (required when not on a terminal)
  --dry-run       Only list what would move
`,
  merge: `Usage: t3sm merge [--session <id> | --all] [--yes | --dry-run] [--allow-untested]

Bring work continued in a terminal (\`claude --resume\`) into T3 Code. T3 Code
continues an imported thread from the last message IT knows, so terminal turns
made after the import stay invisible there. A merge:
  - creates a NEW session file next to the original (<revision id>.jsonl)
    holding the branch \`claude --resume\` would continue; the original session
    file is never edited;
  - imports it into T3 Code as a new thread, then archives the old T3 thread;
  - is reversible with \`t3sm rollback --run <id>\`.

With neither --session nor --all it only lists the candidates (project,
session, last terminal activity, messages added) and exits 0. A session counts
as continued only on positive evidence: a message after the import written by
another entrypoint than T3 Code. Sessions written in the last 10 minutes wait;
a project with another session in use waits. A compacted session is not
merged (merging compacted sessions is not supported yet), nor one with a broken
message chain. Terminal work on a side branch (not the one \`claude --resume\`
continues) is listed with the \`claude --resume <id>\` hint, never merged.

After a merge: continue in T3 Code on the new thread, or in a terminal with
\`claude --resume <revision id>\` (printed for each merge). The original
session id stays resumable in the terminal but is now a stale branch, and
\`claude --resume\`'s picker shows both. T3 Code titles the new thread from the
transcript; the old thread's title is printed so you can rename it. Never have
the same session open in T3 Code and a terminal at the same time.
Undo with \`t3sm rollback --run <id>\`: an untouched revision is deleted and the
old thread unarchived; a revision continued since is kept (both threads stay).
\`t3sm sync\` only reports pending merges, unless config sync.autoMerge is true
(default false): then it merges them itself.

Options:
  --session <id>     Merge one session (its id, or a unique prefix of 8+ characters)
  --all              Merge every candidate
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Only list the candidates
  --allow-untested   Continue with a T3 Code version t3sm was not tested against
`,
  rollback: `Usage: t3sm rollback [--run <id>] [--yes | --dry-run] [--instances] [--archive-threads] [--allow-untested]

Undo one run. Without --run it shows the latest run that is not itself a
rollback (possibly an unattended sync) and asks; --yes needs --run <id>:
  - converted files it wrote are deleted, unless edited since (then kept and listed);
  - what it quarantined moves back (an original path that exists again is left
    in quarantine and reported);
  - per-project default accounts it set are restored (needs T3 Code running;
    otherwise the file part still runs and the rest is reported).
  - a merge (\`t3sm merge\`): its revision is deleted, its old thread unarchived
    and its revision thread archived; a revision continued since is kept and
    both threads stay as they are (reported).
Imported threads, created instances and projects are listed, never deleted.
Running it twice changes nothing the second time.

Options:
  --run <id>          The run to undo (see \`t3sm runs\`)
  --yes               Skip the confirmation (needs --run; required when not on a terminal)
  --dry-run           Only list what would be undone
  --instances         Also restore instance names, colours and homes the run changed
  --archive-threads   Archive (not delete) the threads the run imported
  --allow-untested    Continue with a T3 Code version t3sm was not tested against
`,
  sync: `Usage: t3sm sync [--quiet] [--allow-untested]
       t3sm sync --watch [--quiet] [--allow-untested]
       t3sm sync --dry-run [--allow-untested]

One unattended cycle: build a fresh plan and apply it without asking. Built to
run from a scheduler, so it is cautious:
  - never creates T3 instances (sessions of a missing account wait for
    \`t3sm accounts --apply\`), never quarantines or dedupes;
  - sessions continued in a terminal since t3sm imported them are reported
    (run \`t3sm merge\`); with sync.autoMerge true (default false) it merges
    them itself when idle 10 min, at most 20 per cycle;
  - a session with a mirror copy inside T3 Code's 30-day window waits for
    \`t3sm dedupe\` (the copy is parked while its project imports);
  - a project with a session in use right now waits for the next cycle;
  - a session whose import failed (and has not changed since) waits for
    \`t3sm apply\`;
  - more than sync.maxUnattendedImports (default 200) pending: nothing is
    imported, one line says to run \`t3sm apply\` once (even with --quiet);
  - a default account you chose in T3 Code is never overridden;
  - nothing to import = nothing written (no journal entry, no run folder).
Exit 3 when T3 Code is not running (silent with --quiet), 0 when another t3sm
run holds the lock, 4 for an untested T3 Code version, 2 when T3 Code's default
Claude instance reads another home. Each cycle appends one line (counts and run
ids only) to <state>/logs/sync.log (rotated at 1 MiB, 3 kept).

Options:
  --quiet            No output except a one-line error (exit 2/4/1/5)
  --watch            Stay resident: watch the transcript folders, run a cycle
                     after changes settle (debounce) and again once a changed
                     session has been idle 10 min, plus every
                     schedule.everyMinutes; waits while T3 Code is closed.
                     Writes <state>/sync-status.json. Ctrl+C stops after the
                     current cycle. A second watcher exits 0.
  --dry-run          Only print what a cycle would import (writes nothing,
                     not even the discovery cache)
  --allow-untested   Continue with a T3 Code version t3sm was not tested against
`,
  schedule: `Usage: t3sm schedule install [--watch] | remove | status

Register \`t3sm sync --quiet\` with the system scheduler, as the current user,
without elevation: Windows Task Scheduler (a task XML in <state>/schedule/:
every schedule.everyMinutes, only while you are logged on, hidden window, never
two at once), a macOS LaunchAgent, or a crontab line tagged "# t3sm". With
--watch the scheduler starts \`t3sm sync --watch --quiet\` at your logon / load /
reboot instead. install and remove can be run any number of times; status shows
the scheduler entry, the command it runs (and whether its paths still exist),
the watcher heartbeat and the last logged cycle.
`,
  start: `Usage: t3sm start [--lang en|pt] [--no-color]

A guided set-up for people who would rather not learn the commands. In nine
short steps it runs t3sm's own commands for you: check (doctor), accounts,
plan and the project-to-account table, clean-up (quarantine, dedupe), a pilot
import of one project, the full import, background sync, and a summary with
the run ids and how to undo them. Before every write it asks, and only y
goes ahead (Enter means no). At any question: ? explains more, b goes back,
q stops; nothing is left half done. Run it again to continue: it works out
where you were from t3sm's own state (journal, plan, config, scheduler).

Plain \`t3sm\` on a terminal starts it too. Not on a terminal, it prints the
quick start and exits 0. Only the assistant is translated; every other command
prints English.

Options:
  --lang en|pt   Language (default English). Also: env T3SM_LANG, or
                 "language": "pt" in config.json; --lang wins, then T3SM_LANG.
  --no-color     No colour (NO_COLOR is honoured too)
`,
  projects: `Usage: t3sm projects [--json] [--allow-untested]
       t3sm projects set "<folder>" <account> [--yes | --dry-run] [--force] [--allow-untested]
       t3sm projects unset "<folder>" [--dry-run]

With no subcommand: a read-only table of every project folder t3sm knows,
with the account its new threads start on, why (route: a rule in config.json;
vscode-pin: .vscode/settings.json; recent-activity: the account of the most
recent session; default: defaultAccount), the sessions waiting to be imported,
whether the project is already in T3 Code (yes, no, archived) and whether a
session of it is in use (an import waits for it). With T3 Code closed it shows
what this machine knows and says so.

projects set "<folder>" <account>
  Writes a route for that exact folder in config.json (or replaces its route
  in place). A new route goes right before the first wildcard route matching
  the folder, so it wins for that folder only: no other folder's account
  changes. When the folder is already a T3 Code project and T3 Code is
  running, it also sets the project's default account there (journaled:
  \`t3sm rollback --run <id>\` undoes it). The route decides where new threads
  start and which account the folder's OpenCode and compressed Codex sessions
  not imported yet go to; Claude Code sessions keep the account they were
  recorded in, and threads already in T3 Code keep theirs. ~ is your home
  folder; a route covers that exact folder, not its sub-folders. Asks first.

projects unset "<folder>"
  Removes that folder's route (wildcard routes are left alone). T3 Code is not
  changed.

Options:
  --json             Print the table as JSON
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Only show the change; write nothing
  --force            With set: accept a folder that does not exist (yet)
  --allow-untested   Continue with a T3 Code version t3sm was not tested against
`,
  update: `Usage: t3sm update [--yes | --dry-run]

Update t3sm to the newest release. For a \`t3sm\` installed with npm it runs
  npm install -g --install-links github:<repository>#semver:*
(npm fetches the highest release tag; t3sm itself contacts nothing), then
prints the old and new versions and whether the background sync needs
\`t3sm schedule install\` again. It asks first and waits while another t3sm
run is in progress. A git checkout or the
npx cache only gets instructions; nothing is installed. Your state folder,
config and journal carry over.

Options:
  --yes       Skip the confirmation (required when not on a terminal)
  --dry-run   Only print the npm command
`,
  runs: `Usage: t3sm runs [--json]

List the runs recorded in the journal: id, start time, command, status and
what each changed. Read-only.

Options:
  --json   Print the runs as JSON
`,
  scan: `Usage: t3sm scan [--json]

Inventory the sessions on this machine per harness and account.
Needs no running T3 Code. Writes only t3sm's own discovery cache (in its state
folder); never a session file.

Options:
  --json    Print the discovered sessions as a JSON array
`,
  plan: `Usage: t3sm plan [--json] [--allow-untested]

Connect to the running T3 Code (read-only), discover sessions and write the
import plan to <state>/runs/<runId>/plan.md and plan.json. It also updates
t3sm's discovery cache and, on the first run, saves the detected accounts to
<state>/config.json. T3 Code and session files are not changed.

Options:
  --json             Print the plan as JSON instead of the summary
  --allow-untested   Continue with a T3 Code version t3sm was not tested against
`,
};

function readVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

function report(e: unknown, io: Io): number {
  const { code, message } = describeError(e);
  io.stderr(`${message}\n`);
  return code;
}

export async function main(argv: string[], io: Io): Promise<number> {
  // Plain `t3sm` on a terminal: the guided assistant. Not on a terminal: the usage, as always.
  if (argv.length === 0 && io.isTTY) {
    try { return await commands["start"]!([], io); } catch (e) { return report(e, io); }
  }
  const i = argv.findIndex((a) => !a.startsWith("-"));
  const lead = i === -1 ? argv : argv.slice(0, i);
  for (const f of lead) {
    if (f === "-h" || f === "--help" || f === "-v" || f === "--version") continue;
    io.stderr(`Unknown option: ${f}. Run \`t3sm --help\`.\n`);
    return 2;
  }
  if (i === -1) {
    if (lead.includes("-v") || lead.includes("--version")) io.stdout(`${readVersion()}\n`);
    else io.stdout(USAGE);
    return 0;
  }
  const name = argv[i]!;
  const wantsHelp = lead.includes("-h") || lead.includes("--help") || argv.slice(i + 1).some((a) => a === "-h" || a === "--help");
  if (wantsHelp && Object.hasOwn(COMMAND_HELP, name)) {
    io.stdout(COMMAND_HELP[name]!);
    return 0;
  }
  const handler = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!handler) {
    io.stderr(`Unknown command: ${name}. Run \`t3sm --help\`.\n`);
    return 2;
  }
  try {
    // Everything after the command name, including flags, goes to the handler.
    return await handler(argv.slice(i + 1), io);
  } catch (e) {
    return report(e, io);
  }
}
