// What `t3sm --help` and `t3sm <command> --help` say, in English (help.pt.ts is the European Portuguese twin, with the
// same commands). Plain text in a small fixed shape that src/cli/helpText.ts styles and fits to the window:
//   - blocks are separated by blank lines;
//   - "Usage:" starts the usage block (one form per line, later forms indented);
//   - a heading line ("Options:", "Examples:", a group such as "Import") followed by items indented by two spaces: a
//     term, two or more spaces, its description (continued on lines indented further; a continued line with aligned
//     columns inside is kept as it is);
//   - a command form ("t3sm projects set ...") followed by an indented paragraph;
//   - any other block is a paragraph (lines are joined), with "  - " bullets; `backticks` mark a command.
// Every option shown must be one the command accepts (src/cli/flags.ts; test/cli/usage.test.ts checks).

export const GLOBAL = `
Global options (every command):
  --lang en|pt   The language of what t3sm prints. Default: env T3SM_LANG, then
                 "language" in config.json, then your system's language, else
                 English. --json, plan.md and the logs are always English.
  --no-color     No colour (NO_COLOR is honoured too)
`;

export const USAGE = `t3sm brings your Claude Code, Codex, Pi and OpenCode sessions into T3 Code.

Usage: t3sm [command] [options]

Start here
  t3sm start             Guided set-up, step by step (also plain \`t3sm\`; \`--lang pt\` in Portuguese)

Import
  t3sm doctor            Check this machine, T3 Code and the accounts (read-only)
  t3sm plan              Build the import plan in plan.md (changes no session)
  t3sm apply             Import the planned sessions (--dry-run, --only "<folder>")

Accounts and projects
  t3sm accounts          Your Claude subscriptions and their T3 Code instances
  t3sm projects          The account each project uses (set "<folder>" <account>, rename --suggest)

Keep in sync
  t3sm status            Does t3sm need you? All good, needs you or working (read-only; exit 10: needs you)
  t3sm sync              Import what is new since the last run (--watch keeps going)
  t3sm schedule          Run sync in the background: install [--watch], remove, restart, status
  t3sm merge             Bring sessions continued in a terminal into T3 Code
  t3sm recover <id>      Bring back a conversation started in T3 Code whose thread is gone

Tidy T3 Code
  t3sm organize          Tidy the imported history: archive, retitle, show, pin (--undo)

Clean up and undo
  t3sm quarantine        Move backup folders to a reversible quarantine
  t3sm dedupe            Move the plan's mirror copies to a reversible quarantine
  t3sm runs              List what each run did
  t3sm rollback          Undo a run (--run <id>)

Help and maintenance
  t3sm help              What a message means and what to do (t3sm help <topic>)
  t3sm scan              Count sessions per agent and account (no T3 Code needed)
  t3sm update            Update t3sm to the newest release (--check only looks)
  t3sm changelog         What is new in this version (--since <version>)
  t3sm --version         Show the version

Every command explains itself: \`t3sm <command> --help\`. Commands that write ask first; --dry-run shows what they would
do.
`;

