# Launch checklist

What to paste where when the repository goes public, and the release routine. Nothing here runs by itself.

The GitHub owner and name live in one place, `REPO` in [`scripts/release.js`](../scripts/release.js) (plus
`repository`, `homepage` and `bugs` in `package.json`). If the repository is renamed, change those, replace the old
name in the docs, and `node scripts/release.js --check` lists anything left behind (every `github.com/<owner>/<name>`
of this project in a tracked text file, plus the install pins).

## Repository settings

**Description** (Settings → General, or the ⚙ next to About):

> Bring every Claude Code, Codex, Pi and OpenCode session into T3 Code: resumable, under the right Claude
> subscription, reviewed before it writes, reversible.

**Website:** leave empty, or the README anchor `#quick-start`.

**Topics:** `t3code`, `t3-code`, `claude-code`, `codex`, `opencode`, `pi`, `ai-agents`, `coding-agents`,
`session-import`, `session-history`, `multiple-accounts`, `cli`, `typescript`, `nodejs`.

**Features:** Issues on, Discussions optional, Wiki off, Projects off. Private vulnerability reporting on (Security →
Settings → Private vulnerability reporting); [SECURITY.md](../SECURITY.md) points there.

**Branch protection for `main`:** require a pull request, require the `ci-ok` check and an up-to-date branch, block
force pushes and deletion. Restrict who can create `v*` tags.

## Social preview

GitHub accepts PNG, JPG or GIF (not SVG), at least 640×320, ideally 1280×640, under 1 MB.

1. `npm run assets` (the card is `docs/assets/social-light.svg` and `social-dark.svg`, 1280×640).
2. Open `docs/assets/social-light.svg` in a browser at 100% zoom with a 1280×640 window, and take a screenshot of
   the image (in Chrome or Edge DevTools: Ctrl+Shift+P → "Capture node screenshot" on the `<svg>`).
3. Settings → General → Social preview → Edit → Upload an image. Do not commit the PNG; the SVG is the source.

## Before the first public release

- [ ] `npm ci && npm run typecheck && npm test && npm run build` on a clean clone.
- [ ] `node scripts/release.js --check` prints `OK`.
- [ ] `node scripts/build-assets.js` leaves `git status --porcelain docs/assets` empty.
- [ ] The README renders on GitHub: hero and demo in light and dark mode, the narrow variants on a phone, the
      reduced-motion still of the demo.
- [ ] The private-data search (the denylist method in CONTRIBUTING.md) returns nothing.
- [ ] CI is green on Windows, macOS and Linux. The CI badge in the README points at this repository's workflow, so
      it shows as broken (404) until the repository exists and CI has run once; check that it renders after the
      first run. The other badges are static and render anywhere.
- [ ] After pushing the tag, from a machine without a clone:
      `npx -y github:brunobola-portfolio/t3code-session-manager#v0.2.0 --version` prints `0.1.0`, and `doctor` runs.
- [ ] In Claude Code: `/plugin marketplace add brunobola-portfolio/t3code-session-manager`, then
      `/plugin install t3sm@t3code-session-manager`, then ask "check my T3 Code sessions": the skill runs
      `t3sm doctor`.

## Release routine

```bash
node scripts/release.js 0.2.0    # bumps package.json, package-lock.json, the plugin manifests and every #vX.Y.Z pin,
                                 # dates the "Unreleased" changelog section (or adds a stub to fill in),
                                 # and prints the git commands below without running them
```

1. Fill in the `CHANGELOG.md` entry if the script added a stub (`--check` fails while it says TODO).
2. Commit on a `release/vX.Y.Z` branch, open a pull request, merge it once `ci-ok` is green.
3. On `main`: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
4. The [Release workflow](../.github/workflows/release.yml) checks that the tag matches every manifest and pin and is
   on `main`, runs the tests, and publishes the GitHub release with the changelog section as notes.

The package stays `"private": true`: it is distributed through `npx github:` and the plugin marketplace, not npm.

## Announcement text (short)

> t3sm brings every Claude Code, Codex, Pi and OpenCode session into T3 Code as resumable threads, each under the
> Claude subscription it was run with. Review a plan, apply in waves, undo with one command. MIT.
> `npx -y github:brunobola-portfolio/t3code-session-manager#v0.2.0 doctor`
