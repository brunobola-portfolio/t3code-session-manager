# Conversion: sessions t3sm converts before importing

## What it means

T3 Code cannot read some sessions as they are: OpenCode sessions, and Codex sessions that Codex compressed. t3sm
writes a copy of each as a Claude conversation next to the account's other ones, then T3 Code imports that copy. Your
original files are never changed.

## Why a conversion fails

- The agent's storage changed and this t3sm cannot read it: update t3sm (`t3sm update`).
- The session could not be read (a locked or damaged file): try again later; `t3sm scan` counts read errors.
- The copy could not be written (disk full, no permission), or a file with the same name is already there: free some
  space, or move that file away.
- The destination folder cannot be used (a temporary or system folder): pick one in `t3sm start`.

## What to do

Run `t3sm apply` again once the cause is fixed. `t3sm rollback --run <id> --dry-run` shows the copies a run wrote;
a rollback deletes them unless you edited them.
