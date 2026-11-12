# From Codex CLI

[Português](codex.pt.md) · Status: 🟡 verified with fixtures ([harnesses.md](../harnesses.md#codex-cli-native))

`t3sm` is the command you install once ([install.md](../install.md)); `t3sm update` keeps it current.

## What gets imported

- Codex sessions stored as `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-*.jsonl` (default `~/.codex`), whatever
  their age, into T3 Code's Codex instance, by T3 Code's own Codex importer. They resume in Codex from T3 Code.
- Discovery was verified on real files, and every case is covered by synthetic fixtures. A live import of an
  uncompressed Codex session through t3sm has **not** been run yet: if you try it, please report what you see.
- **Compressed sessions** (`rollout-*.jsonl.zst`): Codex CLI 0.167 and later compress older sessions, and T3 Code
  reads only `rollout-*.jsonl`. t3sm reads each compressed file (decompressing it in memory; Codex's files are never
  changed), converts the conversation into a Claude Code transcript in the account of its project and imports it as a
  **Claude thread**: replying to it continues the conversation in Claude Code, on the project's account, with the Codex
  conversation as its history; the Codex session itself is left as it is. Kept: the user and assistant messages T3
  Code would show, and tool calls as one-line summaries (`[tool shell] ls -la → …`); reasoning is left out. Verified
  with fixtures, read-only discovery of real compressed files, and one synthetic compressed session converted and
  imported live. To keep them out instead, set `"codex": { "convertCompressed": false }` in `config.json`
  ([configuration.md](../configuration.md)).
- **One session, one thread:** a session already in T3 Code as a Codex thread (imported before Codex compressed it, or
  started in T3 Code) stays that thread; it is never converted into a second, Claude thread. `plan.md` lists it as
  "already in T3 Code as a Codex thread".

## What does not

- Compressed sessions larger than 512 MiB once decompressed, or with one line over 64 MiB (`too-large`), and
  compressed files that cannot be read completely (corrupt or cut short; `scan` counts them as read errors).
- A second rollout file of the same session (a plain and a compressed copy, or a `<id>_<child>` file Codex writes for
  example for a sub-agent): one file is imported, the others are listed in the plan as `duplicate`.
- Sub-agent rollouts, rollouts without a session id, without a working folder or with only hidden records.
- Uncompressed sessions, while T3 Code has no enabled Codex instance: they are skipped as `harness-unavailable` and
  `doctor` warns. Enable Codex in T3 Code's settings (Providers) first. Converted (compressed) sessions do not need it.

## Commands

```bash
t3sm doctor        # harness:codex
t3sm scan          # sessions per agent; Codex sessions appear in the codex row
t3sm plan
t3sm apply --dry-run   # what apply would do; writes nothing
t3sm apply
```

## Verify

`plan.md` counts the Codex sessions under the `codex` harness and says how many compressed ones it converts; after
`apply` they are threads of their projects in T3 Code: uncompressed ones on the Codex instance, converted ones on the
project's Claude account. `doctor` shows e.g. `codex-cli 0.167.1 · 4 importable natively, 107 convertible
(compressed), 1 skipped`.

## Undo

`t3sm rollback --run <id>` lists the imported threads (archive them with `--archive-threads`) and deletes the Claude
transcripts it wrote for converted sessions while they are unchanged. Codex's files are never written: t3sm only
moves the file time of uncompressed ones during a wave and puts it back.
