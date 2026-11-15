// `t3sm help [<topic>]`: the help topics shipped in docs/help (English and European Portuguese), how a topic is drawn
// (wrapped, Markdown markup turned into styles), the topic list, and that every command a topic shows exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TOPICS, helpTopicFor } from "../../src/cli/helpTopics.ts";
import { helpCommand, renderMarkdown, topicSummary } from "../../src/cli/commands/help.ts";
import { COMMAND_FLAGS, GLOBAL_FLAGS } from "../../src/cli/flags.ts";
import { main, type Io } from "../../src/cli/main.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { displayWidth } from "../../src/ui/text.ts";

const HELP = join(import.meta.dirname, "..", "..", "docs", "help");

function fakeIo(env: NodeJS.ProcessEnv = {}): { io: Io; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const state = mkdtempSync(join(tmpdir(), "t3sm-help-"));
  const io: Io = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "",
    env: { LANG: "en_US.UTF-8", T3SM_HOME: state, ...env },
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("every topic a screen can name (helpTopicFor, HELP_TOPICS) is shipped in English and Portuguese; no topic file is orphaned", () => {
  const files = new Set(readdirSync(HELP));
  const reasons = ["not-imported", "cwd-unreadable-in-t3", "instance-unavailable", "project-mismatch", "convert: no-reader", "read-failed: x",
    "write-failed: x", "target-exists", "target-outside-accounts", "target-folder: x", "orphaned-in-t3", "t3-native-unknown", "undecided",
    "project-in-use", "held", "watcher", "update-failed", "history: last 90 days", "anything else"];
  const named = new Set<string>([...HELP_TOPICS, ...reasons.map(helpTopicFor)]);
  for (const t of named) {
    for (const f of [`${t}.md`, `${t}.pt.md`]) {
      assert.ok(files.has(f), `docs/help/${f} is missing`);
      const md = readFileSync(join(HELP, f), "utf8");
      assert.match(md, /^# \S/, `${f}: starts with its title`);
      assert.ok(topicSummary(md).length > 0 && topicSummary(md).length <= 70, `${f}: a one-line summary (${topicSummary(md)})`);
    }
  }
  for (const f of files) {
    const topic = f.replace(/(\.pt)?\.md$/, "");
    assert.ok((HELP_TOPICS as readonly string[]).includes(topic), `docs/help/${f} is not a topic in HELP_TOPICS`);
  }
});

test("every t3sm command a help topic shows exists, with options its parser accepts", () => {
  for (const f of readdirSync(HELP)) {
    const md = readFileSync(join(HELP, f), "utf8");
    const code = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!).filter((c) => /^t3sm( |$)/.test(c));
    for (const c of code) {
      const words = c.split(/\s+/).slice(1);
      const cmd = words[0];
      if (cmd === undefined || cmd.startsWith("-")) continue;
      assert.ok(Object.hasOwn(COMMAND_FLAGS, cmd), `${f}: \`${c}\` names no t3sm command`);
      for (const w of words.slice(1).filter((x) => x.startsWith("--"))) {
        const flag = w.replace(/=.*$/, "");
        assert.ok([...COMMAND_FLAGS[cmd]!, ...GLOBAL_FLAGS].includes(flag), `${f}: \`${c}\`: ${cmd} has no ${flag}`);
      }
    }
  }
});

test("t3sm help: lists every topic with its one-line summary (English, then Portuguese)", async () => {
  const en = fakeIo();
  assert.equal(await main(["help"], en.io), 0);
  for (const t of HELP_TOPICS) assert.match(en.out(), new RegExp(`^  ${t} +\\S`, "m"), t);
  assert.match(en.out(), new RegExp(topicSummary(readFileSync(join(HELP, "not-imported.md"), "utf8")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(en.out(), /t3sm help <topic>/);
  const pt = fakeIo({ LANG: "pt_PT.UTF-8" });
  assert.equal(await main(["help"], pt.io), 0);
  assert.match(pt.out(), new RegExp(topicSummary(readFileSync(join(HELP, "not-imported.pt.md"), "utf8")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(pt.out(), /t3sm help <tópico>/);
});

test("t3sm help <topic>: wrapped plain text, no Markdown markup left, in the user's language", async () => {
  const f = fakeIo();
  assert.equal(await main(["help", "not-imported"], f.io), 0);
  const text = f.out();
  assert.doesNotMatch(text, /^#|`|\*\*|\]\(/m, "no Markdown markup");
  assert.match(text, /t3sm apply/);
  for (const l of text.split("\n")) assert.ok(displayWidth(l) <= 80, l);
  const pt = fakeIo();
  assert.equal(await main(["help", "not-imported", "--lang", "pt"], pt.io), 0);
  assert.notEqual(pt.out(), text);
  assert.match(pt.out(), new RegExp(topicSummary(readFileSync(join(HELP, "not-imported.pt.md"), "utf8")).split(" ")[0]!));
});

test("t3sm help <unknown>: exit 2 with the list of topics; help <command> shows that command's help", async () => {
  const f = fakeIo();
  assert.equal(await main(["help", "nope"], f.io), 2);
  assert.match(f.err(), /nope/);
  for (const t of HELP_TOPICS) assert.match(f.err(), new RegExp(`\\b${t}\\b`));
  const c = fakeIo();
  assert.equal(await main(["help", "apply"], c.io), 0);
  assert.match(c.out(), /t3sm apply/);
  assert.match(c.out(), /--dry-run/);
  const two = fakeIo();
  assert.equal(await main(["help", "held", "extra"], two.io), 2);
});

test("help: a Portuguese topic falls back to English when its translation is missing; the folder is injected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-help-dir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "held.md"), "# Held: a project waits\n\nBecause `t3sm sync` saw it in use.\n");
  const f = fakeIo();
  assert.equal(await helpCommand(["held"], { ...f.io, lang: "pt" }, { dir }), 0);
  assert.match(f.out(), /Held: a project waits/);
  assert.match(f.out(), /Because t3sm sync saw it in use\./);
});

test("renderMarkdown: headings as titles, lists as bullets, code as commands, wrapped to the width (ASCII without Unicode)", () => {
  const md = "# Title here\n\nA paragraph with `t3sm doctor` inside and **bold** words that goes on and on until it has to wrap.\n\n## What to do\n\n- First step with `t3sm apply --dry-run`\n- Second step\n\n```\nt3sm runs\n```\n\nSee [the docs](https://example.com) for more.\n";
  for (const unicode of [true, false]) {
    const ui = makeCliUi({ color: 0, unicode, isTTY: false, columns: 40 }, "en");
    const lines = renderMarkdown(ui, md, 40);
    for (const l of lines) assert.ok(displayWidth(l) <= 40, l);
    const text = lines.join("\n");
    assert.doesNotMatch(text, /[#`*]|\]\(/);
    assert.match(text, /^Title here$/m);
    assert.match(text, unicode ? /^ *• First step with/m : /^ *- First step with/m);
    assert.match(text, /^ +t3sm runs$/m);
    assert.match(text, /See the docs for more\./);
    if (!unicode) assert.match(text, /^[\x20-\x7e\n]*$/);
  }
  const colour = makeCliUi({ color: 1, unicode: true, isTTY: true, columns: 80 }, "en");
  assert.match(renderMarkdown(colour, md, 80).join("\n"), /\u001b\[1mTitle here/);
});
