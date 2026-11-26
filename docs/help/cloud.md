# Cloud sessions: claude.ai/code and the Claude app on this PC

## What it is

Sessions you start on claude.ai/code or in the Claude app run in Anthropic's cloud, so neither T3 Code nor a
terminal sees them. `t3sm cloud` lists them, and `t3sm cloud pull` brings one here as a normal local session:

- the code is checked out on the session's branch, in its own worktree (your working trees are never changed);
- the conversation is written for the right Claude account and can be continued with `claude --resume`;
- it is imported into T3 Code, under the project of its repository.

Only your own `claude` talks to the cloud, with your own sign-in. t3sm never sees a token, and no model is asked
anything: listing and pulling cost no tokens.

## How to use it

- `t3sm cloud` lists the sessions of every account, with where each one stands: cloud only, on this PC, newer
  in the cloud, or continued here.
- `t3sm cloud pull <id>` shows what it will do and asks once. `--dry-run` only shows it. `--all` takes every session
  that is not here yet or is newer in the cloud.
- The first pull asks for a base folder for the repositories (`<folder>/<owner>/<repository>`) and saves it in
  config.json as `cloud.baseDir`. `--base <folder>` uses another one for a single run.

## When something goes wrong

- **Claude Code could not list the sessions:** run `claude`, then `/login`, and update Claude Code. These requests
  are internal to Claude Code and may change between versions.
- **git failed:** the output is shown. Check that you can clone the repository yourself (`git clone <url>`), then try
  again. A branch that is gone from the remote falls back to the main checkout, with a note.
- **A session waits:** one active in the cloud in the last 10 minutes is brought over on the next pull.
- **Continued here and in the cloud:** nothing is written. The copy in T3 Code is the one on this PC; continue there.
- **On this PC but not in T3 Code:** the screen says why. `t3sm sync` imports it once that is solved.
- **A compacted session:** the turns before its last compaction are not available from the cloud.

## Undo

`t3sm rollback --run <run> --archive-threads` removes the pulled sessions and archives their threads. Clones and
worktrees stay: delete them yourself if you no longer need the code.
