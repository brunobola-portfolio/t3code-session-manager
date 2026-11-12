import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    env: {},
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

test("no arguments prints usage and exits 0", async () => {
  const f = fakeIo();
  assert.equal(await main([], f.io), 0);
  assert.match(f.out(), /Usage: t3sm/);
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
  assert.match(f.err(), /Unknown option: --bogus\. Run `t3sm --help`\./);
});

test("unknown command message points at --help", async () => {
  const f = fakeIo();
  assert.equal(await main(["nope"], f.io), 2);
  assert.match(f.err(), /Run `t3sm --help`\./);
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
