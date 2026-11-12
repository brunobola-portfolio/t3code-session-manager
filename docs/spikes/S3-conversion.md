# Spike S3: minimal converted Claude transcript

- **Tested live against:** T3 Code Nightly `0.1.9-nightly.20261110.4465` (`claudeAgent` instance on `~/.claude`) and Claude Code CLI `2.1.322`, Windows 11 x64, on 2026-11-10.
- **Method:** 14 (plus 4 forked, §6) hand-written transcripts (variants of one 5-record conversation, each with one field removed or changed) were written to `~/.claude/projects/C--work-t3code-session-manager--spike-project3/<uuid>.jsonl`. The spike cwd was `C:\work\t3code-session-manager\.spike\project3`. Then: T3 project create → `agentSessions.scan` → `agentSessions.import` → shell → `t3 thread show --json` → `t3 thread send --wait`, and `claude --resume <uuid> -p "…" --output-format json` from the spike cwd with `CLAUDE_CONFIG_DIR` unset (that is, `~/.claude`). No real transcript content was copied. One real transcript was read only to list its field names.
- **Cleanup done:** `t3 project remove --force` (the project and its 13 threads are gone from `/api/projects` and the shell). The encoded project dir, the 14 transcripts, the hook side-effect files for the `…0003xx` ids (`session-env/`, `security/security_warnings_state_*.json`, `session-namer/state/*.json`) and `.spike/project3` were all deleted. The T3 sqlite was never opened. The spike's bearer session `t3sm-spike-S3` (TTL 3 h) expires on its own, and its local token file was deleted. The branch re-run (§6) used the CLI only, and its 4 files and hook side-effect files were deleted the same way.

## GATE verdict: PASS

A hand-written transcript imports into T3Code, renders correctly, and resumes both in T3Code (`t3 thread send` completed, and the model saw the transcript) and in the terminal (`claude --resume <uuid> -p` loaded the full history). Task 20 is not blocked.

## 1. The minimal record (what `toClaudeJsonl` must write)

One JSON object per line, UTF-8, `\n` line endings, a trailing newline, and no other record types. The fixture is `test/fixtures/claude/converted-minimal.jsonl`. It was generated with the same record builder as the tested variant `A_full` (`.spike/s3fixture.mjs` mirrors `.spike/s3gen.mjs`), with the same field order, record uuid scheme, `sessionId` and message texts. Only `cwd` (`C:\work\demo`) and the fixed 2026-01-01 timestamps differ. The fixture file itself was not imported live.

```jsonc
// record 0: provenance (hidden in T3, visible to the model)
{"parentUuid":null,"type":"user","isMeta":true,"message":{"role":"user","content":"Imported from opencode session ses_demo (started 2026-01-01T00:00:00Z) by t3code-session-manager."},"uuid":"<u0>","timestamp":"<iso>","cwd":"<cwd>","sessionId":"<S>"}
// user message: content is a plain string
{"parentUuid":"<u0>","type":"user","message":{"role":"user","content":"<text>"},"uuid":"<u1>","timestamp":"<iso>","cwd":"<cwd>","sessionId":"<S>"}
// assistant message: content is an array of text blocks
{"parentUuid":"<u1>","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"<text>"}]},"uuid":"<u2>","timestamp":"<iso>","cwd":"<cwd>","sessionId":"<S>"}
```

**Recommendation:** write all 7 fields on **every** record: `parentUuid`, `type`, `message{role,content}`, `uuid`, `timestamp`, `cwd`, `sessionId`. Add `isMeta: true` only on the provenance record. This is the smallest set that also covers the variants that work only by accident (§2).

## 2. Required vs optional, measured per field

`T3` = import + render in T3Code. `CLI` = `claude --resume <uuid> -p` reconstructs the history (checked by asking for the first user message text and a codeword from turn 1).

