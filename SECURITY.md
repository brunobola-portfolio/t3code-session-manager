# Security policy

## Supported versions

Only the latest release receives fixes. Update with `t3sm update` (an `npm install -g` of the newest release), or run
`npx -y t3code-session-manager@<version> …` with the newer version. Every npm release is published from its GitHub tag
by the Release workflow, with provenance; from GitHub, the pinned command is
`npx -y github:brunobola-portfolio/t3code-session-manager#v0.3.1 …`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
https://github.com/brunobola-portfolio/t3code-session-manager. Do not open a public issue for security problems.
You will get an answer within seven days.

## What t3sm does on your machine

t3sm runs locally, as you, and sends nothing about your sessions anywhere: it talks to T3 Code on your own machine
(loopback only). There is no telemetry, no model call, and no runtime dependency. Its only network call is the release
lookup for updates: `npm view` on the npm registry (an install from GitHub: `git ls-remote --tags` on its repository), once a day from
the background watcher (`update.auto`, on by default; `t3sm update --auto off` turns it off) and when you run
`t3sm update` or `t3sm update --check`. Installing a release runs `npm install -g` of that exact version (from the
registry, the `vX.Y.Z` tag from GitHub, or `git clone` of a local checkout first), so npm downloads it: by hand after you confirm, or by itself
for a patch or minor release when automatic updates are on. Only `t3sm update` and its automatic child start npm.
The optional `/t3sm` plugin install in `t3sm start` runs `claude plugin` commands, after your yes.

### T3 Code

- It finds T3 Code's server from `~/.t3/userdata/server-runtime.json` (read only) and accepts only a loopback address.
- It gets a short-lived session with T3 Code's own CLI (`t3 auth session issue`) and revokes it when the command ends.
  The token is held in memory only, never written to disk or printed.
- Every change in T3 Code goes through T3 Code's API: instances through `server.updateSettings`, projects, default
  accounts, imports and thread archiving through its RPC and HTTP routes. t3sm never opens T3 Code's database
  (`statev2.sqlite`) and never edits its settings file; `test/safety/boundaries.test.ts` checks this.
- `t3sm accounts` and `doctor` show the email each instance is signed in to masked (`a***@example.com`);
  `t3sm accounts --show-emails` prints it in full, on your terminal only. Neither stores it.

### What it reads

- Claude Code transcripts in each account's `projects/` folder, account discovery hints (shell profiles,
  `.vscode/settings.json` of known projects, `CLAUDE_CONFIG_DIR`), Codex session files (compressed ones decompressed
  in memory, never on disk), Pi session files, and OpenCode's database (through a copy, see below). It never reads
  Claude credentials or API keys.

### What it writes, and where

| Where | What |
| :-- | :-- |
| `~/.t3code-session-manager/` (or `T3SM_HOME`) | `config.json`, `journal.jsonl`, `lock`, `runs/<id>/plan.json` and `plan.md`, `cache/`, `logs/sync.log`, `sync-status.json`, `schedule/` |
| `<account home>/projects/<folder>/<uuid>.jsonl` | Only converted sessions (OpenCode, compressed Codex sessions) and `t3sm merge` revisions: new files, journaled with their hash, never over an existing file |
| `<account home>/session-manager-quarantine/` | What `t3sm dedupe` and `t3sm quarantine` moved there, when you ran them |
| File times of transcripts | Moved for the length of an import wave, journaled first, restored afterwards |
| T3 Code, through its own API | What `t3sm organize` changes: archived or reopened conversations, titles, pinned projects, deleted empty projects that t3sm created, and (only with `--auto-settle off`) one T3 Code setting. Only imported conversations and projects t3sm created, pinning aside; each change journaled |
| Your scheduler | A task (Windows), a LaunchAgent (macOS) or a tagged crontab line, only with `t3sm schedule install` |

Native transcripts (Claude Code, Codex, Pi) are never edited, and nothing is written into another agent's folder.

### OpenCode

OpenCode's database also holds account tokens and credentials. t3sm never opens it: it copies the database into an
owner-only temporary folder, builds a fresh file with only the conversation tables and columns it reads (session,
message and part: titles, folders, times, message text and tool input/output), deletes the raw copy in a `finally`
block within seconds, and sweeps any leftover on the next run. The kept copy,
`~/.t3code-session-manager/cache/opencode/opencode-s2-<id>.db`, contains no tokens, credentials, share URLs or
permissions, but it does contain your conversations, like the original. Delete that folder at any time; it is rebuilt
when needed. `doctor` and `sync --dry-run` use a temporary folder removed at exit.

### Your data in reports

`plan.md` and `plan.json` contain folder paths, project names (including the titles of existing T3 Code projects),
session ids, file sizes and times, and counts; `journal.jsonl` holds paths, ids, hashes and file times; the sync log
holds only counts and run ids. `sync-status.json` also stores the titles of the conversations a project is held for
(because one is in use) and project names, never folder or transcript paths (the watcher's heartbeat in it
included). The journal of an organize run holds the titles and
project names t3sm replaced, so that `--undo` can put them back. System notifications (`notify`) carry only project
names and counts, never conversation text. None of these holds message text (the OpenCode copy above does). They stay
on your machine. Review `t3sm doctor --json` before pasting it into an issue.
