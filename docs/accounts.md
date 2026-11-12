# Accounts and subscriptions

A Claude account, for Claude Code, is a config folder: `~/.claude` by default, any other folder when
`CLAUDE_CONFIG_DIR` points at it (`~/.claude-work`, for example). Each folder holds its own login and its own
`projects/` history. t3sm gives each account its own T3 Code instance, so T3 Code's model picker offers both and
every imported thread runs on the subscription its session was made with.

## How accounts are found

`t3sm accounts` (read-only) lists them, with the email each T3 Code instance is signed in to (masked like `doctor` does, `b***@example.com`; `--show-emails` prints it in full) and where each
account was found. A folder counts only when it holds a `projects/` folder. Sources:

| Source | Example |
| :-- | :-- |
| Folder | `~/.claude`, `~/.claude-work` |
| Shell profile alias or function that sets `CLAUDE_CONFIG_DIR` (PowerShell, bash, zsh, fish) | `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`; the alias name becomes the account id |
| VS Code pin of a project | `.vscode/settings.json` → `claudeCode.environmentVariables` → `CLAUDE_CONFIG_DIR` |
| The current shell | `CLAUDE_CONFIG_DIR` set where you run t3sm |
| Existing T3 Code instances | an instance whose home is that folder (its id, name and colour are kept) |

`t3sm accounts --init` writes them to `config.json` (never emails). `t3sm doctor` warns (`accounts-undiscovered`)
when it finds an account that `config.json` leaves out.

## Which account a session belongs to

Measured on a real machine with two accounts before t3sm existed (anonymised, outside backup folders):

| | Sessions |
| :-- | --: |
| Only in the personal account | 1,852 |
| Only in the work account | 1,695 |
| In both accounts | 272 |
| … identical (ignoring the drive letter's case) | 210 |
| … the work copy is longer | 54 |
| … the personal copy is longer | 5 |
| … diverged | 3 |

Most personal sessions lived in the same parent folder as the work projects, so a rule like "everything under this
folder is work" would have put about 1,800 sessions under the wrong subscription. t3sm uses no path rule by default.
Instead:

1. **The folder a transcript lives in is the truth.** A session that exists in one account was run with that
   subscription and is imported into that account's instance.
2. **A session in both accounts is compared by content**, record by record, with the working directory normalised
   and a partial last line tolerated:
   - **identical**: one thread, from the copy in the project's account (rule 3); the other is a mirror copy;
   - **prefix** (one is the start of the other): one thread from the longer copy, because that is where the work
     continued; the shorter is a stale mirror copy;
   - **diverged**: two real branches; both are imported, each in its own account, and `plan.md` lists them as
     forks.
3. **A project's account**, used for the project's default in T3 Code and for converted sessions, is decided in this
   order, first match wins: a `routes` rule in `config.json`; the VS Code pin in the project's `.vscode/settings.json`;
   the account of the most recent session in that folder; `defaultAccount`. `plan.md` shows the result and its source
   for every project in the **Project accounts** table.
4. **A thread stays on its account.** T3 Code keys a thread to the instance it was imported into. To carry on with
   the other subscription, start a new thread in that project and pick the account in the composer.

## Mirror copies and `t3sm dedupe`

T3 Code's importer reads every account it has an instance for, and it imports every recent transcript of a project at
once. A mirror copy inside T3 Code's 30-day window would become a second thread under the wrong account. t3sm
handles that two ways:

- During `apply`, mirror copies are **parked**: their file time is set 7 days ahead for the length of the wave, so
  T3 Code skips them, then restored. So `apply` can run even with mirror copies around, and warns.
- `t3sm dedupe` moves them for good, so T3 Code's own Welcome import cannot pick them up either. It moves only
  identical copies and older prefixes (never forks, never files in use, never a copy whose kept copy is gone), each
  compared again right before it moves, together with the session's side folder, to
  `<account home>/session-manager-quarantine/mirror/<project folder>/`. `t3sm rollback --run <id>` moves them back.

Run `t3sm dedupe --dry-run` to see the list first. The plan tells you when it is worth it
(`Next: t3sm dedupe, then t3sm apply.`).

## Backup folders and `t3sm quarantine`

Backup folders inside `projects/` (`.bak`, `<dir>.bak`, `<dir>.bak-YYYYMMDD-HHMMSS`) look like projects to T3 Code.
`t3sm quarantine` moves them to `<account home>/session-manager-quarantine/backups/`, as renames on the same drive
(file times kept), journaled, undone by `t3sm rollback --run <id>`. A folder with a file changed in the last
10 minutes is skipped.

Both commands move files with a hard link and an unlink, never copy-and-delete and never over an existing file, so
they need a file system with hard links (not exFAT/FAT32 or a share without them). Otherwise the item is refused with
a clear message and nothing moves.

## Instances in T3 Code

- `t3sm accounts --apply` (or the first `t3sm apply`) creates the missing instances through T3 Code's
  `server.updateSettings`, never by editing its settings file, with each account's name, colour and folder. On
  Windows only the folder is needed; the new instance signs in with that folder's login.
- T3 Code's own instance, `claudeAgent`, keeps its id so existing threads stay as they are. When T3 Code's settings
  name no folder for it, `t3sm accounts --apply` or the first `t3sm apply` pins it to `~/.claude` explicitly
  (journaled as `instance-pinned`; `plan.md`, the confirmation and `apply --dry-run` show it), so a
  `CLAUDE_CONFIG_DIR` inherited by T3 Code can never move it. `sync` never changes it; `doctor` warns
  `instance-unpinned` until it is pinned. The account it serves is the one whose home is `~/.claude`, whatever its id
  in `config.json`.
- A session T3 Code already holds under another account (imported earlier) is never imported a second time: `plan`
  skips it as `already-in-t3` and lists it in `plan.md`'s warnings.
- At most one instance per account folder. `doctor` fails `instances` when two instances read the same folder.
- `doctor` warns (`instance-accounts`) when two instances are signed in to the same email (one subscription), or
  when an instance is signed out or unavailable.
- macOS keeps Claude credentials in the Keychain; a second instance there was not tested and may need extra
  environment. Check `t3sm accounts` after creating it.

## Drift: T3 Code reading the wrong account

If T3 Code is started from a shell where `CLAUDE_CONFIG_DIR` is set, its default instance reads that folder instead
of `~/.claude`. `t3sm doctor` fails `instance-home-drift`, and `plan`, `apply` and `sync` stop with exit code 2 rather than
import into the wrong account. Close T3 Code and open it from the Start menu (or your desktop launcher). `doctor`
also warns (`claude-env`) whenever the shell you run it from sets `CLAUDE_CONFIG_DIR`.

## Per-project defaults

`apply` sets each new project's default instance from the **Project defaults to set** table in `plan.md`, through
T3 Code's API, journaled with the previous value. A default you later change by hand in T3 Code is never
overridden by `sync`, and `t3sm rollback` restores only what it set, and only while you have not changed it since.

See also: [configuration.md](configuration.md) (`routes`, `accounts`), [migrate/multiple-accounts.md](migrate/multiple-accounts.md).