export const COMMANDS: Record<string, string> = {
  doctor: `Usage: t3sm doctor [--json] [--repair]

Check everything t3sm depends on and say what to fix: Node, the state folder, config.json, the lock, interrupted runs,
the shell's CLAUDE_CONFIG_DIR, T3 Code (running, version, CLI, a read-only session), its Claude instances and the
account each one is signed in to (emails masked), accounts found on this machine but missing from config.json, backup
and quarantine folders, the agents (Claude Code, Codex, Pi, OpenCode), the /t3sm commands and the background sync.
Read-only: it opens one read-only T3 Code session and revokes it before exiting. Exit 1 when a check fails.

Options:
  --json     Print the checks as JSON (always English)
  --repair   Restore transcript file times left bumped by an interrupted run
             (takes the lock; the only thing doctor ever writes)
`,
  accounts: `Usage: t3sm accounts [--show-emails] [--allow-untested]
       t3sm accounts --init [--force]
       t3sm accounts --apply [--yes] [--allow-untested]
       t3sm accounts --rename <id> "<Display Name>" [--color "#RRGGBB"]

With no option: a read-only table of the accounts in config.json against T3 Code's instances (signed-in email, masked
like b***@example.com; sign-in, availability, where each account was found), with a warning for shared emails,
accounts without an instance, signed-out instances and accounts found on this machine but missing from config.json.

Accounts are found in ~/.claude, ~/.claude-* folders, CLAUDE_CONFIG_DIR in shell profiles (PowerShell, bash, zsh,
fish; the alias or function name becomes the account id), .vscode/settings.json pins, the current shell and the homes
of existing T3 instances. A folder counts only when it holds projects/.

Options:
  --init         Write config.json with every account found (never emails)
  --force        With --init, overwrite an existing config.json
  --apply        Create the missing instances and pin claudeAgent to ~/.claude
  --yes          Skip the confirmation (required when not on a terminal)
  --rename       Set the T3 Code picker label (and colour) of an instance, and
                 mirror it in config.json
  --color        With --rename: the instance's colour, as #RRGGBB
  --show-emails  Show the signed-in emails in full in the table (masked by default)
  --allow-untested  No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm accounts
  t3sm accounts --apply
  t3sm accounts --rename claude-work "Claude Work" --color "#7C3AED"
`,
  apply: `Usage: t3sm apply [--plan <path>] [--yes | --dry-run] [--only <root>] [--quiet] [--verbose] [--allow-untested]

Import the sessions of a plan into T3 Code: create the missing instances and projects, set the per-project default
account, then import in waves (old transcripts get a short, journaled file-time bump so T3 Code's own importer takes
them; every time is restored afterwards). Ctrl+C restores the current wave and stops. Exit 5 when some sessions could
not be imported: a table says why and what to do, and \`t3sm help <topic>\` explains each reason.

Options:
  --plan <path>      Plan to apply (default: the latest runs/*/plan.json)
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Run every check (read-only T3 Code session), print the
                     summary and what would be done, write nothing
  --only <root>      Apply only the sessions of this project folder
  --quiet            No progress output (and nothing when another run holds the lock)
  --verbose          Also print one line per import wave (the progress bar stays)
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)

T3 Code imports every recent transcript of a project at once, from every account. So while a project is imported,
its other recent transcripts (mirror and backup copies, excluded ones, later waves) are parked: their file time is set
7 days into the future, which T3 Code skips, and put back right after (a crash is repaired by the next t3sm run). A
project with a session in use right now waits for the next run (\`t3sm help held\`). Mirror copies in the window are
reported: run \`t3sm dedupe\` so T3 Code's own Welcome import cannot take them either.

A plan older than 24 h, or made against another T3 Code version, is refused: run \`t3sm plan\` again.

Examples:
  t3sm apply --dry-run
  t3sm apply --only "~/code/app"
  t3sm apply
`,
  quarantine: `Usage: t3sm quarantine [--yes | --dry-run]

Move the backup folders inside each account's projects/ folder (\`.bak-*\`, \`<dir>.bak\`, \`<dir>.bak-YYYYMMDD-HHMMSS\`)
to <account home>/session-manager-quarantine/backups/. Nothing is deleted: each move is a rename on the same drive
(file times kept), journaled, and undone by \`t3sm rollback --run <id>\`. A folder holding a file changed in the last
10 minutes is skipped.

Options:
  --yes       Skip the confirmation (required when not on a terminal)
  --dry-run   Only list what would move
`,
  dedupe: `Usage: t3sm dedupe [--plan <path>] [--yes | --dry-run]

Move the plan's mirror copies (a session copied into a second account that is identical to, or an older prefix of,
the copy that is kept) to <account home>/session-manager-quarantine/mirror/<project folder>/, together with the
session's sidecar folder. Each copy is compared again right before it moves; forks, active files and copies whose kept
copy is gone are skipped. Undo with \`t3sm rollback --run <id>\`.

Options:
  --plan <path>   Plan to use (default: the latest runs/*/plan.json; older than 24 h is refused)
  --yes           Skip the confirmation (required when not on a terminal)
  --dry-run       Only list what would move
`,
  merge: `Usage: t3sm merge [--session <id> | --all] [--yes | --dry-run] [--allow-untested]

Bring work continued in a terminal (\`claude --resume\`) into T3 Code. T3 Code continues an imported thread from the
last message it knows, so terminal turns made after the import stay invisible there. A merge:
  - creates a new session file next to the original (<revision id>.jsonl) holding the branch \`claude --resume\`
    would continue; the original session file is never edited;
  - imports it into T3 Code as a new thread, then archives the old T3 thread;
  - is reversible with \`t3sm rollback --run <id>\`.

With neither --session nor --all it only lists the candidates (project, session, last terminal activity, messages
added) and exits 0. A session counts as continued only on positive evidence: a message after the import written by
another entrypoint than T3 Code. Sessions written in the last 10 minutes wait; a project with another session in use
waits. A compacted session is not merged (not supported yet), nor one with a broken message chain. Terminal work on a
side branch (not the one \`claude --resume\` continues) is listed with the \`claude --resume <id>\` hint, never merged.

After a merge: continue in T3 Code on the new thread, or in a terminal with \`claude --resume <revision id>\` (printed
for each merge). The original session id stays resumable in the terminal but is now a stale branch, and \`claude
--resume\`'s picker shows both. Never have the same session open in T3 Code and a terminal at the same time. Undo with
\`t3sm rollback --run <id>\`: an untouched revision is deleted and the old thread unarchived; a revision continued
since is kept (both threads stay). \`t3sm sync\` only reports pending merges, unless config sync.autoMerge is true
(default false): then it merges them itself.

Options:
  --session <id>     Merge one session (its id, or a unique prefix of 8+ characters)
  --all              Merge every candidate
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Only list the candidates
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm merge
  t3sm merge --session 1a2b3c4d
  t3sm merge --all
`,
  recover: `Usage: t3sm recover <session id> [--yes | --dry-run] [--allow-untested]

Bring back one conversation started in T3 Code whose T3 Code thread is gone. t3sm cannot tell that by itself when the
transcript names no T3 Code thread (\`t3sm status\` lists such conversations under Worth knowing), so you name it. It
refuses unless the conversation was started in T3 Code and no T3 Code thread t3sm can see holds it. The conversation
comes back as a faithful copy with a new session id, imported into its project (journaled; undo with \`t3sm rollback
--run <id> --archive-threads\`). The original file stays as it is. If the thread still exists in T3 Code, this makes
a duplicate. On a terminal it shows what it will do and asks first.

Options:
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Only show what it would do
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm recover 1a2b3c4d --dry-run
  t3sm recover 1a2b3c4d
`,
  rollback: `Usage: t3sm rollback [--run <id>] [--yes | --dry-run] [--instances] [--archive-threads] [--allow-untested]

Undo one run. Without --run it shows the latest run that is not itself a rollback (possibly an unattended sync) and
asks; --yes needs --run <id>:
  - converted files it wrote are deleted, unless edited since (then kept and listed);
  - what it quarantined moves back (an original path that exists again is left in quarantine and reported);
  - per-project default accounts it set are restored (needs T3 Code running; otherwise the file part still runs and
    the rest is reported);
  - a merge (\`t3sm merge\`): its revision is deleted, its old thread unarchived and its revision thread archived; a
    revision continued since is kept and both threads stay as they are (reported);
  - an organize run (\`t3sm organize\`, \`t3sm projects rename --suggest\`): its changes are reverted where T3 Code
    still shows what t3sm set, exactly as \`t3sm organize --undo <run>\` does; what you changed since stays.
Imported threads, created instances and projects are listed, never deleted. Running it twice changes nothing the
second time.

Options:
  --run <id>          The run to undo (see \`t3sm runs\`)
  --yes               Skip the confirmation (needs --run; required when not on a terminal)
  --dry-run           Only list what would be undone
  --instances         Also restore instance names, colours and homes the run changed
  --archive-threads   Archive (not delete) the threads the run imported
  --allow-untested    No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm runs
  t3sm rollback --run 20261114-120000-abcd --dry-run
  t3sm rollback --run 20261114-120000-abcd --yes
`,
  sync: `Usage: t3sm sync [--quiet] [--verbose] [--allow-untested]
       t3sm sync --watch [--quiet] [--allow-untested]
       t3sm sync --dry-run [--allow-untested]

One unattended cycle: build a fresh plan and apply it without asking. Built to run from a scheduler, so it is
cautious:
  - never creates T3 instances (sessions of a missing account wait for \`t3sm accounts --apply\`), never quarantines
    or dedupes;
  - sessions continued in a terminal since t3sm imported them are reported (run \`t3sm merge\`); with sync.autoMerge
    true (default false) it merges them itself when idle 10 min, at most 20 per cycle;
  - a session with a mirror copy inside T3 Code's 30-day window waits for \`t3sm dedupe\` (the copy is parked while
    its project imports);
  - a project with a session in use right now waits for the next cycle;
  - a session whose import failed (and has not changed since) waits for \`t3sm apply\`;
  - more than sync.maxUnattendedImports (default 200) pending: nothing is imported, one line says to run \`t3sm
    apply\` once (even with --quiet);
  - a default account you chose in T3 Code is never overridden;
  - nothing to import means nothing written (no journal entry, no run folder).
Exit 3 when T3 Code is not running (silent with --quiet), 0 when another t3sm run holds the lock, 4 for an
incompatible T3 Code, 2 when T3 Code's default Claude instance reads another home. Each cycle appends one line (counts
and run ids only) to <state>/logs/sync.log (rotated at 1 MiB, 3 kept).

Options:
  --quiet            No output except a one-line error (exit 2/4/1/5)
  --watch            Stay resident: watch the transcript folders, run a cycle
                     after changes settle and again once a changed session has
                     been idle 10 min, plus every schedule.everyMinutes; waits
                     while T3 Code is closed. Writes <state>/sync-status.json.
                     Ctrl+C stops after the current cycle. A second watcher exits 0.
  --dry-run          Only print what a cycle would import (writes nothing, not
                     even the discovery cache)
  --verbose          Also print one line per import wave (no effect with --quiet
                     or --watch, which never draw progress)
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm sync --dry-run
  t3sm sync
  t3sm schedule install --watch
`,
  schedule: `Usage: t3sm schedule install [--watch] [--yes | --dry-run]
       t3sm schedule remove [--yes | --dry-run]
       t3sm schedule restart [--yes | --dry-run]
       t3sm schedule status

Register \`t3sm sync --quiet\` with the system scheduler, as the current user, without elevation: Windows Task
Scheduler (a task XML in <state>/schedule/: every schedule.everyMinutes, only while you are logged on, hidden window,
never two at once), a macOS LaunchAgent, or a crontab line tagged "# t3sm". With --watch the scheduler starts \`t3sm
sync --watch --quiet\` at your logon, load or reboot instead, and Windows and cron check every 15 min that it still
runs (one already running is left alone). The watcher restarts itself into a newer t3sm after its next cycle once one
is installed. Run it from your own account: in a shell run as Administrator, t3sm warns that the schedule is installed
for that user only.

install and remove can be run any number of times. install --watch first stops a running watcher (asked over its own
endpoint; a verified process only as a fallback, never by name), recreates the entry and starts the new watcher now;
remove stops it too, and says so (exit 1 with the pid if it is still running); restart stops and starts the scheduled
watcher without reinstalling (exit 2 when nothing is installed). status shows the scheduler entry, the command it
runs (and whether its paths still exist), the watcher heartbeat and the last logged cycle.

Options:
  --watch     With install: start a resident watcher at logon instead of a cycle every few minutes
  --yes       Skip the confirmation (required when not on a terminal)
  --dry-run   Print what would happen; change nothing

Examples:
  t3sm schedule install --watch --dry-run
  t3sm schedule install --watch
  t3sm schedule status
`,
  start: `Usage: t3sm start [--lang en|pt] [--no-color]

A guided set-up for people who would rather not learn the commands. In short steps it runs t3sm's own commands for
you: check (doctor), accounts, plan and the project-to-account table, clean-up (quarantine, dedupe), a pilot import
of one project, the full import, background sync, and a summary with the run ids and how to undo them. Before every
write it asks, and only y goes ahead (Enter means no). At any question: ? explains more, b goes back, q stops;
nothing is left half done. Run it again to continue: it works out where you were from t3sm's own state (journal,
plan, config, scheduler).

Plain \`t3sm\` on a terminal starts it too. Not on a terminal, it prints the quick start and exits 0.

Options:
  --lang en|pt   Language (see the global options below); start offers to
                 save it as "language" in config.json
`,
  projects: `Usage: t3sm projects [--json] [--allow-untested]
       t3sm projects set "<folder>" <account> [--yes | --dry-run] [--force] [--allow-untested]
       t3sm projects unset "<folder>" [--dry-run]
       t3sm projects rename --suggest [--yes | --dry-run] [--allow-untested]

With no subcommand: a read-only table of every project folder t3sm knows, with the account its new threads start on,
why (route: a rule in config.json; vscode-pin: .vscode/settings.json; recent-activity: the account of the most recent
session; default: defaultAccount), the sessions waiting to be imported, whether the project is already in T3 Code (yes,
no, archived) and whether a session of it is in use (an import waits for it). With T3 Code closed it shows what this
machine knows and says so.

t3sm projects set "<folder>" <account>
  Writes a route for that exact folder in config.json (or replaces its route in place). A new route goes right before
  the first wildcard route matching the folder, so it wins for that folder only: no other folder's account changes.
  When the folder is already a T3 Code project and T3 Code is running, it also sets the project's default account
  there (journaled: \`t3sm rollback --run <id>\` undoes it). The route decides where new threads start and which
  account the folder's OpenCode and compressed Codex sessions not imported yet go to; Claude Code sessions keep the
  account they were recorded in, and threads already in T3 Code keep theirs. ~ is your home folder; a route covers
  that exact folder, not its sub-folders. Asks first.

t3sm projects unset "<folder>"
  Removes that folder's route (wildcard routes are left alone). T3 Code is not changed.

t3sm projects rename --suggest
  Clean names for the projects t3sm created whose title is still the one t3sm gave them (a project you renamed is
  never touched): the folder's name, \`parent/name\` for generic folders such as src or app, at most
  organize.names.maxLength characters (default 40), a parent folder added when the name is taken. Shows each title
  before -> after and asks. Every rename is journaled: \`t3sm organize --undo <run>\` puts the old titles back.

Options:
  --json             Print the table as JSON
  --yes              Skip the confirmation (required when not on a terminal)
  --dry-run          Only show the change; write nothing
  --force            With set: accept a folder that does not exist (yet)
  --suggest          With rename: compute the clean names (the only mode)
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)

Examples:
  t3sm projects
  t3sm projects set "~/code/app" claude-work --dry-run
  t3sm projects rename --suggest --dry-run
`,
  organize: `Usage: t3sm organize [--dry-run | --yes] [--only <folder>] [--history <days|all|off>] [--min <n>]
                      [--auto-settle <days|off>] [--no-delete] [--no-pin <ids>] [--no-archive-folders]
                      [--allow-untested] [--plain]
       t3sm organize --undo [<run>] [--dry-run | --yes] [--allow-untested]

Tidy the history t3sm imported into T3 Code. It first shows one line per kind of change, with how many, why and how
to undo it, then the projects with the most conversations shown (now -> after), and asks before changing anything:
  - archive automated conversations (started by the Agent SDK), and the ones of a project t3sm created in a temp or
    system folder;
  - new titles for conversations whose title is a technical first message (<command-name>, <ide_...>, [external
    ...]): the transcript's own title, summary or first real message, at most 80 characters;
  - keep each project's history tidy (organize.history, default the last 90 days and at least 10 per project):
    conversations active in those days are shown inside their project, older ones are settled (they stay in their
    project, on its Settled shelf), and a project with fewer recent ones still shows its most recent; T3 Code's own
    auto-settle setting does not change unless you pass --auto-settle (\`t3sm help history\`);
  - pin the projects with the most recent activity (organize.pinRecent, default 5) and unpin the ones t3sm pinned
    that are no longer among them;
  - delete the empty projects t3sm created (no conversations at all).
Settings live under "organize" in config.json (organize.titles, organize.archiveAutomated, ...).

Conversations you started in T3 Code are never touched, and neither are projects you created (except for pinning),
T3 Code's settings (unless you pass --auto-settle) or its database. Anything you change in T3 Code after t3sm did is
left alone from then on: a conversation you unarchived, renamed, settled or reopened, or a project you unpinned.
Every change is journaled. On a T3 Code version t3sm was not tested with, it warns once and proceeds.

Options:
  --dry-run          Show what would change; write nothing (not even t3sm's
                     discovery cache)
  --yes              Skip the confirmation (required when not on a terminal)
  --only <folder>    Only the conversations of this T3 Code project (no pins,
                     no deletes)
  --undo [<run>]     Revert an organize run. Without a run id it offers the
                     newest one not undone yet and asks; with --yes the run
                     id is required. Only what T3 Code still shows as t3sm
                     left it goes back; a deleted project is re-created.
                     \`t3sm rollback --run <run>\` does the same.
  --history <days|all|off>  The history rule for this run only (config.json is
                     not changed): the last 1-3650 days, all of it, or off
  --min <n>          Show at least n (0-1000) conversations per project, for
                     this run only (with the configured days)
  --auto-settle <days|off>  Also set T3 Code's own auto-settle, for
                     conversations started in T3 Code: after 1-90 days (T3
                     Code accepts nothing else), or off (recorded; --undo
                     puts the old value back)
  --no-delete        Leave the empty projects t3sm created where they are
  --no-pin <ids>     Never pin these projects (T3 Code project ids, comma separated)
  --no-archive-folders  Leave the conversations of projects t3sm created in
                     temporary or system folders unarchived
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)
  --plain            Print plain text only, never an interactive screen. On a
                     terminal, the question offers d = details: the changes as a
                     list you review with the arrow keys; unchecked ones are not
                     applied

Examples:
  t3sm organize --dry-run
  t3sm organize
  t3sm organize --only "~/code/app" --yes
  t3sm organize --history 90 --min 10 --auto-settle 90 --dry-run
  t3sm organize --undo
  t3sm organize --undo 20261114-120000-abcd --dry-run
  t3sm organize --undo 20261114-120000-abcd --yes
`,
  update: `Usage: t3sm update [--from <folder> | --source github] [--yes | --dry-run]
       t3sm update --check
       t3sm update --auto on|off [--dry-run]

Update t3sm to the newest release of its source: GitHub's vX.Y.Z tags (the repository in package.json), or the tags on
main of a checkout on this computer. It first shows what is new (a folder: that tag's CHANGELOG.md; GitHub: after the
install, from the CHANGELOG.md it installed), then asks. The install is \`npm install -g --install-links\` of that tag;
the background watcher is stopped (by its own control, never by name) and started again on the new version, and if no
heartbeat of it comes within 2 minutes the previous version is reinstalled. Every update is journaled. t3sm never
downgrades. A git checkout or the npx cache only gets instructions. In a shell run as Administrator, t3sm warns that
the update is installed for that user only.

Once a day the background watcher also looks (update.auto, default on): a newer patch or minor release (0.x minors
included) is installed by itself, a major one is only announced; a failed or rolled-back update shows in \`t3sm
status\` (\`t3sm help updates\`), and the automatic check skips a rolled-back version (t3sm update can still install
it). Looking up the releases (git ls-remote, or npm view) is t3sm's only network call; installing a release downloads
it with npm.

Options:
  --check            Only look: installed version, the newest release and its
                     kind (none, patch, minor, major), the source, automatic
                     updates on or off, the last check, an interrupted update
                     and how to go back. Read-only (no lock); exit 0 offline too
  --from <folder>    Update from this checkout (a local absolute path such as
                     D:\\code\\t3sm; never a network folder); remembered for
                     the next updates once the new version is in
  --source github    Update from GitHub again (remembered the same way)
  --auto on|off      Turn the daily automatic update on or off in config.json
                     (run t3sm start first if there is none). A preference
                     switch like \`projects unset\`: it needs no --yes
  --yes              Skip the confirmation (required when not on a terminal);
                     the only way a major release is installed without asking
  --dry-run          Show what would be installed; change nothing
  --auto-run         Used by the background watcher with --yes (a patch or
                     minor only); you do not need it

Examples:
  t3sm update --check
  t3sm update --dry-run
  t3sm update --auto off
`,
  changelog: `Usage: t3sm changelog [--since <version>]

The release notes of the installed t3sm, from its own CHANGELOG.md (written in English): this version's section, or
with --since every release newer than that version, newest first. Read-only.

Options:
  --since <version>   The notes of the releases after this one (such as 0.2.1)
`,
  runs: `Usage: t3sm runs [--json]

List the runs recorded in the journal: id, start time, command, status and what each changed. Read-only.

Options:
  --json   Print the runs as JSON
`,
  status: `Usage: t3sm status [--json]

Say whether t3sm needs you. The first line is one level: "All good", "Needs you (N)" or "Working" (a t3sm run is in
progress). Then the items, what needs you first, each with the command that settles it: the background watcher (not
running, on an older t3sm, or failing); a t3sm update that failed or was interrupted; conversations waiting for your
decision; conversations that keep failing to import; rehome copies continued twice; copies waiting for a folder;
organize changes the last organize run could not make. Worth knowing (never a need): a recent update, an update that
was rolled back (the previous version runs again: t3sm recovered by itself), a newer release that was not installed (a major release is only announced: t3sm never installs one by itself),
projects waiting because a conversation is in use, conversations started in T3 Code that t3sm leaves out. Then the
last and next sync, the last organize run and whether T3 Code is running. Strictly read-only: no lock, no journal or
cache write, and it never connects to T3 Code (it reads T3's runtime file only).

Exit 0, or 10 when something needs you (so a script or a notification can tell); 10 is not an error. 2 for a usage
error.

Options:
  --json   Print the same data as one JSON object (no colour). Keys:
             version            2
             ran                false (and nothing else) when t3sm has not run yet
             level              "ok" | "needs-you" | "working"
             items              [{ level: "needs-you"|"info", key, text, command }] (command may be null)
             needsAttention     { reason, detail, command, since, facts } or null (as the last sync cycle recorded it)
             waiting            [{ project, title, modifiedAt, since }] projects held in use
             heldRehome         copies waiting for a destination folder in T3 Code
             decisionsPending   { <question>: sessions waiting }
             pendingImports     { count, source: "sync" | "plan", at } or null
             lastSync           { at, outcome, runId } or null
             nextSync           { at, source: "watcher" } or null
             watcher            { running, pid, version, stale } or null
             update             { installed, available, failure, lastInstalled }
             runInProgress      { pid, startedAt } or null
             lastOrganize       { runId, at, changes, reverted, rolledBackBy } or null
             plugin             [{ account, state: installed|outdated|missing, version }] (the /t3sm commands)
             t3Code             { running, version }
`,
  scan: `Usage: t3sm scan [--json]

Count the sessions on this machine per agent and account. Needs no running T3 Code. Writes only t3sm's own discovery
cache (in its state folder); never a session file.

Options:
  --json    Print the discovered sessions as a JSON array
`,
  plan: `Usage: t3sm plan [--json] [--allow-untested]

Connect to the running T3 Code (read-only), find the sessions and write the import plan to
<state>/runs/<runId>/plan.md and plan.json. It also updates t3sm's discovery cache and, on the first run, saves the
detected accounts to <state>/config.json. T3 Code and session files are not changed.

Options:
  --json             Print the plan as JSON instead of the summary
  --allow-untested   No warning on a T3 Code version t3sm was not tested with (it never blocks)
`,
  help: `Usage: t3sm help [<topic> | <command>]

What a message on a t3sm screen means, why it happens and what to do, in your language. Without a topic it lists
them; a screen that shows a problem names its topic (\`t3sm help not-imported\`). \`t3sm help <command>\` is the same
as \`t3sm <command> --help\`.

Examples:
  t3sm help
  t3sm help held
  t3sm help apply
`,
};
