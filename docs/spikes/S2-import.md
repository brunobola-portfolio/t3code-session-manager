# Spike S2: T3Code importer behaviour with mtime bumps

- **Tested live against:** T3 Code Nightly desktop, `serverVersion` `0.1.9-nightly.20261110.4465`, Windows 11 x64, 2026-11-10. `claudeAgent` groupKey `claude:home:C:\Users\<user>\.claude`, `codex` enabled, `pi` disabled, `settings.providerInstances` = `{}`.
- **Source read:** `pingdotgg/t3code` @ `c0cb75e8`: `apps/server/src/project/AgentSessionScanner.ts`, `AgentSessionImporter.ts`. Every behaviour below that was observable matched the source.
- **Setup:** one disposable project (`project.create` over HTTP), six synthetic Claude transcripts in `~/.claude/projects/<encoded cwd>/`: three good sessions, one with a non-UUID `sessionId`, one with no user message, one byte-copy of good #1 under another filename. All were removed afterwards (§9).

## GATE verdict: PASS

Bumping the mtime into the 30-day window, then `agentSessions.scan`, then `agentSessions.import`, imported all three good transcripts as threads. Resuming one of them in T3 continued the original Claude session with its context intact.

## 1. Results (raw)

| # | file mtimes | call(s) | result |
|---|---|---|---|
| 1 | 60 days old, **atime = now** | `import` (no scan since server start: cache empty) | `{importedCount:0, skippedCount:0}`, 1140 ms. The import ran a full discovery itself. |
| 2 | same | `scan` → `import` | 0 / 0. Scan listed the project candidate with `threadCount:6`, `lastActiveAt` = the old mtime |
| 3 | **bumped to now−1 s** | `import` **without** scan | **0 / 0** (7 ms). The cache still held the old mtimes. |
| 4 | bumped | `scan` → `import` | **3 / 2** (scan 744 ms, import 46 ms). Three threads were created. |
| 5 | still bumped, same values | `scan` → `import` | **3 / 2** again, no new threads (the `AlreadyImported` path) |
| 6 | restored to 60 days | `scan` → `import` | 0 / 0. Threads unchanged. |
| 7 | **re-bumped to a new "now"** | `scan` → `import` | **3 / 2**, no new threads (existing-thread path, see §3) |
| 8 | restored | `scan` → `import` | 0 / 0. Shell: the same 3 threads, no duplicates |
| 9 | good #1 resumed in T3 (mtime is now naturally current) | `scan` → `import` | 1 / 0, no new thread |

