## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was verified

<!-- Tests added or changed; commands run by hand (with T3SM_HOME pointing at a scratch folder). Live T3_E2E runs, if any. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] New write paths are journaled, have a rollback path and a test, and refuse without `--yes` on a non-terminal
- [ ] Fixtures and docs contain only synthetic data (no real paths, names, emails or project names)
- [ ] Docs updated if behaviour, options or the status of a harness changed (README and README.pt.md together)
- [ ] `npm run assets` run and `docs/assets/` committed if the art or the plan summary changed
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` for user-visible changes
