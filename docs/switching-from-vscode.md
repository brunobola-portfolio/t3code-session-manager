# Switching from VS Code to T3 Code

[Português](switching-from-vscode.pt.md)

A step-by-step move for the common setup: several VS Code windows, each with the Claude Code extension, and two
Claude accounts, say a personal one in `~/.claude` and a work one in `~/.claude-work` (opened with an alias such as
`claude-work`, or pinned per project in `.vscode/settings.json`). At the end every old session is a thread in T3
Code, each project opens with the right account, and new terminal sessions keep flowing in.

Plan for about half an hour, most of it reading. Install the `t3sm` command once (the same line on every system;
[install.md](install.md) has the alternatives):

```bash
npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.2.0
```

Prefer to be guided? `t3sm start` runs these same steps for you, one question at a time, and asks before every write.
This page is the same path by hand, with every check. To change which account a project uses later:
`t3sm projects set "<folder>" <account>`.

## 1. Open T3 Code the right way

Close T3 Code if it is open, then start it from the **Start menu** (macOS: the Dock or Launchpad; Linux: your desktop
launcher). Not from a terminal where the `claude-work` alias or `CLAUDE_CONFIG_DIR` is active: T3 Code would then
read the work folder as its default account.

## 2. Check

```bash
t3sm doctor
```

Fix every `fail` first; each line says how ([troubleshooting.md](troubleshooting.md)). Expect warnings such as
`backups-present` (dealt with in step 5) or `harness:pi` when you have Pi sessions but no Pi instance in T3 Code.

## 3. Check the accounts

```bash
t3sm accounts
```

Both folders should be listed, with where each was found (folder, alias, VS Code pin) and, once instances exist, the
email each is signed in to (masked; add `--show-emails` to see it in full). In T3 Code, an *instance* is one provider
entry in its settings; each account gets its own, created by `apply` (or `t3sm accounts --apply`) after you confirm. If one is missing, see [accounts.md](accounts.md#how-accounts-are-found). To give them
clear names in T3 Code's picker later:

```bash
t3sm accounts --init      # writes ~/.t3code-session-manager/config.json
```

Edit `displayName` and `accentColor` there, or use `t3sm accounts --rename` after the instances exist.

## 4. Plan and review

```bash
t3sm plan
```

Open the `plan.md` it names. Read three things:

- **Project accounts**: every project and the account it will open with, and why (`route`, `vscode-pin`,
  `recent-activity`, `default`). If a project is wrong, add a `routes` entry to `config.json`
  ([configuration.md](configuration.md#send-one-project-to-another-account)) and run `t3sm plan` again.
- **Warnings**: mirror copies, backup folders, large files, sessions continued outside T3 Code.
- **Skipped by reason**: `cwd-missing` means the project folder no longer exists; `active` means the session was
  written in the last 10 minutes (close it and plan again later).

## 5. Clean up copies

If you ever copied sessions from one account to the other, the plan lists **mirror copies**; if you made backups
inside `projects/`, doctor reported **backup folders**. Move them aside, reversibly:

```bash
t3sm dedupe --dry-run
t3sm dedupe
t3sm quarantine --dry-run
t3sm quarantine
```

Then `t3sm plan` again.

## 6. Dry run, then pilot one project

See exactly what `apply` would do, without writing anything:

```bash
t3sm apply --dry-run
```

Then pick a small project from the plan and import only that one:

```bash
t3sm apply --only C:/work/demo
```

It shows the summary and asks for `yes`. If T3 Code's own Claude instance has no folder set in its settings, the
summary also says `Pin claudeAgent to …/.claude`: the first `apply` sets it, so a T3 Code started from a shell with
`CLAUDE_CONFIG_DIR` cannot move it. In T3 Code, open the project: its old sessions are threads. Open one and send a
short message; it continues the original session (that message is a real turn on that account's subscription). Start
a new thread: the composer should already show the project's account.

## 7. Import everything

Before you start: keep the machine awake until it finishes, close the sessions of the projects you want imported,
and pause OneDrive (or any cloud sync of your home folder) until it is done.

```bash
t3sm apply
```

Large histories take several waves. You can stop with Ctrl+C at any time; file times are restored and the next
`t3sm apply` continues. If the machine sleeps anyway, the batch that was running stops when it wakes (file times
restored) and the next run picks it up. You can keep working meanwhile: a project with a session written in the last
10 minutes is held and imported on a later run. No full-size run has been timed yet; waves hold at most 5 projects and 50 sessions
per project.

## 8. Keep it in sync

Only after step 7 has imported everything (`sync` imports nothing while more than 200 sessions are pending):

```bash
t3sm schedule install --watch
```

A watcher starts at logon and imports new sessions shortly after they go quiet. Prefer a plain timer? Use
`t3sm schedule install` (every 15 minutes). `t3sm schedule status` shows what is installed.

## Daily use

- **Pick the account** in T3 Code's composer, per thread. New threads in a project start on the project's default.
- **One place per session.** Never keep the same session open in T3 Code and in a terminal or VS Code at the same
  time: two writers would branch it.
- **Terminal work comes back with merge.** If you continue an imported session with `claude --resume`, T3 Code does
  not see those turns. `t3sm doctor` (`merge-pending`) and `sync` tell you; `t3sm merge` lists them and
  `t3sm merge --all` brings them in as new threads, archiving the old ones.
- **What to keep VS Code for:** anything T3 Code does not do for you, such as the editor itself. Sessions you start in
  VS Code are plain Claude Code sessions, so the sync brings them into T3 Code too once they are idle.

## Going back

Nothing in this move locks you in. Your transcripts stay where they were and keep working in VS Code and in
`claude --resume`. To undo t3sm's own changes, see `t3sm runs` and `t3sm rollback --run <id>` (always name the run; it
moves quarantined copies back and restores project defaults; imported threads are left for you to archive or delete in
T3 Code), then `t3sm schedule remove`.
