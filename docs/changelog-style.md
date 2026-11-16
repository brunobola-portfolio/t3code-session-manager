# Changelog style

`CHANGELOG.md` is read in three places: on GitHub, in the release notes (`node scripts/release.js --notes`), and in
the terminal (`t3sm changelog`, and the "What's new" that `t3sm update` prints). Write it for someone deciding
whether to update, in under a minute. Detail lives in the docs, the help topics and the pull request.

`npm run release:check` (and so CI) enforces the shape below on `## [Unreleased]` and on every release.

## The shape of a release

```markdown
## [0.3.2] - 2026-11-20

Answers now stick on the first try, and the background sync recovers by itself after a crash.

### Added

- **`t3sm recover <id>` brings back a conversation whose thread you deleted.** It asks first and undoes with
  `t3sm rollback`; see `t3sm help recover`.

### Fixed

- **Enter keeps your answers in `t3sm start`.** Before, it saved nothing and the import left those sessions out.
```

1. **Summary.** One paragraph under the heading, at most 2 sentences and 300 characters: what the release means for
   the user. If they have to do something after updating, say it here ("Run `t3sm start` again: ...").
2. **Sections.** Only the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ones, in this order: `Added`,
   `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Leave out the empty ones.
3. **Bullets.** One level, no nesting. Each starts with a **bold headline** that states the outcome in the user's
   words, then at most one or two plain sentences. 320 characters per bullet at most, 6 per section, 12 per release:
   group small changes into one bullet rather than listing each.

## Words

- Say what changed for the user, not how it was built. Leave out internal names, spec sections, scopes, file paths
  of the source and test names; they belong in the commit and the pull request.
- Headlines in the present tense, as a fact: "**Enter keeps your answers**", not "Fixed a bug where...".
- Name commands and options in backticks, exactly as they exist (run them). Point to the detail instead of copying
  it: "see `t3sm help history`" or a link to the docs.
- One idea per bullet. A breaking change or a manual step gets its own bullet and its mention in the summary.
- English only, plain words, no marketing ("blazing", "awesome"), no emoji, no issue chatter or TODO.

## Before you release

- `npm run release:check` prints OK.
- Read the section with `node scripts/release.js --notes`: if it does not fit one screen, cut it.
