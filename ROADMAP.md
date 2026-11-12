# Roadmap

What comes after 0.1.0, grouped by how sure it is. Each item says the problem it solves, the approach in one line and
its status. **Next** is committed, **Later** is wanted but not scheduled, **Ideas** are open questions. Nothing here
is a promise of a date. Suggestions and votes: open an issue. What already works: the **Works with** table in the
[README](README.md#works-with) and [docs/harnesses.md](docs/harnesses.md).

Status words: **in progress** (being built now), **planned** (agreed, not started), **needs design**, **depends on
T3 Code** (blocked on something T3 Code does not offer yet), **help wanted**.

## Next

| Item | Problem | Approach | Status |
| :-- | :-- | :-- | :-- |
| More agents | Gemini CLI, Cursor, Copilot CLI, Cline, Crush, goose, Amp, Grok Build, Qwen Code, Kilo and Antigravity sessions cannot be brought into T3 Code | One convert adapter per agent, following [docs/adding-a-harness.md](docs/adding-a-harness.md), with synthetic fixtures and honest status | planned, help wanted |
| Stable T3 Code releases | Only T3 Code nightlies were tested live; stable releases are not tested yet | Run the live checks against each stable release and add the ones that pass to the tested list | planned |
| macOS and Linux live runs | On macOS and Linux only unit tests have run (in CI), not a real import | Run the gated live tests and one real pilot import on each, and record the results in the docs | planned, help wanted |
| Timings of a full import | No full-size `apply` has been timed, so the README cannot say how long one takes | Publish measured figures from real imports in the CHANGELOG and the FAQ | planned |

## Later

| Item | Problem | Approach | Status |
| :-- | :-- | :-- | :-- |
| Merging compacted sessions | A session compacted (`/compact`) after its import is never merged, so its terminal work stays out of T3 Code | Find a revision format that keeps every turn the compaction summarised, then merge like any other session | needs design |
| Journal compaction | `journal.jsonl` only grows | A command that folds finished runs into a snapshot, keeping everything `rollback` and recovery need | planned |
| Smaller modules | The largest modules (`apply`, `importer`, `merge`, `rollback`, `doctor`) are about 700 lines each, which makes review slow | Split them by step without changing behaviour; the existing tests must pass unchanged | planned |
| Export and backup | Imported threads live only in T3 Code; there is no copy you can keep | `t3sm export` reads threads through T3 Code's API and writes a portable copy in a folder you choose | needs design |
| Installers | Installing needs Node.js and an `npx` or `npm install -g` line | A winget package for Windows and a Homebrew formula for macOS and Linux | planned |

## Ideas

| Item | Problem | Approach | Status |
| :-- | :-- | :-- | :-- |
| Richer timeline | Imported threads show at most 200 messages and no tool activity (commands, file edits) | Import the full timeline, including tool activity, if T3 Code adds an import surface for it | depends on T3 Code |
| HTML plan report | `plan.md` is long for machines with thousands of sessions | An optional `plan.html` with filters per project, account and skip reason, written next to `plan.md` | idea |
| Usage summary | People want to see what they have (sessions per agent, account and month) | A local `t3sm stats` command computed from discovery and the journal. Nothing is sent anywhere; t3sm has no telemetry | idea |

## Contributions wanted

- **A new agent.** Pick one from **More agents** and follow [docs/adding-a-harness.md](docs/adding-a-harness.md). If
  you cannot write it, the **Harness request** issue template collects what someone else needs.
- **A report from macOS or Linux.** Run `t3sm doctor` and `t3sm plan` (both read-only) and open an issue with what
  worked and what did not. Review the output first, as [CONTRIBUTING.md](CONTRIBUTING.md) explains.
- **A new version of a supported agent or of T3 Code.** If `doctor` reports drift or an untested version, an issue
  with the version and the warning helps.
- **Splitting a large module**, once you have read [docs/architecture.md](docs/architecture.md) and the tests that
  cover it.

How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents: [AGENTS.md](AGENTS.md).