In rows 4, 5 and 7 the counts break down as: 3 = the three good sessions, 2 = non-UUID session + no-user-message session. The byte-copy (same `sessionId` as good #1) is a `Duplicate` and is counted in **neither** field.

## 2. Answers to the measured questions

1. **Cache.** `import` does **not** see bumped mtimes unless a `scan` ran after the bump. `AgentSessionScanner` keeps one in-memory `cachedCandidates`, the transcript list with the mtimes as they were at the last scan. `scan` always refreshes it. `import` reuses it and only collects fresh data when it is `null` (first call after server start). Files created after the last scan (such as converted transcripts) are invisible to `import` until the next `scan`. **Rule: bump (and write) → `scan` → `import`, every time.**
2. **Already-imported transcripts and `importedCount`.** They count. An eligible transcript whose identity (`filePath`, `size`, `mtimeMs`, `device`, `inode`, `birthtimeMs`) equals a recorded imported source is `AlreadyImported`, and it adds +1 to `importedCount` (row 5). A transcript of an already-imported session whose identity **changed** (re-bumped to another mtime, or appended to) takes the existing-thread path, re-records the source, and also adds +1 to `importedCount` (rows 7 and 9). **`importedCount` is therefore not "new threads".** Verify against the shell.
3. **Does the 100-per-call cap (`MAX_IMPORT_TRANSCRIPTS`, `AgentSessionScanner.ts:75`, consumed at `:1688`) count already-imported transcripts?** No for `AlreadyImported` (exact identity match). The `completed` check comes before the cap and does not decrement `transcriptsRemaining`. **Yes for everything else**, which is decremented before parsing: re-bumped already-imported sessions, `Duplicate`s, parse failures (no user message, no cwd), and non-UUID Claude sessions. When the cap is exhausted, each remaining non-completed eligible transcript becomes `Skipped` (`skippedCount`+1). There is also a 4 GiB byte budget per call (size of transcripts read). Answered from source; 100+ files were not generated.
4. **Scan duration and `truncated`.** Over `~/.claude` (2666 top-level transcripts) + `~/.codex` (108): **744–1285 ms** per scan in 8 runs, warm. S1 measured the same server on `~/.claude-org` + `~/.codex`: 2895 ms cold, ~800 ms warm. `truncated: true` was reported on **every** scan. **Cause: the per-source metadata byte budget `MAX_METADATA_BYTES_PER_SOURCE` = 64 MiB (`AgentSessionScanner.ts:65`; window `RECENT_THREAD_WINDOW_MS` at `:69`; all line numbers are in the `c0cb75e8` clone).** See §4.
5. **No duplicate threads** after 5 import calls, a re-bump and a resume (shell: 3 threads, rows 4–9).
6. **Thread id format:** `import:<providerInstanceId>:<providerSessionId>`, e.g. `import:claudeAgent:00000000-0000-4000-8000-000000000011`. For Claude, `providerSessionId` is the last non-hidden record's `sessionId` field, falling back to the filename stem. The importer **rejects** it unless it matches the UUID pattern. Thread fields: `historyOrigin:"v1_import"`, `providerInstanceId`, `modelSelection:{instanceId, model}` (the model is the transcript's last `message.model`, else the driver default), `activeProviderThreadId:"provider-thread:provider:claudeAgent:provider-instance:claudeAgent:native-thread:<sessionId>"`, `createdAt` = first retained message timestamp, **`updatedAt` = `settledAt` = the transcript mtime at import time (the bump time)**. Fixture: `http-orchestration-shell-imported.json`.
7. **atime vs mtime:** only mtime matters. With atime = now and mtime = 60 days, nothing was imported (rows 1–2). The source reads only `stats.mtime`. **Side effect:** T3's scan/import reads update the transcript's **atime**, which was observed to move. t3sm must restore atime as well as mtime (the journal already stores both).
8. **Restoring mtime after import:** no effect on the imported thread (rows 6 and 8: threads, titles and `updatedAt` unchanged). The restored file is simply outside the window again. The thread keeps `updatedAt` = bump time permanently.

## 3. Importer algorithm (source, confirmed by counts)

Per `agentSessions.import {projectId, expectedWorkspaceRoot?}`:

1. Project lookup → `AgentSessionImportProjectNotFoundError`. If `expectedWorkspaceRoot` differs after normalisation → `AgentSessionImportProjectChangedError`. Normalisation is tolerant: `d:/…/project/` matched `D:\…\project`.
2. `completedSources` = imported-transcript identities recorded in provider runtimes whose `cwd` equals the project root.
3. **Eligible** = transcripts in the **cached** scan whose cwd resolves to the same directory identity as the project root **and** whose cached `mtimeMs` ∈ `[now − 30 d, now]`. **A future mtime is excluded.** Sorted by mtime descending, then by path.
4. For each eligible transcript, in that order:
   - identity == a completed source → `AlreadyImported` → `importedCount`+1 (no cap use)
   - cap (100) or byte budget exhausted → `Skipped` → `skippedCount`+1
   - otherwise consume 1 of the cap and read/parse:
     - no cwd, cwd ≠ root, no user message, or unreadable → `Skipped` (+1 skipped)
     - same session id as an earlier transcript in this call → `Duplicate` (no count)
     - Claude id not a UUID → logged warning, `skippedCount`+1
     - thread already exists in another project → `AgentSessionThreadProjectConflictError`, logged, `skippedCount`+1
     - thread exists with `historyOrigin ≠ "v1_import"` → `AgentSessionThreadModifiedError`, logged, `skippedCount`+1
     - thread exists (v1_import) → runtime re-recorded, `importedCount`+1, **no messages appended**
     - new → thread created, `importedCount`+1
     - event sink refused (native thread already owned by another app thread) → **no count at all**

Per-session failures never fail the RPC. They appear only as the warning `"Could not import an agent session"` with `{provider, sessionId, cause:{_tag,…}}` in the server trace (`~/.t3/userdata/logs/server.trace.ndjson`), observed for the non-UUID case.

