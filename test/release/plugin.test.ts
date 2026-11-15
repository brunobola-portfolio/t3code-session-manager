// The /t3sm:* command files shipped in the plugin: front-matter and the ask-before-writing rule, checked as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFileProblems, COMMAND_FILES } from "../../scripts/release.js";

const ROOT = join(import.meta.dirname, "..", "..");
const NAMES = ["status", "sync", "organize", "import"];

test("the four command files exist at the plugin root and pass the release check", () => {
  assert.deepEqual(COMMAND_FILES, NAMES.map((n) => `commands/${n}.md`));
  for (const f of COMMAND_FILES) assert.ok(existsSync(join(ROOT, f)), f);
  assert.deepEqual(commandFileProblems(ROOT), []);
});

for (const n of NAMES) {
  test(`commands/${n}.md: description, read-only first, writes only after a yes, CLAUDE_CONFIG_DIR removed`, () => {
    const text = readFileSync(join(ROOT, "commands", `${n}.md`), "utf8").replace(/\r\n/g, "\n");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, "front-matter");
    assert.match(fm[1]!, /^description:\s*\S.{10,}$/m);
    const body = text.slice(fm[0].length);
    assert.match(body, /dry-run|read-only/i);
    assert.match(body, /only after the user says yes/i);
    assert.match(body, /env -u CLAUDE_CONFIG_DIR t3sm/);
    assert.match(body, /Remove-Item Env:CLAUDE_CONFIG_DIR/);
    // The in-use hold is import's and sync's (spec 4.6); organize has none.
    if (n === "sync" || n === "import") assert.match(body, /General/);
    if (n === "sync" || n === "import") assert.match(body, /in use/i);
  });
}

test("organize.md: the writing form is the previewed command with --dry-run replaced by --yes; no writing flags from $ARGUMENTS", () => {
  const body = readFileSync(join(ROOT, "commands", "organize.md"), "utf8").replace(/\s+/g, " ");
  assert.match(body, /exactly the dry-run command you ran, with `--dry-run` replaced by `--yes`/);
  assert.match(body, /keep `--only`/);
  assert.match(body, /yes to THAT command/);
  assert.match(body, /Never add `--yes`, `--undo` or any other writing flag from `\$ARGUMENTS` to the preview/);
});

/** A file's text with every run of white space as one space (sentences wrap across lines). */
const flat = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8").replace(/\s+/g, " ");

test("organize.md: organize holds nothing back; it may retitle or show the conversation running it", () => {
  const body = flat("commands", "organize.md");
  assert.ok(!body.includes("leaves its own project for the next cycle"));
  assert.ok(body.includes('Organize has no "in use" hold (that applies to import and sync): it may give this conversation a new title or show it inside its project, like any other imported conversation.'), body);
});

test("organize.md: the undo step shows the full command and runs it only after a yes to that exact command", () => {
  const body = flat("commands", "organize.md");
  assert.ok(body.includes("env -u CLAUDE_CONFIG_DIR t3sm organize --undo --dry-run"), body);
  assert.ok(body.includes("Show the full command (`env -u CLAUDE_CONFIG_DIR t3sm organize --undo <run id> --yes`, with the run id from that dry run or from `t3sm runs`) and run it only after the user says yes to that exact command, in this conversation."), body);
});

test("SKILL.md: the in-use hold is described for import and sync only; organize may touch the running conversation", () => {
  const body = flat("skills", "t3code-sessions", "SKILL.md");
  assert.ok(!body.includes('The conversation running these commands is "in use"'));
  assert.ok(body.includes("`/t3sm:organize` has no such hold: it may give the running conversation a new title or show it inside its project."), body);
});

// The design specs live in docs/superpowers, which is kept out of the public repository: skip there.
const SPECS = join(ROOT, "docs", "superpowers", "specs");
test("the design spec (EN and PT) gives the in-use hold to /t3sm:sync and /t3sm:import only (R25)", { skip: !existsSync(SPECS) && "the design specs are not in this checkout" }, () => {
  const en = flat("docs", "superpowers", "specs", "2026-11-14-t3sm-organize-design.md");
  const pt = flat("docs", "superpowers", "specs", "2026-11-14-t3sm-organize-design.pt.md");
  assert.ok(!en.includes("the T3 conversation running t3sm is active"));
  assert.ok(en.includes("the T3 conversation running `/t3sm:sync` or `/t3sm:import` is active") && en.includes("`/t3sm:organize` has no such hold"));
  assert.ok(!pt.includes("a conversa do T3 que corre o t3sm está ativa"));
  assert.ok(pt.includes("a conversa do T3 que corre o `/t3sm:sync` ou o `/t3sm:import` está ativa") && pt.includes("o `/t3sm:organize` não tem essa retenção"));
});

test("every command carries the pinned-release fallback and never claims a plan or dry run 'writes nothing'", () => {
  for (const n of NAMES) {
    const text = readFileSync(join(ROOT, "commands", `${n}.md`), "utf8").replace(/\s+/g, " ");
    assert.match(text, /If `t3sm` is not installed, use the pinned release described in the `t3code-sessions` skill instead\./, n);
    assert.doesNotMatch(text, /writes nothing/, n);
  }
});

test("the read-only form each command runs first", () => {
  const first: Record<string, RegExp> = { status: /t3sm status/, sync: /t3sm sync --dry-run/, organize: /t3sm organize --dry-run/, import: /t3sm plan/ };
  for (const n of NAMES) assert.match(readFileSync(join(ROOT, "commands", `${n}.md`), "utf8"), first[n]!);
});

test("commandFileProblems reports a missing file, a missing description and a missing yes rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-rel-"));
  try {
    mkdirSync(join(dir, "commands"));
    writeFileSync(join(dir, "commands", "status.md"), "---\nargument-hint: x\n---\nRun t3sm status.\n");
    const p = commandFileProblems(dir);
    assert.ok(p.some((x) => /commands\/sync\.md.*missing/.test(x)), p.join("\n"));
    assert.ok(p.some((x) => /commands\/status\.md.*description/.test(x)));
    assert.ok(p.some((x) => /commands\/status\.md.*only after the user says yes/.test(x)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("package.json ships commands/", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("commands/"));
});
