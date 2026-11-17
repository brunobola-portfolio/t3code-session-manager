# Roadmap

What comes after 0.4, grouped by how sure it is. Each item says the problem it solves, the approach in one line and
its status. **Next** is committed, **Later** is wanted but not scheduled, **Ideas** are open questions. Nothing here
is a promise of a date. Suggestions and votes:
[Discussions](https://github.com/brunobola-portfolio/t3code-session-manager/discussions/categories/ideas). What already works: the **Works with** table in the
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

## Done in 0.5

Built, not released yet: `t3sm stats`, a local summary of the sessions per agent, account and month and of what
was imported (nothing is sent anywhere; t3sm has no telemetry); `t3sm plan --html`, which also writes `plan.html`
with filters and a search box; `t3sm journal compact`, which drops the file-time entries of old, finished runs and
keeps a backup (rollback, undo and recovery see the same history); and titles written by T3 Code in
`t3sm organize --ai-titles` (opt-in, a cap per run, the count and the model shown first, undone like any organize
title, never in unattended sync; a live check against T3 Code is still due before the release). See the
[CHANGELOG](CHANGELOG.md).

## Done in 0.4

Moved out of the plan: t3sm on npm (`npm install -g t3code-session-manager`, no git needed), updates from where it
was installed, and releases built by GitHub Actions with provenance, staged on npm and approved with 2FA. See the
[CHANGELOG](CHANGELOG.md).

## Done in 0.3.0

Moved out of the plan: `t3sm organize` with undo, `t3sm status`, conversations from folders T3 Code refuses, system
notifications, the `/t3sm` commands inside T3 Code, and no longer refusing an untested T3 Code version (it warns once and goes ahead). See the
[CHANGELOG](CHANGELOG.md).

## Later

| Item | Problem | Approach | Status |
| :-- | :-- | :-- | :-- |
| Merging compacted sessions | A session compacted (`/compact`) after its import is never merged, so its terminal work stays out of T3 Code | Find a revision format that keeps every turn the compaction summarised, then merge like any other session | needs design |
| Smaller modules | The largest modules (`apply`, `importer`, `merge`, `rollback`, `doctor`) are about 700 lines each, which makes review slow | Split them by step without changing behaviour; the existing tests must pass unchanged | planned |
| Export and backup | Imported threads live only in T3 Code; there is no copy you can keep | `t3sm export` reads threads through T3 Code's API and writes a portable copy in a folder you choose | needs design |
| Review page | Deciding many changes at once is easier on a page than in a terminal list | `t3sm review`: a local page for bulk decisions, built on the organize plan | needs design |
| Titles written by T3 Code at import | `t3sm organize --ai-titles` covers imported titles that stay technical, but only after the import | The same opt-in in `t3sm apply`, with the same rules (a cap per run, the count and the model shown first, never in unattended sync) | planned |
| Origin tags | T3 Code cannot filter by where a conversation came from | `thread.tag.set` with `vscode`, `cli`, `codex` or the account, once T3 Code filters by tag | depends on T3 Code |
| `/t3sm` for other agents | The in-T3 commands exist only for Claude Code | The same commands for Codex and other agents T3 Code supports, once they have a command format | depends on T3 Code |
| Installers | Installing needs Node.js and an `npx` or `npm install -g` line | A winget package for Windows and a Homebrew formula for macOS and Linux | planned |

## Ideas

| Item | Problem | Approach | Status |
| :-- | :-- | :-- | :-- |
| Settled inside a project | T3 Code shows only unsettled threads in a project, so imported history needs `organize` to be visible | An upstream request to T3 Code for an option to show settled threads inside the project | depends on T3 Code |
| Richer timeline | Imported threads show at most 200 messages and no tool activity (commands, file edits) | Import the full timeline, including tool activity, if T3 Code adds an import surface for it | depends on T3 Code |

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