## 4. Why `truncated: true` (and when it can hurt bumped files)

Budgets per **source** (`claudeAgent` / `codex` / `pi`), with all homes of a source sharing them. Simulated read-only over the real homes with the exact source algorithm (`.spike/s2trunc.mjs`):

| budget | value | `~/.claude` | `~/.claude-org` | `~/.codex` |
|---|---|---|---|---|
| discovery ops (dir listings + stats), split evenly across homes | 20 000 | 2 726 used | 2 392 | 120 |
| `MAX_TRANSCRIPTS_PER_SOURCE` (newest by mtime) | 5 000 | 2 666 | 2 326 (sum of both Claude homes: 4 992) | 108 |
| **metadata bytes** (reading each file in 8 KiB chunks until the first record with `cwd`, ≤ 1 MiB per file) | **64 MiB** | **exhausted after 1 038 files** (cutoff mtime 2026-09-10) | exhausted after 825 | 2.6 MiB |
| metadata ops / records | 20 000 / 100 000 | 9 238 / 3 206 | 9 021 / 2 839 | 432 / 108 |

Bytes read until the cwd: `~/.claude` mean 52 KiB, p50 16 KiB, p90 136 KiB, p99 456 KiB, max 840 KiB. `~/.claude-org` mean 71 KiB, p90 192 KiB, p99 736 KiB. 47 + 1 files have no cwd at all (each costs its full size up to 1 MiB).

Consequences:
- Only roughly the **~1 000 most recently modified Claude transcripts** get a cwd, so only they become candidates. Older ones are silently absent from `scan` and from `import`. This happens on every scan here, so `truncated` carries **no signal**. Do not treat it as an error.
- Metadata is read in mtime-descending order, so a file is read only after every file with a newer mtime. With the final bump rule (§5: bump to just before "now"), bumped files are the newest in the scan and are read **first**. Only the wave's own cost (plus interleaved newest files of other homes of the same source) counts against the 64 MiB.
- **Two or more homes of the same source interleave.** `selectMetadataTranscripts` round-robins between provider instances. With a second Claude instance, its newest natural files are read alternately with the bumped files of the first home and consume the same 64 MiB.
- If the budget runs out inside the wave, the remaining bumped files get no cwd. They are **not candidates and are not counted anywhere** (neither imported nor skipped). The only symptom is a missing thread id in the shell.
- A file whose first cwd record is beyond 1 MiB, or after 1 000 records, can **never** be imported by T3. It sets `truncated` and yields no cwd.
- `MAX_TRANSCRIPTS_PER_SOURCE` (5 000): with both real Claude homes as instances, the total is 4 992. t3sm conversions will push it over, which sets `truncated`. Selection is newest-first, so files within the window (bumped files included) are always among the 5 000 unless there are more than 5 000 newer files.
- Discovery ops (20 000 / homes) are spent in **directory order**, not mtime order. A home with more than 10 000 entries, when 2 homes are configured, would hide whole project dirs regardless of bumps. That is not the case here (2.7k).

## 5. Recommendations for Tasks 15/16 (batch algorithm)

Per wave:
1. Choose the next wave (ordering and limits below). Journal `{path, atimeMs, mtimeMs}` → `utimes(path, atime, bumpMtime)`.
2. `agentSessions.scan` (timeout ≥ 120 s; ~1 s here). **Mandatory**, because of the cache. Also required after writing converted transcripts.
3. For each project in the wave: `agentSessions.import {projectId, expectedWorkspaceRoot}` (~5–50 ms).
4. Restore atime **and** mtime in `finally`.
5. **Verify with `GET /api/orchestration/shell`:** each expected `import:<instanceId>:<sessionId>` must be in `threads`. **This is the only success and termination signal:** a wave is done when every expected thread id is present in the shell. `importedCount`/`skippedCount` are diagnostics only: `importedCount` includes already-imported ones and `Duplicate`s count nowhere. **`truncated: true` from `agentSessions.scan` carries no signal for a wave and must be ignored.** It is set on every scan on this machine by the 64 MiB metadata budget (§4), whether or not the wave's files were read.