| variant | change from the full record | T3 | CLI |
|---|---|---|---|
| A_full | none | imported, 4 items, title = first non-meta user text | **full history** |
| B_noChain | no `uuid` and no `parentUuid` on any record | imported, 4 items | **history lost**: the model sees only `<<HUMAN_CONVERSATION_START>>`, and there is no warning |
| I_noParentUuidKey | `uuid` kept, `parentUuid` key absent everywhere | imported, 4 items | **history lost**. stderr: `Warning: Resume transcript … has 5 user/assistant records but none carry parentUuid links; only 1 reached the resumed conversation … the file's producer must chain records (parentUuid null on the first, the previous record's uuid on each subsequent one).` |
| M_noFirstParentKey | `parentUuid` key absent only on the first record | ok | full history (absent = null) |
| C_cwdSidFirstOnly | `cwd` and `sessionId` only on record 0 (the meta record) | ok | full history |
| H_noCwd | no `cwd` anywhere | **not imported**: not a candidate, counted nowhere (as in S2) | full history (the CLI locates the file by its directory) |
| G_noSessionId | no `sessionId` anywhere | ok, thread id from the filename stem | full history |
| D_noTimestamp | no `timestamp` anywhere | ok, `createdAt` = file mtime | **`No conversation found with session ID: <uuid>`**, exit 1 |
| J_tsFirstOnly | `timestamp` only on record 0 | ok, `createdAt` = mtime | **`No conversation found`**, exit 1 |
| J2_tsLastOnly | `timestamp` only on the last record | ok, `createdAt` = mtime | full history |
| K_noRole | no `message.role` | ok | full history |
| E_stringAssistant | assistant `content` is a string, not blocks | ok | full history |
| F_endsWithUser | the conversation ends with a user record (brief's 4-record shape plus one) | ok, 3 items | ok: the dangling user text and the new prompt are merged into one turn |
| L_provNotMeta | provenance without `isMeta` | **visible as a normal user message, and it becomes the thread title** (5 items) | model sees it (same as with `isMeta`) |

Therefore:

- **T3 requires:** `type` (`user`/`assistant`), `message.content`, and `cwd` on at least one record that the metadata reader reaches (put it on the first line, which keeps the S2 `cwdOffsetBytes` cost minimal). At least one non-meta user message is needed (S2). The thread id is `import:claudeAgent:<sessionId>`, or the filename stem when there is no `sessionId`. T3 reads records in file order and ignores the uuid chain.
- **CLI requires:** a `uuid` / `parentUuid` chain (first `null` or absent, then each record's `parentUuid` = the previous record's `uuid`). The leaf, which is the last record, must carry a `timestamp`, otherwise the session is "not found". The CLI finds the file by name, `<uuid>.jsonl` in the encoded dir of the current cwd, so `sessionId` and `cwd` in records are not needed by the CLI.
- **Optional for both:** `sessionId` (if present it must equal the filename stem, or T3 and the CLI disagree on the id), `message.role`, the block-vs-string form of assistant content, and `isMeta` (it controls T3 visibility only).
- **Not needed by either:** `isSidechain`, `userType`, `entrypoint`, `version`, `gitBranch`, `promptId`, `requestId`, `message.id/model/type/stop_reason/usage`, and non-message record types (`queue-operation`, `attachment`, `file-history-snapshot`, `ai-title`, `last-prompt`, …).
- **Untested, keep defaults:** `message.model` on assistants. Without it T3 sets the thread model to the driver default (`claude-opus-5-5` here). S2 showed that T3 takes the model from the last `message.model`, so the converter can set it if it wants a specific model.

## 3. Rules

- **Filename / sessionId:** `<S>.jsonl`, where `S` is a lowercase RFC-4122 UUID (T3 rejects non-UUID Claude ids, S2). Write `sessionId: S` on every record.
- **Record uuids:** unique per record. Any UUID-shaped string worked; derive them deterministically (uuidV5 of `S` + index) so that re-conversion is byte-identical.
- **Chain:** strictly linear. `parentUuid` is `null` on record 0, and on record i>0 it is `uuid[i-1]`. The meta record is part of the chain, as the root.
- **Timestamps:** ISO 8601 UTC with milliseconds and `Z` (`Date#toISOString()`), on every record, non-decreasing. T3 thread `createdAt` = the timestamp of the first non-meta message. If that record has none, T3 falls back to the file mtime. Use the source harness's real message times. Make them strictly increasing (+1 ms on ties) so that the CLI's leaf choice is unambiguous.
- **mtime:** after writing, the file mtime is "now", which is inside the 30-day window. Older conversions still need the S2 bump → scan → import cycle. The record timestamps do not affect eligibility; only the mtime does.
- **Encoded dir:** every non-`[A-Za-z0-9]` character becomes `-` (`C:\work\t3code-session-manager\.spike\project3` → `C--work-t3code-session-manager--spike-project3`). This was confirmed: T3 and the CLI both found the file there.

## 4. Provenance (`isMeta: true` user record)

- **T3 timeline: hidden.** `itemCount` 4 of 5 records. It is excluded from the title, which is the first non-meta user text, and it is not in T3's handoff text (§5).
- **Model: sees it.** The Claude loader sends it as user text and merges it with the next user record into one user turn (the request blob showed `[{text:"Imported from opencode …\n"},{text:"Remember the codeword …"}]`). In T3, the answer to "Where did this conversation originally come from? Answer in one sentence." was: *"It started as an opencode session (`ses_demo`, begun 2026-01-01T00:00:00Z) that t3code-session-manager imported, and it was later handed off to this Claude thread (…)."* The CLI quoted it as part of "the first user message text".
- Without `isMeta` the provenance shows up as a user bubble and becomes the thread title. Keep `isMeta`.

## 5. How T3 resumes an imported thread (new observation)

On the **first** turn of an imported thread, T3 resumes the native Claude session (same `<S>.jsonl`, appended in place, `entrypoint:"t3-code"`). It also prepends a user message `Context handoff (manual_context): Provider context handoff. Thread: import:… Selected 4 intact items …` that replays the T3 timeline items as text (`[Historical user; …]` / `[Historical assistant; …]`, then `User message: <prompt>`). Consequences:

- In T3, a converted transcript with a **broken chain still "works"**: B_noChain answered the codeword question correctly in T3 and said the history came "as a handoff summary". The same file is history-less in the CLI. **Do not rely on the handoff. Always chain**, or terminal resume is silently broken.
- The handoff text omits meta records, so the provenance reaches the model through the native transcript only.

## 6. Branches and leaves: terminal resume vs T3 on the same file

Evidence comes from two runs, and both used `claude -p` (non-interactive) only:

- **Run 1:** the chain trace of transcript A, printed during the spike. The transcript itself was deleted at cleanup.
- **Run 2:** a re-run with 4 forked synthetic files `…0321`–`…0324`. Post-resume copies are kept in `.spike/raw-s3/branch-*.after.jsonl` (gitignored).

Record ids below are shortened to their distinguishing part.

**Run 1 sequence on A (`a000`…`a004` = the 5 converted records):**

| file line | record | parentUuid → uuid | writer |
|---|---|---|---|
| 4 | assistant (last converted message) | `a003` → `a004` | converter |
| 11 | attachment | `a004` → `…3ac8cc213dd5` | T3 turn 1 |
| 12 | user "Context handoff …" | `…3ac8cc213dd5` → `…03fd4cdd2f13` | T3 turn 1 (`entrypoint:"t3-code"`) |
| 42–43 | assistant (thinking, reply) | … | T3 turn 1 |
| 52 | system (end of turn) | `…068fe0f43512` → **`…32b54f7dac1d`** | T3 turn 1 |
| 54 | user "Reply with the word OK…" | **`…32b54f7dac1d`** → `…14c134f67b0a` | CLI (`entrypoint:"sdk-cli"`) |
| 55–74 | CLI attachments, assistant, system, `last-prompt` | … | CLI |
| 75 | user (T3 turn 2) | **`…32b54f7dac1d`** → `…0ca9ada18ec8` | T3 turn 2 |

**Run 2 forks.** Each file has records P → U1 → A1 (`b000`–`b002`), then branch X (`b003` user, `b004` assistant) and branch Y (`b005` user, `b006` assistant), both children of `b002`, X before Y in file order. The parent of the CLI's new user record shows which leaf it chose. The model's quote of "the last user message" agreed in all 4 cases.

| file | X ts | Y ts | appended after Y | CLI parented on | the model quoted |
|---|---|---|---|---|---|
| V1 `…0321` | t+10 | **t+5 (older)** | nothing | `b006` (**Y**) | BRANCH-Y |
| V2 `…0322` | t+10 | t+5 | `{"type":"last-prompt","leafUuid":"b004"}` (X) | `b004` (**X**) | BRANCH-X |
| V3 `…0323` | t+10 | t+5 | `{"type":"summary","leafUuid":"b004"}` (X) | `b006` (**Y**) | BRANCH-Y |
| V4 `…0324` | t+10 | t+12 | `system` record with uuid `b007`, parent `b004` (X) | `b007` (**X**, through the system record) | BRANCH-X |

### Rule 1: where T3 resumes from

- On a thread's **first** turn, T3's chain starts at the file's leaf. That leaf is the last converted record (`a004`), and T3's own attachment records come between it and the handoff user record.
- On **later** turns, T3's new user record has `parentUuid` = **the uuid of the last chain record T3 itself wrote in its previous turn**. In run 1 that was the `system` end-of-turn record `…32b54f7dac1d`. T3 does **not** re-read the file's leaf: the CLI turn appended after it (lines 54–74, which include their own `last-prompt`) was ignored.
- That parent is **not always a user/assistant record**. It was a `system` record here, and the first-turn chain went through an `attachment` record.
- **Not tested:** what T3 does after an app restart or after the thread's Claude process is recycled. It may then resume from the file's leaf (Rule 2). Merge must not depend on either behaviour.

### Rule 2: how `claude --resume` chooses the leaf

1. If the file has a `last-prompt` record whose `leafUuid` resolves to a record in the file, that record is the leaf (V2). The CLI writes `last-prompt` after every turn, from both T3 and the CLI, so in a resumed real file this is usually what decides. V2 had only one such record. With several, the newest one in file order is presumably used, because the CLI appends a fresh one every turn. That last point is inferred, not isolated.
2. Otherwise the leaf is **the last record in file order that has a `uuid`, whatever its type** (V1: file order beat timestamps; V4: a trailing `system` record became the leaf).
3. `summary.leafUuid` is ignored (V3).
4. Timestamps play no part in leaf choice (V1). A missing timestamp on the leaf makes the session "not found" (§2), which is a separate check.

### Rule 3: correction to the controller's leaf rule

The ruling "leaf = last record in file order that has a uuid, is not isSidechain, and is type user|assistant (skip non-message records like last-prompt, custom-title, system, summary)" is **close, but not what the CLI does**:

- **(a)** `last-prompt.leafUuid` takes precedence (V2).
- **(b)** `system` and `attachment` records that carry a uuid are chain nodes, and a trailing one is the leaf (V4).

The ruling yields the same message branch only when the trailing non-message records descend from the last message record. That held in every real turn observed, but V4 shows it is not guaranteed. `isSidechain:true` records were not tested. Keep excluding them: they belong to subagent chains.

**Rule for merge (matches the CLI):**

```
nodes  = records with a uuid (any type) and isSidechain !== true
leaf   = nodes[lastInFile(type == "last-prompt")?.leafUuid] ?? lastInFile(nodes)
chain  = walk parentUuid from leaf to the root (stop at null/absent or an unknown uuid), then reverse
messages = chain.filter(r => (r.type == "user" || r.type == "assistant") && !r.isMeta)
```

### Rule 4: finding the terminal branch vs T3's branch

- **Leaves.** Branch leaves are the nodes (as above) that no other node names as `parentUuid`.
- **T3's leaf.** It is the leaf whose chain contains the last record with `entrypoint:"t3-code"`. T3 writes that value. The CLI wrote `"sdk-cli"` for `-p` (the interactive value was not observed). Converted records have no `entrypoint`.
- **Terminal leaves.** Any other leaf whose chain extends beyond the fork point carries terminal work.
- **The branch merge rebuilds.** It is the leaf from Rule 2, the one `claude --resume` would continue. In run 1, after T3 turn 2, that was T3's branch. The earlier terminal turn hung off a non-selected leaf, so it was orphaned for both T3 and `claude --resume`. Merge should report such leaves (note `diverged-fork`) rather than drop them silently.
- **The fork point** is the deepest node shared by the two chains (`…32b54f7dac1d` in run 1).
- **Records without a uuid.** None needs to be carried into a revision transcript: resume worked with none present (§2, fixture). Specifically:
  - Do **not** copy `last-prompt`. A stale `leafUuid` redirects resume (V2). If one is written at all, it must point to the revision's own last uuid.
  - `summary` (V3), `custom-title`, `ai-title`, `agent-name`, `session-owner`, `atis-latch`, `mode`, `queue-operation`, `api-request*`, `cost-state` and `file-history-snapshot` are not used for reconstruction and can be dropped.
  - Re-emitting a title as one fresh `custom-title` record is optional and was not tested.

## 7. Rendering in T3

| content | T3 `thread show` text |
|---|---|
| flattened tool call `[tool bash] ls -la → total 8\n-rw-r--r-- …` in a user message | verbatim, newlines and `→` kept, no tool card |
| Portuguese and emoji `ação, coração, pão 🍞✅`, `—` | verbatim (UTF-8 round-trips) |
| assistant with 2 text blocks `["Noted the codeword.","2 + 2 = 4."]` | one message, **blocks joined with `"\n"`** → `Noted the codeword.\n2 + 2 = 4.` |
| same as a single string with `"\n\n"` (E) | `Noted the codeword.\n\n2 + 2 = 4.` |

For paragraph spacing, end a block with `\n` or emit one text block per message with `\n\n` separators. Either way the CLI model sees the same text.

## 8. Side effects in the account home

As in S2, each resumed turn (T3 or CLI) creates `session-env/<S>/` and `security/security_warnings_state_<S>.json`, and T3 turns also create `session-namer/state/<S>.json`, from user hooks. They also append non-message records (`custom-title`, `agent-name`, `session-owner`, `atis-latch`, `queue-operation`, `attachment`, `api-request*`, `last-prompt`, `mode`, `system`) to the transcript. A converted file is pristine only until its first resume. Rollback of a conversion that has since been resumed must not assume the file still has its written sha256.
