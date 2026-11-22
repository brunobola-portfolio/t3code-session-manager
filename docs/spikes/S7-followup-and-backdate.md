# S7 / S8: rehome follow-up and settle backdating

## Purpose

Two constants in `src/t3/compat.ts` depend on how a live T3 Code behaves, and the code cannot know it:

- `FOLLOW_MODE` (`"refresh" | "revision"`, now `"revision"`): when a rehome copy's original grows, does T3 grow the same thread when `agentSessions.import` runs again, or must t3sm import a new revision and archive the old thread (the S5 merge)?
- `SETTLE_BACKDATE` (`boolean`, now `false`): does `thread.settle` honour an optional `settledAt`, so a thread can be settled "in the past"?

`test/e2e/followup.live.test.ts` measures both. Its three cases:

- **S7a.** Import a synthetic faithful transcript into a disposable `.spike/` project, append 2 records to the file, run `agentSessions.import` again.
- **S7b.** Same, but continue the thread in T3 first (`t3 thread send`), then append 2 records and import again.
- **S8.** Unsettle the thread, then dispatch `thread.settle` raw with `settledAt: "2026-01-01T00:00:00.000Z"` and read the stored `settledAt`.

No case fails on either outcome. Each prints one JSON line and removes everything it created (T3 projects, transcripts, roots). S7b spends one model turn.

## Run

```
env -u CLAUDE_CONFIG_DIR T3_E2E=1 node --test --test-timeout=180000 test/e2e/followup.live.test.ts
```

Needs a running T3 Code on Windows, with the claudeAgent instance reading `~/.claude`. Needs the owner's yes (it writes synthetic sessions into the real `~/.claude` and T3, then removes them). Without `T3_E2E=1` the file skips.

## Reading the output

Look for lines that start with `{"case":`:

| Line | Field | Meaning |
|---|---|---|
| S7a / S7b | `outcome` | `grew-same-thread`, `nothing-happened`, `error` (T3 refused the second import), `send-failed` (S7b only: `t3 thread send` failed, so nothing was measured) or `other` (for example a second thread appeared) |
| S7a / S7b | `before`, `after` | `roleCount` and `words` from `t3 thread show --json`; `threadsInProject` lists the thread ids in the project |
| S7a / S7b | `reimport` | what `agentSessions.import` returned (`importedCount`, `skippedCount`) or the error |
| S8 | `outcome` | `honoured` (stored `settledAt` equals the one sent), `ignored` (T3 stored another time, normally now), `rejected` (T3 refused the extra field), `no-settledAt-seen` |
| S8 | `sent`, `stored` | the two times |

## What each result means

- **FOLLOW_MODE.** Set `"refresh"` only if S7a and S7b both say `grew-same-thread`. In any other case (nothing happened, error, other, or S7a grows but S7b does not) keep `"revision"`: a thread continued in T3 holds records T3 wrote, and appending to the file behind them is not safe. S7b decides when they differ.
- **SETTLE_BACKDATE.** Set `true` only if S8 says `honoured`. For `ignored`, `rejected` or `no-settledAt-seen` keep `false`. Task 7 reads this flag.

## Results

Run on 2026-11-16 against T3 Code 0.1.10-nightly.20261113.4630 on Windows (claudeAgent instance):

- **S7a: `nothing-happened`.** The second `agentSessions.import` returned `importedCount: 0, skippedCount: 1`; the thread
  kept its 2 messages (the appended word was not there) and no second thread appeared.
- **S7b: `nothing-happened`.** The same after a turn sent in T3 Code (4 messages before and after).
- **S8: `honoured`.** Sent `2026-01-01T00:00:00.000Z`, stored `2026-01-01T00:00:00.000Z`.

So `FOLLOW_MODE` stays `"revision"` and `SETTLE_BACKDATE` is now `true`.
