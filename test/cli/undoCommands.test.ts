// Every undo command t3sm prints is one the command line accepts: `t3sm rollback` takes the run only as `--run <id>`
// (a positional is refused), so an undo line written `t3sm rollback <id>` would fail when the user runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUES as ASSISTANT } from "../../src/assistant/i18n.ts";
import { CLI_CATALOGUES, makeCliUi } from "../../src/cli/ui.ts";
import { fmt } from "../../src/assistant/i18n.ts";
import { resultPanel } from "../../src/cli/applyScreen.ts";
import { parseFlags } from "../../src/cli/commands/quarantine.ts";
import { ROLLBACK_FLAGS, ROLLBACK_VALUED } from "../../src/cli/commands/rollback.ts";
import { parseOrganizeArgs } from "../../src/cli/commands/organize.ts";
import type { Io } from "../../src/cli/main.ts";
import { stripAnsi } from "../../src/ui/text.ts";

const VARS = { runId: "R1", folder: "~/code/app", account: "claudeAgent", home: "~/.claude", n: 2, id: "R1" };
const quietIo = (): { io: Io; err: () => string } => {
  let e = "";
  return { io: { stdout: () => {}, stderr: (s) => { e += s; }, isTTY: false, prompt: async () => "", env: {} }, err: () => e };
};

/** `t3sm rollback ...` / `t3sm organize ...` commands inside a text: the command and its flags (and a flag's value). */
function commandsIn(text: string): string[][] {
  const out: string[][] = [];
  const re = /t3sm (rollback|organize)\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const toks = text.slice(m.index + m[0].length).split(/\s+/).filter((x) => x !== "");
    const args: string[] = [];
    const END = /[.,;:)`"'\]]+$/; // the punctuation after a command in a sentence or in source code
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!.replace(END, "");
      if (!tok.startsWith("--")) break;
      args.push(tok);
      if ((tok === "--run" || tok === "--undo") && toks[i + 1] && !toks[i + 1]!.startsWith("--")) args.push(toks[++i]!.replace(END, "").replace(/^<id>$/, "R1"));
      if (END.test(toks[i]!)) break;
    }
    out.push([m[1]!, ...args]);
  }
  return out;
}

function parses(cmd: string[]): boolean {
  const { io } = quietIo();
  const [name, ...args] = cmd;
  return name === "rollback" ? parseFlags(args, io, "rollback", ROLLBACK_FLAGS, ROLLBACK_VALUED) !== null : parseOrganizeArgs(args, io) !== null;
}

test("every undo command t3sm prints parses (assistant, CLI catalogues, the apply result, the assistant's own literals)", () => {
  const texts: string[] = [];
  for (const cat of [...Object.values(ASSISTANT), ...Object.values(CLI_CATALOGUES)]) for (const v of Object.values(cat)) texts.push(fmt(v, VARS));
  for (const lang of ["en", "pt"] as const) {
    const ui = makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 200 }, lang);
    const panel = stripAnsi(resultPanel(ui, { status: "ok", imported: 3, failed: 0, converted: 0, unverified: 0, alreadyInT3: 0, deferred: 0, held: 0, runId: "R1" }, 200).join("\n"));
    // The result's undo line, whole: everything after `t3sm rollback` up to the panel's border must parse.
    const line = panel.split("\n").find((l) => l.includes("t3sm rollback"))!;
    const args = line.slice(line.indexOf("t3sm rollback") + "t3sm rollback".length).replace(/[│|]\s*$/, "").trim().split(/\s+/);
    assert.ok(parses(["rollback", ...args]), `${lang}: ${line.trim()}`);
    assert.deepEqual(args, ["--run", "R1", "--archive-threads"], `${lang}: the same undo as the assistant's (threads archived)`);
    texts.push(panel);
  }
  texts.push(readFileSync(join(import.meta.dirname, "..", "..", "src", "assistant", "steps.ts"), "utf8"));
  const cmds = texts.flatMap(commandsIn).filter((c) => c.length > 1 && !c.includes("--help")); // --help is main's, never the parser's
  assert.ok(cmds.length >= 10, `found ${cmds.length} undo commands`);
  for (const c of cmds) assert.ok(parses(c), `t3sm ${c.join(" ")} does not parse`);
  // The apply result's undo line names the run with --run (a bare run id is refused).
  assert.ok(cmds.some((c) => c[0] === "rollback" && c.join(" ") === "rollback --run R1 --archive-threads"));
  assert.equal(parseFlags(["R1"], quietIo().io, "rollback", ROLLBACK_FLAGS, ROLLBACK_VALUED), null, "a positional run id is refused");
});
