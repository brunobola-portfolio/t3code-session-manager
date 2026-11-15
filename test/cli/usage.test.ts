// `t3sm --help` and `t3sm <command> --help`: one renderer for every command's help (usage, options, examples), in
// English and European Portuguese, fitted to the window; every option a help text shows is one its parser accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, main, type Io } from "../../src/cli/main.ts";
import { COMMAND_FLAGS, FLAG_SPECS, GLOBAL_FLAGS, PROJECTS_FLAGS } from "../../src/cli/flags.ts";
import { HELP_TEXTS, helpFlags, renderHelpText } from "../../src/cli/helpText.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { displayWidth } from "../../src/ui/text.ts";

function fakeIo(env: NodeJS.ProcessEnv = {}): { io: Io; out: () => string } {
  const out: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s), stderr: () => undefined, isTTY: false, prompt: async () => "",
    env: { LANG: "en_US.UTF-8", T3SM_HOME: mkdtempSync(join(tmpdir(), "t3sm-usage-")), ...env },
  };
  return { io, out: () => out.join("") };
}

test("every command has its help in English and Portuguese, and the usage names every command", () => {
  const names = Object.keys(commands).sort();
  assert.deepEqual(Object.keys(HELP_TEXTS.en.commands).sort(), names);
  assert.deepEqual(Object.keys(HELP_TEXTS.pt.commands).sort(), names);
  for (const n of names) {
    if (n === "help") continue;
    assert.match(HELP_TEXTS.en.usage, new RegExp(`^  t3sm ${n} `, "m"), `usage names ${n}`);
    assert.match(HELP_TEXTS.pt.usage, new RegExp(`^  t3sm ${n} `, "m"), `uso names ${n}`);
  }
});

test("every option a command's help shows (en and pt) is one its parser accepts, and every accepted option is documented", () => {
  for (const [name, accepted] of Object.entries(COMMAND_FLAGS)) {
    for (const lang of ["en", "pt"] as const) {
      const shown = helpFlags(HELP_TEXTS[lang].commands[name]!);
      for (const f of shown) assert.ok([...accepted, ...GLOBAL_FLAGS].includes(f), `${lang} ${name} --help shows ${f}, which ${name} does not accept`);
      for (const f of accepted) assert.ok(shown.includes(f), `${lang} ${name} --help does not document ${f}`);
    }
  }
  for (const lang of ["en", "pt"] as const) {
    for (const f of helpFlags(HELP_TEXTS[lang].usage)) assert.ok(Object.values(COMMAND_FLAGS).some((a) => a.includes(f)) || GLOBAL_FLAGS.includes(f), `${lang} usage shows ${f}`);
  }
});

test("projects: the options of each subcommand together are exactly the command's options", () => {
  assert.deepEqual([...new Set(Object.values(PROJECTS_FLAGS).flat())].sort(), [...FLAG_SPECS.projects.bool].sort());
});

test("every command refuses an option it does not list (the parsers read src/cli/flags.ts)", async () => {
  for (const cmd of ["sync", "apply", "plan", "status", "organize", "projects", "scan", "runs", "doctor", "changelog", "merge", "rollback", "quarantine", "update"]) {
    const errs: string[] = [];
    const io: Io = { stdout: () => undefined, stderr: (s) => void errs.push(s), isTTY: false, prompt: async () => "", env: { LANG: "en_US.UTF-8", T3SM_HOME: mkdtempSync(join(tmpdir(), "t3sm-flags-")) } };
    assert.equal(await main([cmd, "--not-an-option"], io), 2, cmd);
    assert.match(errs.join(""), /Unknown option: --not-an-option/, cmd);
  }
});

test("help texts fit every width (40/80/120), with ASCII symbols only when Unicode is off, in both languages", () => {
  for (const lang of ["en", "pt"] as const) {
    const texts = [HELP_TEXTS[lang].usage, ...Object.values(HELP_TEXTS[lang].commands)];
    for (const columns of [40, 80, 120]) for (const unicode of [true, false]) {
      const ui = makeCliUi({ color: 0, unicode, isTTY: false, columns }, lang);
      for (const t of texts) {
        for (const l of renderHelpText(ui, t + HELP_TEXTS[lang].global)) {
          assert.ok(displayWidth(l) <= columns, `${lang} ${columns}: ${l}`);
          if (!unicode) assert.match(l, /^[\x20-\x7eÀ-ÿ]*$/, l);
        }
      }
      const colour = makeCliUi({ color: 1, unicode, isTTY: true, columns }, lang);
      assert.match(renderHelpText(colour, HELP_TEXTS[lang].commands["apply"]!).join("\n"), /\u001b\[/, "styled with colour");
    }
  }
});

test("t3sm --help and <command> --help in Portuguese with --lang pt or a Portuguese system", async () => {
  const pt = fakeIo({ LANG: "pt_PT.UTF-8" });
  assert.equal(await main(["--help"], pt.io), 0);
  assert.match(pt.out(), /Uso: t3sm/);
  assert.match(pt.out(), /Opções globais \(todos os comandos\):/);
  const flag = fakeIo();
  assert.equal(await main(["apply", "--help", "--lang", "pt"], flag.io), 0);
  assert.match(flag.out(), /Uso: t3sm apply/);
  assert.match(flag.out(), /Opções:/);
  const en = fakeIo();
  assert.equal(await main(["apply", "--help"], en.io), 0);
  assert.match(en.out(), /Usage: t3sm apply/);
  assert.match(en.out(), /Options:/);
});
