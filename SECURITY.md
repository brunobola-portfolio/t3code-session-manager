# Security policy

## Supported versions

Only the latest release receives fixes. Update with `t3sm update` (an `npm install -g` of the newest release tag), or
run the pinned command with the newer tag (`npx -y github:brunobola-portfolio/t3code-session-manager#v0.2.1 …`).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
https://github.com/brunobola-portfolio/t3code-session-manager. Do not open a public issue for security problems.
You will get an answer within seven days.

## What t3sm does on your machine

t3sm runs locally, as you, and sends nothing anywhere except to T3 Code on your own machine. There is no telemetry, no
network call to any other host, no model call, and no runtime dependency. The one exception is one you start
yourself: `t3sm update`, after you confirm, runs `npm install -g --install-links github:<repository>#semver:*`, and npm downloads the
release from GitHub. No other command starts npm, and t3sm never checks for updates on its own.

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
holds only counts and run ids. None of these holds message text (the OpenCode copy above does). They stay on your
machine. Review `t3sm doctor --json` before pasting it into an issue.
