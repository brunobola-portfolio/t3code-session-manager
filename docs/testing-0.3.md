# Testing t3sm 0.3 on your own machine

[Português](testing-0.3.pt.md)

A hands-on guide to check the 0.3 release yourself, live, on your own PC and on others: install it, migrate a 0.2.1
setup, answer the guided set-up's questions, look at the result in T3 Code and in Claude Code, run the gated live
tests, watch a self-update and a rollback, and know what to send back when something looks wrong.

Every command here exists in 0.3.1 (`t3sm recover` is new in it); run `t3sm <command> --help` for the details. Everything t3sm writes is journaled
and can be undone (`t3sm runs`, `t3sm rollback --run <id>`). The examples use placeholders:
`D:\Work\t3code-session-manager` is your checkout of the repository (named like the repository, so its T3 Code project
is `t3code-session-manager`), `~` your home folder; on macOS or Linux use a path such as
`~/work/t3code-session-manager`.

| Part | What it checks | Time |
| :-- | :-- | :-- |
| [A](#a-a-fresh-pc) | A fresh install and the guided set-up | 20-40 min |
| [B](#b-migrating-a-pc-from-021) | Moving a PC with 0.2.1 and a running watcher to 0.3.1, then T3 Code and Claude Code | 30-60 min |
| [C](#c-the-gated-live-tests) | The live tests that decide two settings in `src/t3/compat.ts` | 10 min |
| [D](#d-the-self-update-cycle) | An update, the watcher's restart, a forced rollback | 20 min |
| [E](#e-other-pcs-and-systems) | What differs on another Windows PC, macOS and Linux | - |
| [F](#f-what-good-looks-like-and-what-to-send-back) | The expected end state, and what to send if it is not | - |
| [G](#g-working-from-t3-code-from-now-on) | Day to day after the set-up: what reaches T3 Code by itself and what needs you | - |

## Before you start

- **Node.js 22.18 or newer** (`node --version`), **git** (`git --version`) and npm on `PATH`.
- **T3 Code open**, started from the Start menu (macOS: Dock or Launchpad; Linux: your launcher), never from a terminal.
- **A shell without `CLAUDE_CONFIG_DIR`.** PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue`.
  Bash: `unset CLAUDE_CONFIG_DIR`. Run every command below from that shell, as your normal user (not "Run as
  administrator": t3sm then warns that what it installs is for that user only).
- **The release, merged and tagged.** At the end of the build Claude merges 0.3 into `main` and tags it `v0.3.1`, so
  it is there before you start. Check, in this order:

  ```powershell
  git -C D:\Work\t3code-session-manager status --short     # prints nothing: no local changes
  git -C D:\Work\t3code-session-manager switch main
  git -C D:\Work\t3code-session-manager tag --list v0.3.1  # prints v0.3.1
  node D:\Work\t3code-session-manager\bin\t3sm.mjs --version   # 0.3.1
  ```

  If one of these says something else, stop here and ask before going on.
- **Check that T3 Code lists every thread**, before the first apply or guided set-up. t3sm copies a conversation T3
  Code started back into T3 only when T3 no longer lists its thread, so a list that misses live threads would make a
  second thread for a conversation that is still there. This check is read-only:

  ```powershell
  cd D:\Work\t3code-session-manager
  $env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/live.test.ts; Remove-Item Env:T3_E2E
  ```

  It prints `live: thread list: active=<A> archived=<B>`. Compare A with the threads T3 Code shows in its sidebar,
  across every project and the Settled shelves, and B with its archived threads. If your `t3` CLI has
  `t3 thread list`, its count should be A + B. If a number differs, stop here and send both numbers; until that is
  sorted out, answer "no" when the set-up asks about conversations deleted in T3 Code (`organize.sessions.orphaned`
  "skip"). (Even when the numbers match, t3sm lists T3 Code's threads once more right before it copies one of those
  conversations back, and leaves out any whose thread is listed again.)
- **Optional, recommended on your main PC: a copy of t3sm's state folder**, so you can compare before and after. It
  holds your config, the journal and the plans; nothing here needs it, it is only a safety copy.

  ```powershell
  Copy-Item -Recurse ~\.t3code-session-manager ~\t3sm-state-before-0.3
  ```

## A. A fresh PC

### A1. Install

From GitHub, once `v0.3.1` is published there:

```bash
npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.4.0
```

(Use the tag of the release you test: the line in the README always names the current one.)

From a folder on a local disk (copy it from a USB stick or a share first: `t3sm update --from` later refuses a
network path):

```powershell
npm install -g --install-links D:\Work\t3code-session-manager
t3sm --version                      # 0.3.1
```

npm builds the package with Node alone (`prepare` writes `dist/` inside the folder; it is git-ignored).

### A2. Check

```powershell
t3sm doctor
```

Good: a table of checks, each with ✓ (ok), ! (a warning) or ○ (nothing to check here), then the warnings in full with
what to do, and a verdict panel; exit 0. Normal warnings on a new PC: "T3 Code version" (a T3 Code build t3sm was not
tested with; it proceeds), "Scheduled sync" and "Watcher" (nothing installed yet), "t3sm plugin" (the `/t3sm` commands
not installed). A ✗ (a failure) says how to fix it; fix it first. (`t3sm doctor --json` names the checks by id:
`t3-version`, `schedule`, `sync-watcher`, `t3sm-plugin`.)

### A3. The guided set-up

```powershell
t3sm start            # or just: t3sm
```

On a Portuguese system it speaks Portuguese; `--lang en` or `--lang pt` chooses. What each screen should look like:

| Step | What you see | Answer |
| :-- | :-- | :-- |
| 1 Welcome | A header with the version (0.3.1) and how many Claude accounts t3sm found; on a second run, a checklist of the steps (✓ done, ◉ next, ○ later) | `y` |
| 2 Check | Every doctor check in a compact grid, then "Worth knowing" only for what concerns you | `y` |
| 3 Accounts | A table of your Claude accounts (emails masked) and their T3 Code instances | `y` if the names are right |
| 4 Plan | A panel with the counts aligned (to import, to convert, skipped), then the projects and their accounts | Enter (or `c`) to continue |
| 5 Decisions | One panel per question, with the real numbers, the default and the `config.json` key to change it later; the answers are saved as soon as you answer the last one | see B5 |
| 6 Clean-up | Only when the plan found backup folders or mirror copies | your choice |
| 7 Pilot | Small projects to try first, then "Here is what I will do" | pick one, `y` |
| 8 Full import | "Here is what I will do", then one progress bar, then a result panel | `y` |
| 9 Organize | A before/after table per project, then one question per part | see B5 |
| 10 Keep in sync | The background watcher | `y` |
| 11 Done | One panel: what changed, how to undo it, what happens next | - |

Every step header has a rail like `● ● ● ◉ ○ ○ ○ ○ ○ ○ ○  Step 4 of 11 · Plan`. Write questions default to no: type
`y` (in Portuguese `s`). `?` explains, `b` goes back (Portuguese `v`), `q` stops; run `t3sm` again to continue.

### A4. After

```powershell
t3sm status          # ✓ All good · t3sm does not need anything from you   (exit 0)
t3sm schedule status # the scheduler entry, its command, the watcher heartbeat, the last cycle
```

## B. Migrating a PC from 0.2.1

This is the full move of a PC that runs 0.2.1 with a background watcher, home-folder conversations, conversations
started in T3 Code and at least one whose T3 Code thread was deleted.

> **If you already ran 0.3.0:** install 0.3.1 (as in B2, or `t3sm update --from D:\Work\t3code-session-manager`),
> then run `t3sm start` again (B5). The questions come back: 0.3.0 asked "save the answers?" after the decisions, and
> its default No kept every answer (and those conversations) out; and the history question returns once for a 0.2.1
> `config.json`. Answer them as in B5; the import then brings the conversations that stayed out.

### B1. Note where you are

```powershell
t3sm --version          # 0.2.1
t3sm schedule status    # the watcher and its last cycle
t3sm runs               # note the newest run id
```

Take a screenshot of T3 Code's sidebar if you want a before/after.

### B2. Install 0.3.1 from the folder

```powershell
npm install -g --install-links D:\Work\t3code-session-manager
t3sm --version          # 0.3.1
```

The 0.2.1 watcher keeps running the old code from memory meanwhile; the next step replaces it. (0.2.1 has no
`update --from`; from 0.3.0 on, `t3sm update --from D:\Work\t3code-session-manager` does this step and the next together.)

### B3. Replace the watcher

```powershell
t3sm schedule install --watch --dry-run
t3sm schedule install --watch --yes
```

The dry run says it would stop a running watcher and start the new one. The real run says
`Stopped the running watcher (pid <n>) and started the new one.` and exits 0. (On a PC where no watcher was running:
`No watcher was running; started it.`) How it stopped it: the 0.2.1 watcher
cannot answer a stop request, so t3sm read its pid from the heartbeat, checked that this process's command line is a
t3sm watcher (`node ... t3sm sync --watch`) and that it started when the heartbeat says, and only then ended it. Never
by name. If a watcher is already on 0.3, use `t3sm schedule restart --yes` instead.

Something else instead? `The background watcher is still running (pid <n>) and could not be stopped safely` (exit
1): end that one process yourself (Task Manager, by that pid; Ctrl+C in its window if it has one), then run the
command again. When the message names no pid (`The background watcher is still running and could not be stopped
safely`), `t3sm schedule status` shows the watcher's pid on its Watcher line: end that process, then run the command
again.

### B4. Check the heartbeat

```powershell
t3sm status
t3sm status --json      # "watcher": { "running": true, "pid": <n>, "version": "0.3.1", "stale": false }
t3sm doctor             # ✓ Scheduled sync, ✓ Watcher
```

`t3sm status` shows `Watcher  running (pid <n>, t3sm 0.3.1)`. If it says the watcher "still runs t3sm 0.2.1" or
"runs an older t3sm that does not restart itself after an upgrade", B3 did not replace it: run `t3sm schedule restart --yes`.

Then restart it twice in a row, and check that one watcher is left and nothing needs you:

```powershell
t3sm schedule restart --yes   # Stopped the running watcher (pid <n>) and started the new one.
t3sm schedule restart --yes   # the same line, with the pid of the watcher the first restart started
t3sm status                   # ✓ All good; Watcher  running (pid <m>, t3sm 0.3.1), the pid of the second restart
```

Task Manager (Details, `node.exe`, the Command line column) shows one `t3sm ... sync --watch`, with that pid.

### B5. The guided set-up, in Portuguese

```powershell
t3sm start --lang pt
```

(On a Portuguese system plain `t3sm` is already Portuguese.) The welcome shows a checklist of what is done and where
it continues. If it says `Outra execução do t3sm está a trabalhar agora (processo <n>)` ("Another t3sm run is working
right now"), a watcher cycle or another window holds t3sm's lock: wait a minute and run `t3sm start --lang pt` again.
Then:

1. **Passo 5 · Decisões.** One panel per open question. Answer:
   - *A tua pasta pessoal* — "Pôr cópias destas conversas nos projetos certos?" → `s`.
   - *Iniciadas por programas* (automated, Agent SDK) — "Importar estas conversas?" → `n`.
   - *Apagadas no T3 Code* (orphaned) — "Trazer de volta estas conversas como cópias?" → `s`.
   - Other questions (refused, temp, system folders): the defaults are fine.

   There is no "save the answers?" question: the answers are saved in `config.json` as soon as you answer the last
   one, with one line, "Respostas guardadas no config.json; podes mudá-las depois em organize." `q` before the last
   answer saves nothing.

   Then "Para onde vão as cópias": one row per folder the copies come from, with where t3sm will put them and why
   ("63 de 80 caminhos em ..."). Check that your home folder's conversations about t3sm go to the
   `t3code-session-manager` project (the inferred project). `e` changes a destination; Enter confirms. Only when you
   changed something does it ask "Guardar estes destinos no config.json?" (`s`).
2. **Passo 6-8.** Clean-up if offered; the pilot can be skipped (`n`) on a PC that already imported once; then
   "Importar tudo agora?" → `s`. One progress bar ("A importar N conversas · M projetos"), then the result panel. A
   project held because a conversation in it is in use (this terminal's own conversation, for example) waits and is
   imported once idle for 10 minutes; the panel says so.
3. **Passo 9 · Arrumar.** A table per project (shown now → after). Then:
   - "Mostrar os últimos 90 dias, e pelo menos 10 por projeto?" → Enter or `s` (90 / 10). After the upgrade from
     0.2.1 the panel also says what you had, "Até agora: todas as conversas visíveis." (0.2.1 kept every conversation
     visible): it is asked once more, with the 0.3 rule, even when nothing would change.
   - Titles, automated, pins, empty projects: the defaults are fine.
   - If asked, "Deixar também o T3 Code arrumar as conversas começadas no T3 passados 90 dias? Agora: passados 15
     dias." → `s` (T3 Code's own option set to 90; `n` leaves it as it is, never off; it is not asked when it is
     already at 90). With a rule longer than 90 days or all of it, a numbered menu instead; pick by its label, the
     numbers depend on what applies: "Manter (...)" (Enter), "Pôr em 90 dias", "Desligar". `?` explains why the order
     is safe.
   - "Aplicar estas alterações ao T3 Code agora?" → `s`.
4. **Passo 10-11.** The watcher is already installed (B3). For each Claude account without the `/t3sm` commands,
   step 11 offers "Instalar o plugin em <conta> (<pasta>)?" (default no). `s` runs `claude plugin marketplace add`
   and `claude plugin install` for that account, which go online; `n` is fine for this test. The last panel lists
   what changed and how to undo each run.

### B6. Check in T3 Code

Open T3 Code (from the Start menu) and check:

- [ ] **Every project shows its recent history**: the conversations of the last 90 days inside the project, and at
  least 10 when the project has that many. Older ones are on the **Settled** shelf at the bottom of the sidebar,
  still attached to their project (filter the shelf by project).
- [ ] **The `t3code-session-manager` project holds the conversations made in the home folder**, including the long
  conversations that built t3sm, with their full history (open one and scroll). A conversation still being written
  when you ran B5 is copied later, by the watcher, once it has been idle for 10 minutes.
- [ ] **No duplicates of conversations started in T3 Code**: each still appears once. `t3sm plan` lists them in
  `plan.md` under "Skipped by reason" as `already-in-t3` with the note `started-in-t3`.
- [ ] **The deleted one is back**: a conversation whose thread you had deleted in T3 Code is a thread again, in its
  project, with its history. When its transcript names no T3 Code thread, t3sm cannot tell it was deleted:
  `t3sm status` lists it under Worth knowing ("... bring one back with t3sm recover <id>"). Then
  `t3sm recover <id> --dry-run` shows what it would do, and `t3sm recover <id>` asks and brings it back as a copy
  with a new id (a duplicate if the thread still exists; undo with `t3sm rollback --run <id> --archive-threads`).
- [ ] **No conversation keeps failing for nothing**: `t3sm status` does not list conversations started in T3 Code
  under "keep failing to import".
- [ ] **The conversations kept for the minimum are marked** (only while T3 Code's own option is on, a week before it
  could reach them): before the apply, `t3sm organize --dry-run` lists "Keep N conversations shown in P projects,
  marked so T3 Code's own auto-settle never puts them away" for a project that keeps such conversations. After the apply,
  `t3sm status` is clean and those conversations stay shown in their project. A mark sets T3 Code's `unsettledAt`, so
  they may move in T3 Code's working-shelf sort; that is expected. `t3sm organize --undo --dry-run` lists them as kept
  (a mark cannot be undone).
- [ ] **T3 Code's own option**: in T3 Code's settings, the auto-settle option for its own conversations is at 90 days.
- [ ] **Undo is there**: `t3sm runs` lists the runs of B5; `t3sm organize --undo --dry-run` shows what the organize
  run would put back (do not run it unless you want to).

### B7. Check in Claude Code

```powershell
cd D:\Work\t3code-session-manager
claude --resume
```

- [ ] The picker lists the copies t3sm made in this project (they keep their original titles and first messages).
- [ ] Picking one opens it with its full history. To only look, leave without sending a message (Ctrl+C twice): a
  message is a real turn on your subscription, and a copy you continue outside T3 Code is no longer "untouched", so
  t3sm stops updating it from its original and reports it in `t3sm status` if the original grows too.

### B8. Check that a copy follows its original

1. In VS Code, opened on your home folder, continue one of the home-folder conversations that was copied: send one
   short message.
2. Leave it alone for at least 10 minutes. The watcher's next cycle (once changes go idle, or every 15 minutes) brings
   the new message in.
3. In T3 Code: a new thread with the same title in the `t3code-session-manager` project, holding the new message; the
   old thread is archived. `logs/sync.log` (in `~\.t3code-session-manager\logs\`) has a cycle line with `followed=1`.

## C. The gated live tests

Two live tests measure how your T3 Code behaves and decide two constants in `src/t3/compat.ts`. They need Windows,
T3 Code running, and your yes: they write synthetic sessions into your real `~\.claude` and T3 Code (disposable
projects under the checkout's `.spike\` folder) and remove everything they created in `finally`.
`organize.live` also spends a few tokens (one `claude --resume -p` turn), and S7b one model turn.

From the checkout, once: `npm install` (TypeScript and `@types/node` only). Then, one file at a time:

```powershell
cd D:\Work\t3code-session-manager
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/followup.live.test.ts
$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/organize.live.test.ts
Remove-Item Env:T3_E2E
```

Bash: `env -u CLAUDE_CONFIG_DIR T3_E2E=1 node --test --test-timeout=180000 test/e2e/followup.live.test.ts`.

### Reading `followup.live` (S7 and S8)

It never fails on an outcome; it prints one JSON line per case. Look for lines starting with `{"case":`:

| Case | Field | Values |
| :-- | :-- | :-- |
| `S7a` (file grows, imported again) | `outcome` | `grew-same-thread`, `nothing-happened`, `error`, `other` |
| `S7b` (continued in T3 Code first, then the file grows) | `outcome` | the same, or `send-failed` (nothing measured) |
| `S8` (settle with a past `settledAt`) | `outcome` | `honoured`, `ignored`, `rejected`, `no-settledAt-seen` |

What to change in `src/t3/compat.ts`:

- `FOLLOW_MODE`: set `"refresh"` **only if S7a and S7b both say `grew-same-thread`**. Anything else, keep
  `"revision"` (a copy that follows its original becomes a new thread and the old one is archived).
- `SETTLE_BACKDATE`: set `true` **only if S8 says `honoured`** (the stored `settledAt` equals the one sent). Then the
  Settled shelf shows each conversation at its real date. Anything else, keep `false`.

If you change one: run `npm run typecheck` and `npm test`, write the lines into the "Results" section of
`docs/spikes/S7-followup-and-backdate.md`, add a line to `CHANGELOG.md` under `## [Unreleased]`, and release it as a
patch (0.3.2). Your watcher then installs it by itself (part D shows how).

### Reading `organize.live`

It passes or fails like a normal test. It imports synthetic conversations into a disposable project, archives the
automated one, shows both human ones, retitles the technical one, pins the project, undoes all of it; copies a
synthetic home-folder conversation into a project and resumes it with `claude --resume`; creates and deletes an empty
project. A failure prints which step; anything it could not remove is logged with the command that removes it.

## D. The self-update cycle

Do this on a second PC or a virtual machine if you can: it leaves your PC on a test version until you clean up (step
D6). Use a throwaway clone so your real checkout's tags stay clean, and keep the watcher installed (`t3sm schedule
status` shows it): without one there is nothing to health-check.

### D1. A test release

```powershell
git clone D:\Work\t3code-session-manager D:\Work\t3sm-update-test
cd D:\Work\t3sm-update-test
git switch main
git config user.name "t3sm test"           # only in this clone; needed on a machine where git has no name yet
git config user.email "test@example.com"
node scripts/release.js 0.3.2      # edits the version files only; it may say "Still to fix": fine for a test
git commit -am "test release 0.3.2"
git tag -a v0.3.2 -m v0.3.2
```

### D2. Look, then update

```powershell
t3sm update --check
t3sm update --from D:\Work\t3sm-update-test --dry-run
t3sm update --from D:\Work\t3sm-update-test
```

- `--check` shows the installed version (0.3.1), the newest release of the current source (GitHub until a folder is
  remembered), the kind, whether automatic updates are on, and the last check. Read-only.
- The dry run shows a panel `t3sm 0.3.1 -> 0.3.2 (patch)`, `from the folder D:\Work\t3sm-update-test`, then that
  tag's CHANGELOG section under "What's new", and ends with
  `Would install t3sm 0.3.2 from the folder D:\Work\t3sm-update-test. Nothing changed.` Nothing is installed.
- The real run asks `Install t3sm 0.3.2?` (`y`), then: `Installing t3sm 0.3.2 with npm...`,
  `Restarting the background watcher...`, `Waiting for the watcher to start on 0.3.2 (up to 2 minutes)...`,
  `Updated t3sm 0.3.1 -> 0.3.2.` Exit 0.

Then:

```powershell
t3sm --version                   # 0.3.2
t3sm status                      # Watcher  running (pid <n>, t3sm 0.3.2); worth knowing: "Updated to 0.3.2 today"
t3sm update --check              # Source: the folder D:\Work\t3sm-update-test (now remembered)
Select-String '"t":"update"' ~\.t3code-session-manager\journal.jsonl   # pending, then installed
t3sm status --json               # "watcher": { "running": true, "version": "0.3.2", ... } and a new pid
```

The update ends `installed` only once the new watcher wrote its heartbeat on 0.3.2: the journal's last update entry
says `installed`, and `t3sm status --json` shows the watcher running 0.3.2 under a pid other than the one before.

### D3. Watch the watcher restart itself

This is the path for an install the watcher did not do itself.

```powershell
cd D:\Work\t3sm-update-test
node scripts/release.js 0.3.3
git commit -am "test release 0.3.3"
git tag -a v0.3.3 -m v0.3.3
npm install -g --install-links D:\Work\t3sm-update-test
```

Within one cycle (at most `schedule.everyMinutes`, 15 by default) plus 30 seconds, the running 0.3.2 watcher sees the
new install, stops cleanly and starts the new one. `logs/sync.log` gets `restart from=0.3.2 to=0.3.3`, and
`t3sm status` shows the watcher on 0.3.3. If it says "t3sm 0.3.3 is installed; the background watcher switches to it
after its next cycle", wait for that cycle.

### D4. Force a rollback

Make a release whose watcher cannot start: in the test clone, put this line right after the first line of
`bin/t3sm.mjs`:

```js
if (process.argv.includes("--watch")) process.exit(1);
```

```powershell
node scripts/release.js 0.3.4
git commit -am "test release 0.3.4 (broken watcher)"
git tag -a v0.3.4 -m v0.3.4
t3sm update --yes
```

It installs 0.3.4, restarts the watcher, waits 2 minutes for a heartbeat that never comes, then
`The new version did not start: putting 0.3.3 back...` and ends with
`t3sm 0.3.4 did not start properly, so 0.3.3 was put back (...)` (exit 1). t3sm recovered by itself, so it does not
need you. Check:

- [ ] `t3sm --version` is 0.3.3 and `t3sm status` shows the watcher running on 0.3.3.
- [ ] `t3sm status` says "All good" (exit 0) and lists under "Worth knowing":
  "t3sm 0.3.4 was rolled back; 0.3.3 is running (the automatic check skips 0.3.4)", with `t3sm update --check`.
- [ ] `t3sm update --check` still shows 0.3.4 as the newest release, marked "it was rolled back before, so the
  automatic check skips it". The automatic check never installs it again; `t3sm update` would still install it on
  purpose (do not, here).
- [ ] The journal has an `update` entry with `"outcome":"rolled-back"`.

### D5. The automatic path (optional)

With `update.auto` on (the default), the watcher looks once a day; a newer patch or minor release on the remembered
source is installed by a hidden `t3sm update --auto-run --yes`, with the same health check. To see it, make a good
0.3.5 in the test clone:

```powershell
cd D:\Work\t3sm-update-test
git revert --no-edit HEAD                  # takes the broken line out of bin/t3sm.mjs (and 0.3.4's version bump)
node scripts/release.js 0.3.5
git commit -am "test release 0.3.5"
git tag -a v0.3.5 -m v0.3.5
```

Leave the PC on, with the watcher running, for up to a day. Then `t3sm --version` is 0.3.5, `t3sm status` says
"Updated to 0.3.5 today - what's new: t3sm changelog" and `logs/sync.log` has the update. `t3sm update --auto off`
turns automatic updates off.

### D6. Clean up

t3sm never downgrades, so it will not go back to 0.3.1 by itself, and the remembered source still points at the test
clone. Put things back by hand:

```powershell
t3sm schedule remove --yes
git clone --depth 1 --branch v0.3.1 file:///D:/Work/t3code-session-manager $env:TEMP\t3sm-v0.3.1
npm install -g --install-links $env:TEMP\t3sm-v0.3.1
Remove-Item ~\.t3code-session-manager\update.json      # forget the test source and the skipped version
Remove-Item -Recurse -Force D:\Work\t3sm-update-test, $env:TEMP\t3sm-v0.3.1
t3sm schedule install --watch --yes
t3sm --version                                         # 0.3.1
```

Without `update.json` t3sm follows GitHub again. For the next real release from your checkout, run
`t3sm update --from D:\Work\t3code-session-manager` once; from then on the watcher follows that folder.

`t3sm status` then says "All good" (exit 0). If you skipped D5, it also lists one line under "Worth knowing":
"t3sm 0.3.4 was rolled back; 0.3.1 is running (the automatic check skips 0.3.4)". That line stays until a release newer
than 0.3.4 is installed; it never needs you.

## E. Other PCs and systems

- **Another Windows PC.** Same steps. The schedule is a Task Scheduler task for your user with two triggers (logon,
  and every 15 minutes as a keep-alive); the window stays hidden. Notifications are Windows toasts.
- **macOS.** The schedule is a LaunchAgent (`~/Library/LaunchAgents`) with `KeepAlive`: launchd restarts the watcher,
  so there is no 15-minute trigger, and a watcher that restarts into a new install exits (code 75) for launchd to
  start the new one. Notifications go through `osascript`. Paths are `~/...`; the language follows `LANG` (for
  example `pt_PT.UTF-8`) or the system's.
- **Linux.** The schedule is two crontab lines tagged `# t3sm` (`@reboot` and `*/15`): `crontab -l | grep t3sm`.
  `schedule install --watch` also starts the watcher at once. Notifications use `notify-send` when it is installed.
- **Live tests (part C)** need Windows; on macOS and Linux they skip themselves.
- **No T3 Code on that PC?** `t3sm scan`, `status`, `help`, `runs`, `changelog`, `projects` (what this machine knows)
  and `update --check` work; `doctor` runs and reports the T3 Code checks as failures (exit 1); `plan`, `apply`,
  `sync`, `organize`, `merge` and `accounts` exit 3 until T3 Code runs.

## F. What good looks like, and what to send back

At the end of A or B:

- [ ] `t3sm --version` prints the release you installed.
- [ ] `t3sm status` prints "All good" (exit 0), or "Needs you" with a command for each item that you understand.
- [ ] `t3sm status --json` has `"watcher": { "running": true, "version": "<that release>", "stale": false }`.
- [ ] `t3sm doctor` has no `fail` (exit 0).
- [ ] T3 Code: every project shows its recent history; the home-folder conversations are in their project; no
  duplicates; the deleted conversation is back.
- [ ] `claude --resume` in a project folder lists and opens the copies.
- [ ] `logs/sync.log` gets a line per cycle without `error`.

If something is off, send:

```powershell
t3sm --version
t3sm status --json > t3sm-status.json
t3sm doctor --json > t3sm-doctor.json
Get-Content ~\.t3code-session-manager\logs\sync.log -Tail 30 > t3sm-sync-log.txt
t3sm update --check
```

plus the `{"case":...}` lines of part C, the command you ran and what it printed (a screenshot is fine). These hold
counts, versions, run ids, masked emails and project folders with your home shown as `~`; read them before sending.
**Never send conversation content**: not `plan.md` (it lists conversation titles), not `journal.jsonl`, not
transcripts. `t3sm help <topic>` explains most messages first: the screen names the topic.

## G. Working from T3 Code from now on

Once A or B is done, T3 Code is where you work; t3sm keeps it up to date in the background.

- **T3 Code must be running for imports and organize.** The watcher waits while T3 Code is closed (it tries again
  every minute) and catches up as soon as you open it. `t3sm status`, `t3sm scan` and `t3sm projects` work without
  it (`projects` says it shows what this machine knows), and `t3sm doctor` runs and reports the T3 Code checks as
  failures; `plan`, `apply`, `sync`, `organize`, `merge` and `accounts` (except `accounts --init`) exit 3 until T3 Code
  runs.
- **Sessions you start in a terminal or in VS Code inside a project folder reach T3 Code by themselves**: once a
  session has been idle for 10 minutes, the next cycle imports it into that project, on the account it was run with.
  A project with a session still in use waits for the next cycle, and more than 200 pending at once
  (`sync.maxUnattendedImports`) waits for one `t3sm apply`.
- **Work you continue in a terminal on a conversation that is already a thread in T3 Code** is not shown there by
  itself: run `t3sm merge` (it lists them; `t3sm merge --all` brings them in as new threads and archives the old
  ones). To let the watcher do it, set `sync.autoMerge` to `true` in `config.json`; it then merges each one once it
  has been idle for 10 minutes, at most 20 per cycle. Add this to the file (the other `sync` settings keep their
  defaults), and the next cycle reads it:

  ```json
  "sync": { "autoMerge": true }
  ```

  `config.json` is in t3sm's state folder: `%USERPROFILE%\.t3code-session-manager\config.json` on Windows,
  `~/.t3code-session-manager/config.json` on macOS and Linux (or under `T3SM_HOME` when you set it).
- **Conversations you start in your home folder** go where your saved answer to the home-folder question says: with
  yes, a copy goes into the project the conversation worked in most (or into "General"). The background sync writes
  a copy only into a project that already exists in T3 Code; one whose destination does not exist yet waits, and
  `t3sm status` or `t3sm sync` tells you to run `t3sm start` to create it.
- **Every project starts new threads on one Claude account**: the account its sessions belong to, or the one your
  rule names. `t3sm projects` shows it and why; `t3sm projects set "<folder>" <account>` changes it (it asks first,
  and also sets the project's default in T3 Code when the project is there). The background sync never overrides a
  default you chose in T3 Code; `t3sm apply` changes it only after showing it ("Project defaults to set" in `plan.md`
  and in `t3sm apply --dry-run`) and asking once for the whole plan, and `t3sm projects set` asks first.
- **What to check in `t3sm status`**: "All good" (exit 0) means nothing waits for you. "Needs you" (exit 10) lists
  each item with the command that fixes it: questions to answer (`t3sm start`), a watcher that is not running or
  late (`t3sm schedule restart`), a failed update. Below it: pending imports, the last and next sync, the watcher
  (running, with its pid and version), the t3sm plugin per account and T3 Code. Projects that wait because a
  conversation is in use, and a newer release, are listed under "Worth knowing". Sessions continued in a terminal are
  counted by `t3sm doctor` ("Continued sessions") and listed by `t3sm merge`.
