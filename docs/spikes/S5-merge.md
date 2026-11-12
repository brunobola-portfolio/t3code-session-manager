# Spike S5: merge revisions (work continued outside T3Code)

- **Tested live against:** T3 Code Nightly `0.1.9-nightly.20261111.4515` (`claudeAgent` instance on `~/.claude`; t3sm warned "not tested exactly, same minor version, proceeding"), Windows 11 x64, on 2026-11-11.
- **Method:** the gated test `test/e2e/merge.live.test.ts` (`T3_E2E=1`, run once with `CLAUDE_CONFIG_DIR` unset). One synthetic Claude transcript (S3 minimal records: one user and one assistant record, chained, with `cwd`, `timestamp`, `sessionId`) was written to the PERSONAL account (`~/.claude/projects/c--work-t3code-session-manager--spike-merge-e2e/<uuid>.jsonl`) for the disposable project dir `.spike/merge-e2e`, dated 3 days ago, and imported through `applyPlan`. Then a terminal-style continuation was appended **by hand**: a user and an assistant record chained from the current CLI leaf (S3 §6: no `last-prompt` yet, so the leaf was the last record with a uuid), both with `entrypoint: "cli"`, plus a `last-prompt` pointing at the new leaf, mtime 1 day ago. The real `claude` CLI was **not** run: no tokens were spent and no hook side files were created. Then `mergeSessions`, a read-only `t3 thread show <new thread> --json`, and `rollbackRun` of the merge run.
- **Cleanup done:** `t3 project remove --force <project id>` (the project and both threads are gone), the transcript and its encoded dir, `.spike/merge-e2e` and the temp state dir were deleted, and their absence was checked afterwards. The T3 sqlite was never opened.

## Result: PASS

| step | observed |
|---|---|
| apply (import of the synthetic session) | `status ok`, 1 wave, 1 imported |
| plan after the hand-made continuation | the item is `skip already-in-t3` with note `continued-outside-t3` |
| merge | 983 ms. Revision `582b41a3-…` written next to the original, imported as `import:claudeAgent:582b41a3-…`, old thread `import:claudeAgent:3b65d758-…` archived. `addedMessages 2`, `divergedLeaves 0`, nothing skipped |
| thread list after the merge | new thread `archived: false`, old thread `archived: true` (through `orchestration.dispatchCommand` `thread.archive`: **the first live call of this command**, S1 addendum had it from source only) |
| original transcript | byte-identical (sha256) and same mtime after the merge and after the rollback |
| revision transcript | provenance record first (`isMeta`, `parentUuid: null`), then the 4 records root→leaf, each `parentUuid` = the previous `uuid`, every `sessionId` = the revision id, no `last-prompt`; mtime = the source's mtime (the wave's bump was restored) |
| `t3 thread show <new thread> --json` | exit 0, the terminal turn's codeword **is in T3's timeline** of the revision thread |
| rollback of the merge run | revision file deleted, old thread `archived: false` (`thread.unarchive`, also its first live call), revision thread `archived: true`, no errors |
| journal | merge run: `run-start, file-written, mtime-bump, import-attempt, mtime-restore, imported, thread-archived, merged, run-end`; rollback run: `run-start, thread-unarchived, thread-archived, rolled-back, run-end` |

## Findings

1. **T3 imports a revision like any other transcript.** The wave machinery (bump the revision into the window, park nothing because the original is already in T3, scan, import, restore) works unchanged with one file. T3 took the revision as a new thread and did not touch the old one: its importer's `existing` branch only registers the original transcript, as in S2.
2. **T3 titles the revision thread from the transcript.** Its title was the first non-meta user text, the same as the original's here (the provenance record is `isMeta`, so it is neither visible nor the title, S3 §4). A custom title the user gave the old thread in T3 is therefore not carried over: `t3sm merge` prints the old title so the user can rename the new thread. T3Api has no rename RPC, and t3sm does not add one.
3. **`thread.archive` / `thread.unarchive` behave as read from source (S1 addendum).** An archived thread moves from `GET /api/orchestration/shell` to `orchestration.getArchivedShellSnapshot`. `T3Api.listThreads()` reports it as `archived: true`. Unarchive brings it back.
4. **The encoded project dir follows the cwd's spelling.** `import.meta.dirname` spelled the drive `c:` and the encoded dir was `c--work-…`. T3 still matched the project (`C:\…`), as S2 found for case variants.

## Not tested live (by design)

- Resuming the revision with `claude --resume <revision id> -p` and asking a T3 turn on the revision thread: both spend tokens and create hook side files (S3 §8). The revision uses exactly the record shapes S3 §2 measured as resumable in both (a `uuid`/`parentUuid` chain with a timestamped leaf; `sessionId` equal to the filename stem; `isMeta` provenance as the root), and the unit tests pin the chain.
- A real interactive terminal session (its `entrypoint` value was not observed in S3; t3sm only relies on `"t3-code"`, which T3 writes).

