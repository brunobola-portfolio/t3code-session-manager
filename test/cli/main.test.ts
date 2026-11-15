import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    isTTY: false,
    prompt: async () => "",
    // English pinned: the OS locale must not leak in; a scratch state folder (main reads config.json "language").
    env: { LANG: "en_US.UTF-8", T3SM_HOME: mkdtempSync(join(tmpdir(), "t3sm-main-")) },
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("--version prints the package version", async () => {
  const f = fakeIo();
  assert.equal(await main(["--version"], f.io), 0);
  assert.equal(f.out(), `${pkg.version}\n`);
});

test("-v is an alias of --version", async () => {
  const f = fakeIo();
  assert.equal(await main(["-v"], f.io), 0);
  assert.equal(f.out(), `${pkg.version}\n`);
});

test("--help prints usage and exits 0", async () => {
  const f = fakeIo();
  assert.equal(await main(["--help"], f.io), 0);
  assert.match(f.out(), /Usage: t3sm/);
});

test("status --help: the JSON keys line up in one column", async () => {
  const f = fakeIo();
  assert.equal(await main(["status", "--help"], f.io), 0);
  const cols = f.out().split("\n").filter((l) => /^ {13}(version|ran|needsAttention|waiting|heldRehome|decisionsPending|pendingImports|lastSync|nextSync|watcher|lastOrganize|plugin|t3Code) /.test(l)).map((l) => /^ {13}\S+ +/.exec(l)![0].length);
  assert.equal(cols.length, 13);
  assert.equal(new Set(cols).size, 1, `misaligned columns: ${cols}`);
});

test("no arguments prints usage and exits 0", async () => {
  const f = fakeIo();
  assert.equal(await main([], f.io), 0);
  assert.match(f.out(), /Usage: t3sm/);
  // The command descriptions line up in one column.
  const cols = f.out().split("\n").filter((l) => /^  t3sm (status|sync|schedule|merge) /.test(l)).map((l) => /^  t3sm \S+ +/.exec(l)![0].length);
  assert.equal(cols.length, 4);
  assert.equal(new Set(cols).size, 1, `misaligned columns: ${cols}`);
});

test("unknown command exits 2", async () => {
  const f = fakeIo();
  assert.equal(await main(["nope"], f.io), 2);
  assert.match(f.err(), /Unknown command: nope/);
  assert.equal(f.out(), "");
});

test("unknown top-level flag exits 2 with a hint", async () => {
  const f = fakeIo();
  assert.equal(await main(["--bogus"], f.io), 2);
  assert.match(f.err(), /Unknown option: --bogus\. Run t3sm --help\./);
});

test("usage errors, refusals and the missing plan speak the user's language (--lang pt), without Markdown backticks", async () => {
  const f = fakeIo();
  assert.equal(await main(["--lang", "pt", "--bogus"], f.io), 2);
  assert.equal(f.err(), "Opção desconhecida: --bogus. Corre t3sm --help.\n");
  const g = fakeIo();
  assert.equal(await main(["nope", "--lang", "pt"], g.io), 2);
  assert.equal(g.err(), "Comando desconhecido: nope. Corre t3sm --help.\n");
  const h = fakeIo();
  assert.equal(await main(["apply", "--bogus", "--lang", "pt"], h.io), 2);
  assert.equal(h.err(), "Opção desconhecida: --bogus. Corre t3sm apply --help.\n");
  const k = fakeIo();
  assert.equal(await main(["apply", "--lang", "pt"], k.io), 2);
  assert.equal(k.err(), "Recuso mudar o T3 Code sem confirmação: passa --yes (sem terminal).\n");
  const d = fakeIo();
  assert.equal(await main(["organize", "--dry-run", "--yes", "--lang", "pt"], d.io), 2);
  assert.equal(d.err(), "Usa --dry-run ou --yes, não os dois.\n");
  const { renderError } = await import("../../src/cli/errors.ts");
  const { NoPlanError } = await import("../../src/core/config.ts");
  const { makeCliUi } = await import("../../src/i18n/cli.ts");
  const panel = renderError(new NoPlanError(), makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 80 }, "pt"), "win32").join("\n");
  assert.match(panel, /Ainda não há plano/);
  assert.match(panel, /Corre primeiro t3sm plan/);
  assert.doesNotMatch(panel, /No plan found|`/);
});

test("unknown command message points at --help", async () => {
  const f = fakeIo();
  assert.equal(await main(["nope"], f.io), 2);
  assert.match(f.err(), /Run t3sm --help\./);
});

test("B9: T3 unreachable mid-run exits 3 for both transports; an unexpected error is redacted (home as ~, no token)", async () => {
  const { describeError } = await import("../../src/cli/errors.ts");
  const { RpcClosed, RpcTimeout, T3HttpError } = await import("../../src/t3/errors.ts");
  const { homedir } = await import("node:os");
  assert.equal(describeError(new T3HttpError("GET /api/orchestration/shell", null, { message: "could not reach T3Code (refused, reset or redirected)" })).code, 3);
  assert.equal(describeError(new RpcClosed()).code, 3);
  assert.equal(describeError(new RpcTimeout("agentSessions.scan", 120_000)).code, 3);
  assert.equal(describeError(new T3HttpError("GET /api/projects", 500)).code, 1, "an answer with an error is not 'unreachable'");
  const secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8";
  const d = describeError(new Error(`EACCES: permission denied, open '${homedir()}\\x\\y.json' Bearer ${secret}`));
  assert.equal(d.code, 1);
  assert.ok(!d.message.includes(homedir()), d.message);
  assert.ok(!d.message.includes(secret), d.message);
  assert.match(d.message, /^Unexpected error: EACCES/);
});

test("the global options (--lang, --no-color) are documented once and shown by the usage and every command's help", async () => {
  const u = fakeIo();
  await main(["--help"], u.io);
  assert.match(u.out(), /Global options \(every command\):\n  --lang en\|pt +.*\n(?: +.*\n)*  --no-color +/);
  for (const c of ["status", "plan", "apply", "start", "organize", "sync"]) {
    const h = fakeIo();
    assert.equal(await main([c, "--help"], h.io), 0);
    assert.equal(h.out().split("Global options (every command):").length, 2, `${c}: the section once`);
  }
});
