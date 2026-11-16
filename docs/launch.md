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
      From GitHub too: `npx -y github:brunobola-portfolio/t3code-session-manager#v0.4.1 --version`.
- [ ] In Claude Code: `/plugin marketplace add brunobola-portfolio/t3code-session-manager`, then
      `/plugin install t3sm@t3code-session-manager`, then ask "check my T3 Code sessions": the skill runs
      `t3sm doctor`.

## Release notes

The GitHub release takes its notes from the version's CHANGELOG section (`node scripts/release.js --notes`), written
in the shape of [changelog-style.md](changelog-style.md): a two-sentence summary for someone deciding whether to
update, then short bullets that open with a bold headline. The workflow adds how to install it (npm, GitHub, the
Claude Code plugin). Read the section once more before tagging: it is the first thing people see.

## Release routine

```bash
node scripts/release.js 0.2.0    # bumps package.json, package-lock.json, the plugin manifests and every #vX.Y.Z pin,
                                 # dates the "Unreleased" changelog section (or adds a stub to fill in),
                                 # and prints the git commands below without running them
```

1. Fill in the `CHANGELOG.md` entry if the script added a stub (`--check` fails while it says TODO); it follows
   [changelog-style.md](changelog-style.md), and `node scripts/release.js --notes` shows it as the release notes.
2. Commit on a `release/vX.Y.Z` branch and open a pull request, for CI only. Once `ci-ok` is green, land it by
   fast-forward: `git push origin release/vX.Y.Z:main`. Never GitHub's merge button or `gh pr merge`: `main` takes
   only commits whose `ci-ok` passed (a repository ruleset), in a linear history.
3. On `main`: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
4. The [Release workflow](../.github/workflows/release.yml) checks that the tag matches every manifest and pin and is
   on `main`, runs the tests, **stages** the package on npm with provenance (skipped when that version is already
   published or staged), and publishes the GitHub release with the changelog section as notes.
5. Approve the staged version with 2FA: npmjs.com -> `t3code-session-manager` -> Staged Packages -> Approve (or
   `npm stage approve <stage-id>`). Only then is it installable, and the watchers start updating to it.

**npm publishing.** The package is `t3code-session-manager` (public, `publishConfig.access`), owned by the `bolalabs`
npm account. Every release goes through npm's [staged publishing](https://docs.npmjs.com/staged-publishing): the
workflow runs `npm stage publish` (npm 11.21.2, pinned) on the exact tarball it checked (`channel: "npm"` in
`dist/build.json`), so nothing reaches users before a maintainer approves it with 2FA, and the provenance links it to
the tag's commit and this workflow. Authentication is npm's Trusted Publisher for `release.yml` on this repository
(OIDC through `id-token: write`, no secret), restricted to stage-only: on npmjs.com, package Settings -> Trusted
Publisher -> GitHub Actions, workflow `release.yml`, staging only. The `NPM_TOKEN` repository secret is only the
fallback while that is not configured; delete it (and the token on npmjs.com) once it is. Recommended in the package's
access settings: "Require two-factor authentication and disallow tokens". The package is also on GitHub
(`npx github:`) and in the plugin marketplace.

## Announcement text (short)

> t3sm brings every Claude Code, Codex, Pi and OpenCode session into T3 Code as resumable threads, each under the
> Claude subscription it was run with. It writes a plan first, imports through T3 Code's own importer, journals every
> change and undoes any run with one command. MIT, zero runtime dependencies.
> New in 0.4: on npm, with provenance. `npm install -g t3code-session-manager`, then `t3sm`.
