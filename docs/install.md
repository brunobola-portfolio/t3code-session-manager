# Install

## Requirements

- **Node.js 22.18 or newer** (`node --version`). t3sm has no runtime dependencies.
- **git** on `PATH`, for `npx` or `npm install -g` from GitHub (npm clones the repository and builds it).
- **T3 Code** ([t3.codes](https://t3.codes), open source), installed and opened at least once, running whenever t3sm talks to it. Open it from the Start menu or
  your desktop launcher, never from a terminal that sets `CLAUDE_CONFIG_DIR` (it would read that folder as its
  default account; `t3sm doctor` checks this).
- The agents whose history you want to bring in, with their sessions where they normally keep them
  ([harnesses.md](harnesses.md)). t3sm needs no login of its own and never calls a model.
- For `dedupe`, `quarantine` and conversions: a file system with hard links for the account folders and the state
  folder (NTFS, APFS, ext4 and the like; not exFAT/FAT32).

Tested on Windows 11. macOS and Linux run the unit tests in CI; see [harnesses.md](harnesses.md) for what was verified
where.

## Run it with npx (no install)

```bash
npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0 doctor
```

The `#v0.1.0` pins the release (npm's syntax for a git tag); without it, `npx` builds whatever is on `main`. The
first run downloads and builds the package (a few seconds); later runs reuse npm's cache. Every command works this
way: replace `doctor` with `plan`, `apply`, `sync`, and so on.

## Install the `t3sm` command

Recommended if you will use `sync` or `schedule`, because the scheduled task needs a t3sm that stays where it is (the
npx cache can be cleaned at any time):

```bash
npm install -g github:brunobola-portfolio/t3code-session-manager#v0.1.0
t3sm --version
```

## From a clone

```bash
git clone https://github.com/brunobola-portfolio/t3code-session-manager
cd t3code-session-manager
npm install          # dev tools only (TypeScript); builds dist/
node bin/t3sm.mjs doctor
```

In a clone, `bin/t3sm.mjs` always runs the TypeScript sources directly (Node 22.18+ strips types natively), even when
`dist/` exists; an installed package runs `dist/`.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace with one skill, `t3code-sessions`. With it you can ask Claude
Code things like "bring my sessions into T3 Code" or "which account will this project use in T3 Code?". The skill
runs `doctor` and `plan`, summarises `plan.md` (the Project accounts table and the warnings), and runs anything that
writes only after you say yes in the conversation. Inside Claude Code:

```
/plugin marketplace add brunobola-portfolio/t3code-session-manager
/plugin install t3sm@t3code-session-manager
```

The skill uses `t3sm` when it is installed, otherwise the pinned `npx` command.

## Update

- npx: use the newer tag in the command (`#v0.2.0`).
- Global: run the `npm install -g` command again with the newer tag, then `t3sm schedule install` again if you use
  the background sync, so the scheduled task points at the new copy.
- Plugin: `/plugin marketplace update t3code-session-manager`.

The state folder (`~/.t3code-session-manager`) carries over between versions.

## Uninstall

1. Stop the background sync, if you installed it: `t3sm schedule remove` (it also removes the Windows task file or
   the LaunchAgent; on Linux, the `# t3sm` crontab line).
2. Optional: undo runs you do not want to keep. `t3sm runs` lists them, `t3sm rollback --run <id>` undoes one
   (converted files and merge revisions are deleted while unchanged, quarantined folders move back, project defaults
   are restored). Imported threads stay in T3 Code; delete or archive them there if you like.
3. Delete the state folder `~/.t3code-session-manager/`. It holds the config, the journal, plans, logs and caches,
   including `cache/opencode/` (stripped copies of your OpenCode conversations). Without the journal, rollback is no
   longer possible.
4. Quarantine folders: `<account home>/session-manager-quarantine/` (for example `~/.claude/session-manager-quarantine/`)
   hold what `dedupe` and `quarantine` moved. Roll those runs back to restore them, or delete the folders when you are
   sure you do not need the copies.
5. `npm uninstall -g t3code-session-manager` for a global install; `/plugin uninstall t3sm@t3code-session-manager`
   and `/plugin marketplace remove t3code-session-manager` for the plugin.
