import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerRuntime, probeServer, isT3Running, resolveT3Cli, parseLocalOrigin } from "../../src/t3/runtime.ts";

const RUNTIME = {
  version: 1, pid: 129232, host: "0.0.0.0", port: 3773, origin: "http://127.0.0.1:3773",
  startedAt: "2026-11-10T15:46:19.666Z", serverVersion: "0.1.9-nightly.20261110.4465", managedPolicy: null, ownerId: "x",
};

async function homeWith(content?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "t3sm-rt-"));
  if (content !== undefined) {
    await mkdir(join(home, ".t3", "userdata"), { recursive: true });
    await writeFile(join(home, ".t3", "userdata", "server-runtime.json"), content);
  }
  return home;
}

test("readServerRuntime parses the S1 shape", async () => {
  const home = await homeWith(JSON.stringify(RUNTIME));
  try {
    assert.deepEqual(await readServerRuntime(home), { origin: "http://127.0.0.1:3773", port: 3773, serverVersion: "0.1.9-nightly.20261110.4465", pid: 129232 });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("readServerRuntime returns null when missing, unparseable or malformed", async () => {
  for (const c of [undefined, "{nope", JSON.stringify({ ...RUNTIME, origin: 5 }), "[]"]) {
    const home = await homeWith(c);
    try { assert.equal(await readServerRuntime(home), null); } finally { await rm(home, { recursive: true, force: true }); }
  }
});

const rt = { origin: "http://127.0.0.1:3773", port: 3773, serverVersion: "v", pid: 1 };

test("probeServer: ok, non-ok and network failure; uses the environment URL and a timeout signal", async () => {
  let seen: { url: string; signal: unknown } | null = null;
  let seenRedirect: unknown;
  const ok = (async (u: unknown, i?: { signal?: AbortSignal; redirect?: string }) => { seenRedirect = i?.redirect; seen = { url: String(u), signal: i?.signal }; return new Response("{}", { status: 200 }); }) as typeof fetch;
  assert.equal(await probeServer(rt, ok), true);
  assert.equal(seen!.url, "http://127.0.0.1:3773/.well-known/t3/environment");
  assert.ok(seen!.signal instanceof AbortSignal);
  assert.equal(seenRedirect, "error");
  assert.equal(await probeServer(rt, (async () => new Response("", { status: 500 })) as typeof fetch), false);
  assert.equal(await probeServer(rt, (async () => { throw new TypeError("ECONNREFUSED"); }) as typeof fetch), false);
});

test("isT3Running needs both the runtime file and a successful probe", async () => {
  const up = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const withFile = await homeWith(JSON.stringify(RUNTIME));
  const without = await homeWith();
  try {
    assert.equal(await isT3Running(withFile, up), true);
    assert.equal(await isT3Running(withFile, (async () => { throw new Error("x"); }) as typeof fetch), false);
    assert.equal(await isT3Running(without, up), false);
  } finally { await rm(withFile, { recursive: true, force: true }); await rm(without, { recursive: true, force: true }); }
});

test("resolveT3Cli prefers ~/.t3/bin, then PATH (PATHEXT on win32)", async () => {
  const home = await mkdtemp(join(tmpdir(), "t3sm-cli-"));
  const pathDir = await mkdtemp(join(tmpdir(), "t3sm-path-"));
  try {
    assert.equal(resolveT3Cli(home, "win32", pathDir), null);
    await writeFile(join(pathDir, "t3.cmd"), "");
    assert.equal(resolveT3Cli(home, "win32", pathDir), join(pathDir, "t3.cmd"));
    await mkdir(join(home, ".t3", "bin"), { recursive: true });
    await writeFile(join(home, ".t3", "bin", "t3.cmd"), "");
    assert.equal(resolveT3Cli(home, "win32", pathDir), join(home, ".t3", "bin", "t3.cmd"));
    // non-win32 uses the bare name and ':' (a Windows temp path contains ':' itself, so only check on posix hosts)
    if (process.platform !== "win32") {
      assert.equal(resolveT3Cli(home, "linux", pathDir), null);
      await writeFile(join(pathDir, "t3"), "");
      assert.equal(resolveT3Cli(home, "linux", pathDir), join(pathDir, "t3"));
    }
  } finally { await rm(home, { recursive: true, force: true }); await rm(pathDir, { recursive: true, force: true }); }
});

test("readServerRuntime rejects non-local, credentialed, non-http or port-mismatched origins (token exfiltration guard)", async () => {
  const bad = [
    "http://evil.example.com:3773", "http://127.0.0.1.evil.com:3773", "http://user:pw@127.0.0.1:3773", "http://127.0.0.1:9999",
    "ftp://127.0.0.1:3773", "file:///C:/x", "not a url", "http://192.168.0.10:3773",
  ];
  for (const origin of bad) {
    const home = await homeWith(JSON.stringify({ ...RUNTIME, origin }));
    try { assert.equal(await readServerRuntime(home), null, origin); } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("readServerRuntime accepts loopback hosts and default-port rules", async () => {
  const good: [string, number][] = [["http://localhost:3773", 3773], ["http://[::1]:3773", 3773], ["http://127.0.0.1", 80], ["https://localhost", 443]];
  for (const [origin, port] of good) {
    const home = await homeWith(JSON.stringify({ ...RUNTIME, origin, port }));
    try { assert.ok(await readServerRuntime(home), origin); } finally { await rm(home, { recursive: true, force: true }); }
  }
  assert.equal(parseLocalOrigin(5), null);
});

test("probeServer refuses a non-local origin without calling fetch", async () => {
  let called = false;
  const f = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  assert.equal(await probeServer({ ...rt, origin: "http://evil.example.com:3773" }, f), false);
  assert.equal(called, false);
});

test("resolveT3Cli honours an injected PATHEXT", async () => {
  const pathDir = await mkdtemp(join(tmpdir(), "t3sm-pe-"));
  try {
    await writeFile(join(pathDir, "t3.bat"), "");
    assert.equal(resolveT3Cli("/nonexistent-home", "win32", pathDir, ".CMD"), null);
    assert.equal(resolveT3Cli("/nonexistent-home", "win32", pathDir, ".CMD;.BAT"), join(pathDir, "t3.bat"));
  } finally { await rm(pathDir, { recursive: true, force: true }); }
});
