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

1. `npm run assets` (the card is `docs/assets/social-light.svg` and `social-dark.svg`, 1280×640). For the 0.3.0
   announcement the preview shows the before and after instead: `docs/assets/organize-light.svg` (1280 wide; frame the
   screenshot at 1280×640, or crop the two sidebars).
2. Open the chosen SVG, for example `docs/assets/social-light.svg`, in a browser at 100% zoom with a 1280×640
   window. Take a screenshot of the image (in Chrome or Edge DevTools: Ctrl+Shift+P → "Capture node screenshot" on the `<svg>`).
3. Settings → General → Social preview → Edit → Upload an image. Do not commit the PNG; the SVG is the source.

## Before the first public release

- [ ] `npm ci && npm run typecheck && npm test && npm run build` on a clean clone.
- [ ] `node scripts/release.js --check` prints `OK`.
- [ ] `node scripts/build-assets.js` leaves `git status --porcelain docs/assets` empty.
- [ ] The README renders on GitHub: hero, demo and the organize before/after in light and dark mode, the narrow variants on a phone, the
      reduced-motion still of the demo.
- [ ] The private-data search (the denylist method in CONTRIBUTING.md) returns nothing.
- [ ] CI is green on Windows, macOS and Linux. The CI badge in the README points at this repository's workflow, so
      it shows as broken (404) until the repository exists and CI has run once; check that it renders after the
      first run. The other badges are static and render anywhere.
- [ ] After pushing the tag, from a machine without a clone:
      `npx -y t3code-session-manager@<version> --version` prints the release's version, `doctor` runs, and the
      package page on npmjs.com shows its provenance (the tag's commit and the Release workflow).
      From GitHub too: `npx -y github:brunobola-portfolio/t3code-session-manager#v0.4.0 --version`.
- [ ] In Claude Code: `/plugin marketplace add brunobola-portfolio/t3code-session-manager`, then
      `/plugin install t3sm@t3code-session-manager`, then ask "check my T3 Code sessions": the skill runs
      `t3sm doctor`.

## Release notes for 0.3.0

The GitHub release takes its notes from the changelog section. The highlights to read first, in this order:

- `t3sm organize` (and `--undo`): archive automated sessions, readable titles, history inside each project, pin recent
  projects, delete empty projects t3sm created. Optional, previewed, journaled, undoable.
- Conversations from folders T3 Code refuses (home, Downloads, `Documents/Codex`) are copied whole into the
  project they worked on, or into General. Continuations made outside T3 Code after the import do not come in.
- `t3sm status`, optional system notifications, and `/t3sm:status|sync|organize|import` inside T3 Code.
- Does not refuse an untested T3 Code version: it warns once and goes ahead.
- Checks before publishing: `npm run release:check` prints OK and `docs/assets/` has no drift.

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
   on `main`, runs the tests, publishes the package to npm with provenance (skipped when that version is already
   there), and publishes the GitHub release with the changelog section as notes.

**npm publishing.** The workflow publishes as `t3code-session-manager` (public, `publishConfig.access`). The first
release used a temporary granular token (`NPM_TOKEN` repository secret); from then on npm's Trusted Publisher for
`release.yml` on this repository authenticates it through OIDC (`id-token: write`), with no secret: on npmjs.com,
package Settings -> Trusted Publisher -> GitHub Actions, workflow `release.yml`; then delete the token and the secret.
The package is also on GitHub (`npx github:`) and in the plugin marketplace.

## Announcement text (short)

> t3sm brings every Claude Code, Codex, Pi and OpenCode session into T3 Code as resumable threads, each under the
> Claude subscription it was run with. Review a plan, apply in waves, undo with one command. MIT.
> New in 0.3.0: `t3sm organize` brings the imported history back into each project, archives the automated noise
> and gives conversations readable titles. Every part is optional, and it never touches what you changed by hand.
> `npx -y t3code-session-manager doctor`