**Final wave ordering (controller ruling; Task 16 implements this):**
- **Every** session to import goes through waves, **including sessions whose original mtime is already inside the 30-day window.** Do not rely on natural eligibility.
- Waves are processed in **ascending order of ORIGINAL mtime, oldest first, across all projects**. A wave is the next slice of that global order, bounded by the limits below.
- Within a wave, the i-th file in ascending original mtime (i = 0, 1, …) gets `bumpMtime = (now − 2 s) + i ms`, where `now` is read immediately before bumping. This value is **never in the future**, because future mtimes are ineligible (§3). With i < 2000 that is guaranteed, and the bump must assert it.
- **Rationale:**
  - Bumped files are the newest in every scan, so they are read first within the 64 MiB per-source metadata budget (§4).
  - The thread's `updatedAt`/`settledAt` = the transcript mtime at import time (§2.8). Later waves get later wall-clock bump times, and within a wave the i-ms offsets keep the order. T3's `updatedAt` order across all imported threads therefore matches the original order.
- **Residual (documented, accepted):** imported threads show the import time as their last activity; their relative order is preserved.
- **Rejected alternative:** bumping into the oldest hour of the window (`now − 30 d + 1 h + rank s`). It starves the metadata budget: every natural in-window file is read first, costing 37.6 MiB (`~/.claude`) + 30.1 MiB (`~/.claude-org`), measured read-only. With two Claude homes, the bumped files would never be read.

Limits. **These are ESTIMATES, not measured values.** They are derived from the ~52 KiB mean cwd-read cost (§4) and the budget guard. This spike exercised only 3 importable files (6 eligible) per call; nothing near 50 files per project or 5 projects per wave was run live. **Controller ruling for Task 16 defaults: `{filesPerProject: 50, projectsPerWave: 5}`.**
- **`filesPerProject` default 50 (estimate), hard max 90.** The 100 cap applies to every non-completed eligible transcript of the project, in mtime-descending order (§3).
  - Bumped files are the newest, so the only transcripts ahead of them are the project's not-yet-imported files with mtime > the wave's bump base (actively written in the last ~2 s; normally 0).
  - **Conservative capacity:** per-project capacity = 100 − R. R = the number of that project's transcripts with original mtime in [now − 30 d, now] whose expected thread id is **not** in the shell and which are **not** in this wave. Compute R from the plan items of the project and the shell snapshot taken just before the wave. Because every recent session is also waved, R shrinks as waves progress and is small at the end. Use `min(filesPerProject, 90, 100 − R)`.
  - Natural in-window files beyond the wave's own files may be imported as a side effect (with their natural mtime as `updatedAt`). Before each wave, re-read the shell and drop sessions already present (`already-in-t3`). Re-bumping them would only waste cap slots.