## Rules the implementation follows (src/ops/merge.ts; revised after review, 2026-11-11)

- **Candidates (controller ruling R1, positive evidence only).** A Claude session that is `already-in-t3` with an **active** `import:<instance>:<id>` thread and a baseline: the size t3sm imported (journal `imported.source.size`), or the size of its last merge that was not rolled back. It must have been inactive for 10 minutes. After the baseline, the branch `claude --resume` continues (S3 §6 Rule 2) must hold a visible message record whose `entrypoint` is a string other than `"t3-code"`. A visible message record is user/assistant and not `isMeta`, `isSidechain`, `isCompactSummary` or `isVisibleInTranscriptOnly`.
  - A record without an `entrypoint` is not evidence.
  - Sessions t3sm did not import have no baseline and are never candidates.
  - If T3 evidently wrote since the baseline (the thread's `latestUserMessageAt` is newer than the baseline file's mtime) but no record after the baseline carries `"t3-code"`, the session is skipped as `no-t3-marker` and never merged.
- **Whole chains only.** The leaf is the newest `last-prompt.leafUuid` that resolves (a newer unresolvable one is ignored), else the last node in file order. The following are skipped and never written as a truncated revision:
  - a chain root whose parent is set but missing, or a cycle: `broken-chain`;
  - a corrupt line inside the chain's byte range: `corrupt-lines`;
  - a chain that crosses a compaction (`compact_boundary`, or `logicalParentUuid`): `compacted`. Merging compacted sessions is not supported yet.
  - an unreadable line after the chain (a record being written, or a torn tail): `unsettled`, skipped this run like an active session.
- **Revision file.**
  - `revisionUuid = uuidV5("rev:<nativeId>:<size>")`, written to `<same dir>/<revisionUuid>.jsonl`.
  - Content: one provenance record dated with the **source's mtime** (so the bytes depend only on the source), then the chain root→leaf. Only `sessionId` is rewritten, and the root's `parentUuid` is set to the provenance uuid.
  - Records without a uuid and sidechain records are not copied.
  - It is journaled `file-written` with `revisionOf {harness, nativeId}` before it is published, published with a no-clobber link, and given the source's mtime.
  - The source is streamed. Verdicts are cached by (path, size, mtime, baseline) in `<state>/cache/merge.json`, which also holds the pending count that `t3sm doctor` reports as `merge-pending`.
- **Housekeeping.** Before a session is merged again:
  - stale `.<rev>.<pid>.<rand>.tmp` files of dead processes are removed;
  - earlier revisions of the session that were never merged and are still t3sm's (sha256) are removed, unless T3 holds a thread for them. The planner never imports such a file on its own (skip reason `revision`).
- **Swap.** The import goes through `runWaves` (expected thread `import:<instance>:<revisionUuid>`).
  - Only after the thread is listed: if it is archived (a rolled-back merge of the same revision), `unarchiveThread(new)` and journal `thread-unarchived`. Then `archiveThread(old)`, journal `thread-archived`, then `merged` (with `sourceSize` and `sourceMtimeMs`).
  - A failed or deferred import deletes the revision while its sha256 is still t3sm's, and leaves the old thread untouched.
  - A revision continued since an interrupted run is never touched (`revision-in-use`).
- **Orphaned terminal work.** A session that is not a candidate but has terminal work after the baseline on a side branch (not the branch `claude --resume` continues) is never merged. `t3sm merge` lists it with the hint `claude --resume <id>`. Sync's notice (log key `merge-orphaned=N`) and doctor's `merge-pending` check report the count.
- **Planner.** An unmerged revision file is skipped (`revision`) only when T3 holds no thread for it. A revision kept by a partial rollback, or one whose archive failed, is an ordinary already-in-t3 session and stays mergeable. A publish that meets a foreign file journals `file-write-aborted`.
- **Rollback.**
  - T3 Code and its thread list are read first. While either cannot be read, revision files are left untouched and reported.
  - A revision thread the run unarchived (a re-merge) is archived again when its revision is removed.
  - When the old thread cannot be unarchived, the revision thread is left active, so a session never ends with no active thread.
  - An untouched revision is deleted, its old thread unarchived and its revision thread archived. This also covers a crash between `thread-archived` and `merged`.
  - A revision that was continued since is kept, both threads stay, and it is reported.
- **sync.**
  - `config.sync.autoMerge` defaults to **false**. Sync then only counts the candidates and logs and prints "N sessions were continued in a terminal; run `t3sm merge`" once per change of N (log key `merge-pending=N`).
  - With `autoMerge: true`, merging runs only after an `ok` or no-op cycle, in its own `sync-merge` run, at most 20 per cycle, never when the cycle is over the unattended limit, and never retrying a revision whose import failed.
  - A merge exception is counted as `merge-failed` and the merge run ends `partial`; the cycle's own result is unchanged. Ctrl+C stops between merges.
  - The log shows `merged=N merge-deferred=M`. Sessions in active use are not counted as deferred.