- **`projectsPerWave` default 5 (estimate)**, plus a **per-wave budget guard per source**: Σ(cost of the wave's files of that source) ≤ **~56 MiB** (64 MiB minus an 8 MiB margin), or shrink the wave. If the source has more than one home (instance), add, for each other home, the cost of its newest files up to the same count. Reads are round-robin between instances (§4), and that home's newest files are read alongside the wave. Cost of a file = bytes up to and including the 8 KiB chunk that contains the first record with a non-empty `cwd`, capped at min(1 MiB, size). Reading the same prefix is cheap, and Task 9 discovery already reads it. With 50 × 5 = 250 files at a ~52 KiB mean that is ~13 MiB.
- **Never bump a session that is already in T3.** The planner's `already-in-t3` check must use the shell thread ids. Re-bumping wastes cap slots and gains nothing (no messages are appended).
- **Pre-filter what T3 will reject**, so it never takes cap slots: Claude `sessionId` not a UUID (`non-uuid-id`), no user-visible message (`only-hidden`), and no cwd within the first 1 MiB / 1 000 records. The last case needs a new skip reason or reuses `no-cwd`; Task 13 to decide.
- **Duplicates:** two files with the same `sessionId` in one call → only the newest-mtime file is imported. The other is counted nowhere. The planner's `pickWinners` must bump only the winner.
- **Retry policy:** a second `scan`+`import` with the same bumped files is safe and idempotent. Already-imported ones are free. Sessions still missing after it go to `import-failed`. Do not loop: persistent failures re-consume cap slots on every call.

### Failure reasons and their observable symptoms

| reason | wire | shell | trace |
|---|---|---|---|
| project gone | `Fail` `AgentSessionImportProjectNotFoundError{projectId}` (fixture) | — | — |
| project root changed | `Fail` `AgentSessionImportProjectChangedError{projectId}` (fixture) | — | — |
| import without fresh scan | 0 for the bumped files | thread missing | — |
| file beyond metadata budget, or no cwd ≤ 1 MiB / 1 000 records | not counted | thread missing | — |
| over the 100 cap | `skippedCount`+1 | thread missing | — |
| no user message / unparsable / cwd ≠ root | `skippedCount`+1 | thread missing | — |
| non-UUID Claude session id | `skippedCount`+1 | thread missing | WARN `AgentSessionUnresumableSessionError` |
| thread id owned by another project | `skippedCount`+1 | thread in the other project | WARN `AgentSessionThreadProjectConflictError` |
| thread exists, not v1_import | `skippedCount`+1 | existing thread | WARN `AgentSessionThreadModifiedError` |
| same session id twice in one call | not counted | one thread | — |
| mtime in the future | not counted | thread missing | — |

## 6. Resume check (Step 5)

`t3 thread send --wait --json import:claudeAgent:<id> -` with "What was the first message I sent you in this conversation? Answer with that text only." on stdin. It returned `status:"completed"` in 15 s, with `reply` = the synthetic first message, verbatim. Claude appended the turn to the **same** `<sessionId>.jsonl` in `~/.claude/projects/<encoded>/` (resume via `resumeCursor {resume: sessionId}`), and no new session file appeared. The thread `model` came from the transcript (`claude-sonnet-4-5`). Afterwards that session's transcript is naturally in the window, and a later `import` counts it as `importedCount` 1 without appending the new turn to the T3 thread (accepted residual limit).

Side effects of a resumed turn in the account home (user hooks): `session-env/<id>/`, `security/security_warnings_state_<id>.json`, `session-namer/state/<id>.json`, and a `custom-title` record appended to the transcript.

## 7. Project mutations (live; closes the S1 gap)

- `POST /api/projects/mutate` `project.create` → **200** with a `Project` in 31 ms (`http-project-mutate.response.json`). The keys and order are identical to the S1 source-derived fixture, which this replaces. The only value difference is `defaultModelSelection: null` (none was sent).
- **Same body again (same `commandId`)** → 200 with the same project, which makes it idempotent by `commandId`.
- **New ids, same `workspaceRoot`** → **400** `{"_tag":"EnvironmentRequestInvalidError","code":"invalid_request","reason":"invalid_command"}` (`http-project-mutate-create-duplicate-root.response.json`). t3sm must look up existing projects by root first, and treat this 400 as "already exists, re-read `/api/projects`".
- `t3 project remove <id>` on a project with threads → error `invalid_command`. `t3 project remove --force <id>` deletes the project and its threads. They vanish from `threads` and `archivedThreads` in the shell.

## 8. Fixtures added (`test/fixtures/t3-wire/`, scrubbed as in S1)

New UUID mappings: project `…0006`, a foreign project `…0007`, sessions `…0011`–`…0013`. Path `D:\work\demo-3`, titles `demo-3` / `Demo thread N`.

| file | content |
|---|---|
| `ws-import.request.json` | `agentSessions.import` request with `expectedWorkspaceRoot` |
| `ws-import.exit.json` | live Success `{importedCount:3, skippedCount:2}` |
| `ws-import-nothing-eligible.exit.json` | live Success `{0,0}` |
| `ws-import-project-not-found.exit.json`, `ws-import-project-changed.exit.json` | live typed failures |
| `http-project-mutate.response.json` | live `project.create` 200 (replaces `…response.source-derived.json`) |
| `http-project-mutate-create-duplicate-root.response.json` | live 400 for a second project on the same root |
| `http-orchestration-shell-imported.json` | live shell with one project and its 3 imported threads (full `ShellThread` shape for imported threads) |

## 9. Not covered / notes

- The scan was timed live only over the homes that T3 has enabled (`~/.claude` + `~/.codex`). No second Claude instance was created to avoid a settings write. The `~/.claude-org` figures come from S1 (live) and from the read-only budget simulation.
- The 100-cap behaviour was answered from source, not by generating more than 100 files.
- On Windows, Node printed `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` when `process.exit()` was called with a WebSocket still closing. Await the `close` event before exiting.
