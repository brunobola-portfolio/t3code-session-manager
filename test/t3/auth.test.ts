import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultRunner, issueSessionToken, mintWsTicket, revokeSession, trackChild, type Runner, type RunOptions } from "../../src/t3/auth.ts";
import { T3AuthError, RpcError, redact, registerSecret } from "../../src/t3/errors.ts";

const fx = async (n: string) => JSON.parse(await readFile(new URL(`../fixtures/t3-wire/${n}`, import.meta.url), "utf8"));
const ORIGIN = "http://127.0.0.1:3773";
const SID = "f60c941a-7dcf-42a2-8d91-788a4eaab71f";
const issueOut = (token: string, sessionId = SID) => JSON.stringify({ sessionId, token, method: "bearer-access-token", scopes: [], subject: "cli-issued-session", client: {}, expiresAt: "x" }) + "\n";

function runner(res: { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean }) {
  const calls: { file: string; args: string[]; opts: RunOptions }[] = [];
  const run: Runner = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: "", stderr: "", timedOut: false, ...res }; };
  return { run, calls };
}

test("issueSessionToken returns {token, sessionId} from --json, least-privilege scopes by default", async () => {
  process.env.CLAUDE_CONFIG_DIR = "C:\\x\\.claude-org";
  const { run, calls } = runner({ code: 0, stdout: issueOut("opaque-token-value-1234567890") });
  let got;
  try { got = await issueSessionToken("C:\\Users\\u\\.t3\\bin\\t3.cmd", { run }); } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  assert.deepEqual(got, { token: "opaque-token-value-1234567890", sessionId: SID });
  const c = calls[0]!;
  assert.deepEqual(c.args.slice(0, 4), ["auth", "session", "issue", "--json"]);
  const scopes = c.args.flatMap((a, i) => (c.args[i - 1] === "--scope" ? [a] : []));
  assert.deepEqual(scopes.sort(), ["orchestration:operate", "orchestration:read"]);
  assert.equal(c.opts.shell, process.platform === "win32", ".cmd needs a shell on Windows only");
  assert.equal(c.opts.timeoutMs, 30_000);
  assert.ok(!Object.keys(c.opts.env).some((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR"), "env must not inherit CLAUDE_CONFIG_DIR");
});

test("callers can add providers:manage; invalid scopes are refused", async () => {
  const { run, calls } = runner({ code: 0, stdout: issueOut("opaque-token-value-1234567890") });
  await issueSessionToken("/h/t3", { run, scopes: ["orchestration:read", "providers:manage"] });
  assert.equal(calls[0]!.opts.shell, false);
  assert.ok(calls[0]!.args.includes("providers:manage"));
  await assert.rejects(issueSessionToken("/h/t3", { run, scopes: ["x & calc"] }), T3AuthError);
  await assert.rejects(issueSessionToken("/h/t3", { run, scopes: ["-x:y"] }), T3AuthError);
});

test("issueSessionToken throws T3AuthError on non-zero, timeout, bad JSON, missing token or session id", async () => {
  const cases = [
    { code: 1, stderr: "boom" }, { code: null, timedOut: true }, { code: 0, stdout: "  \n" }, { code: 0, stdout: "tok\n" },
    { code: 0, stdout: JSON.stringify({ token: "has space", sessionId: SID }) },
    { code: 0, stdout: JSON.stringify({ token: "opaque-token-value-1234567890" }) },
    { code: 0, stdout: JSON.stringify({ token: "opaque-token-value-1234567890", sessionId: "a b; calc" }) },
  ];
  for (const r of cases) await assert.rejects(issueSessionToken("t3", { run: runner(r).run }), T3AuthError);
});

/** Everything an error could expose: own enumerable fields, message and stack. */
const everything = (e: unknown) => (e instanceof Error ? `${JSON.stringify(e)} ${e.message} ${e.stack ?? ""}` : JSON.stringify(e));
const FIXED_HINT = "Run `t3 auth session issue --token-only` yourself to see T3's message.";

test("auth CLI failures are fixed text + exit code + fixed hint; no child output anywhere, no detail field", async () => {
  const tok = "plainopaque.token_value~ABC123";
  const out = JSON.stringify({ token: tok, sessionId: "short" });
  await assert.rejects(issueSessionToken("t3", { run: runner({ code: 1, stdout: out, stderr: `denied ${tok} please read me` }).run }), (e: unknown) => {
    assert.ok(e instanceof T3AuthError);
    const all = everything(e);
    for (const s of [tok, "denied", "please read me", "plainopaque"]) assert.ok(!all.includes(s), s);
    assert.match(e.message, /exit 1/);
    assert.ok(e.message.includes(FIXED_HINT));
    assert.ok(!("detail" in e), "no detail field");
    return true;
  });
  const loose = "LooseSecretValue_1234567890";
  await assert.rejects(issueSessionToken("t3", { run: runner({ code: 1, stdout: `oops ${loose}`, stderr: `bad ${loose}` }).run }), (e: unknown) => {
    const all = everything(e);
    return !all.includes(loose) && !all.includes("oops") && !all.includes("bad ");
  });
  await assert.rejects(revokeSession("/h/t3", SID, runner({ code: 2, stdout: "revoke-stdout-text", stderr: "revoke-stderr-text" }).run), (e: unknown) => {
    assert.ok(e instanceof T3AuthError);
    const all = everything(e);
    assert.ok(!all.includes("revoke-stdout-text") && !all.includes("revoke-stderr-text"));
    assert.match(e.message, /exit 2/);
    assert.ok(!("detail" in e));
    return true;
  });
});

test("leak probe: token adjacent to '=' in stdout and repeated in stderr never reaches the error", async () => {
  const tok = "opaque.Session~Token.abcdefgh";
  const stdout = `issued token=${tok} but could not persist the session record`;
  await assert.rejects(issueSessionToken("t3", { run: runner({ code: 1, stdout, stderr: `denied ${tok}` }).run }), (e: unknown) => {
    const all = everything(e);
    for (const s of [tok, "issued", "persist", "denied"]) assert.ok(!all.includes(s), s);
    return true;
  });
});

test("exit 0 with an invalid or missing session id: unexpected-response error, parsed token pinned", async () => {
  for (const [i, sessionId] of [["1", "short"], ["2", undefined]] as const) {
    const tok = `unexpected-response-token-${i}-abcdef`;
    await assert.rejects(issueSessionToken("t3", { run: runner({ code: 0, stdout: JSON.stringify({ token: tok, sessionId }) }).run }), (e: unknown) => {
      assert.ok(e instanceof T3AuthError);
      assert.equal(e.message, "T3 returned an unexpected issue response");
      assert.ok(!everything(e).includes(tok));
      return true;
    });
    for (let k = 0; k < 100; k++) registerSecret(`evict-filler-${i}-${String(k).padStart(4, "0")}`);
    assert.ok(!redact(`x ${tok} y`).includes(tok), "token pinned so later output cannot leak it");
  }
});

test("shell branch rejects CLI paths with quotes or control characters (win32 only)", { skip: process.platform !== "win32" }, async () => {
  const { run } = runner({ code: 0, stdout: issueOut("opaque-token-value-1234567890") });
  await assert.rejects(issueSessionToken(String.raw`C:\a" & calc & ".cmd`, { run }), T3AuthError);
  await assert.rejects(revokeSession("C:\\a\nb.cmd", SID, run), T3AuthError);
});

test("mintWsTicket and probe use redirect: error", async () => {
  let init: RequestInit | undefined;
  const f = (async (_u: unknown, i: RequestInit) => { init = i; return Response.json({ ticket: "ticket-value-123456" }); }) as typeof fetch;
  await mintWsTicket(ORIGIN, "TOKENTOKEN", f);
  assert.equal(init!.redirect, "error");
});

test("revokeSession runs `auth session revoke <id>`; failures and bad ids throw T3AuthError", async () => {
  const ok = runner({ code: 0 });
  await revokeSession("/h/t3", SID, ok.run);
  assert.deepEqual(ok.calls[0]!.args, ["auth", "session", "revoke", "--", SID]);
  await assert.rejects(revokeSession("/h/t3", SID, runner({ code: 1, stderr: "nope" }).run), T3AuthError);
  await assert.rejects(revokeSession("/h/t3", SID, runner({ code: null, timedOut: true }).run), T3AuthError);
  await assert.rejects(revokeSession("/h/t3", "x & calc", ok.run), T3AuthError);
  await assert.rejects(revokeSession("/h/t3", "--help-me-please", ok.run), T3AuthError, "leading dash refused");
});

test("mintWsTicket posts to the rpc ticket endpoint with Bearer and returns the ticket", async () => {
  const body = await fx("http-websocket-ticket.json");
  let seen: { url: string; init: RequestInit } | null = null;
  const f = (async (u: unknown, init: RequestInit) => { seen = { url: String(u), init }; return Response.json(body); }) as typeof fetch;
  assert.equal(await mintWsTicket(ORIGIN, "TOKENTOKEN", f), body.ticket);
  assert.equal(seen!.url, "http://127.0.0.1:3773/api/auth/websocket-ticket/rpc");
  assert.equal(seen!.init.method, "POST");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer TOKENTOKEN");
  assert.ok(seen!.init.signal instanceof AbortSignal);
});

test("mintWsTicket refuses non-local origins before any request", async () => {
  let called = false;
  const f = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  await assert.rejects(mintWsTicket("http://evil.example.com", "TOKENTOKEN", f), T3AuthError);
  assert.equal(called, false);
});

test("mintWsTicket maps 401/403 to T3AuthError with a hint, never leaking the token", async () => {
  for (const [name, status] of [["http-401-missing-credential.json", 401], ["http-403-insufficient-scope.json", 403]] as const) {
    const b = await fx(name);
    const f = (async () => Response.json(b, { status })) as typeof fetch;
    await assert.rejects(mintWsTicket(ORIGIN, "SECRET-TOKEN-VALUE", f), (e: unknown) => {
      assert.ok(e instanceof T3AuthError);
      assert.match(e.message, /token expired or lacks permissions/);
      assert.ok(!JSON.stringify(e).includes("SECRET-TOKEN-VALUE") && !e.message.includes("SECRET-TOKEN-VALUE"));
      return true;
    });
  }
  await assert.rejects(mintWsTicket(ORIGIN, "TOKENTOKEN", (async () => Response.json({}, { status: 200 })) as typeof fetch), T3AuthError);
  // raw fetch error text is never interpolated
  await assert.rejects(mintWsTicket(ORIGIN, "TOKENTOKEN", (async () => { throw new TypeError("fetch failed: Bearer TOKENTOKEN"); }) as typeof fetch), (e: unknown) => {
    assert.ok(e instanceof T3AuthError && !e.message.includes("TOKENTOKEN") && !e.message.includes("fetch failed"));
    return true;
  });
});

const win = process.platform === "win32";
const execFileAsync = promisify(execFile);

test("defaultRunner: .cmd in a path with & % ^ and spaces runs exactly once, no injection", { skip: !win }, async () => {
  const root = await mkdtemp(join(tmpdir(), "t3sm-cmd-"));
  const dir = join(root, "A & B %OS% ^x");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "t3.cmd"), `@echo {"sessionId":"${SID}","token":"opaque-token-value-1234567890"}\r\n@echo %*>&2\r\n`);
    const got = await issueSessionToken(join(dir, "t3.cmd"));
    assert.deepEqual(got, { token: "opaque-token-value-1234567890", sessionId: SID });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("defaultRunner timeout kills the grandchild process (taskkill /T before child.kill)", { skip: !win }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-slow-"));
  // Read-only process count (never kills). The ping runs ~36 s, far beyond every budget below, so "gone" can only mean
  // the timeout killed it; the budgets are generous because the full suite loads the machine (spawns and CIM queries slow down).
  // Asynchronous, so a slow query never delays the runner's own timer.
  const count = async () => Number((await execFileAsync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object { $_.CommandLine -like '*-n 37 127.0.0.2*' } | Measure-Object).Count"], { encoding: "utf8" })).stdout.trim());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await writeFile(join(dir, "slow.cmd"), "@ping -n 37 127.0.0.2 >nul\r\n");
    const t0 = Date.now();
    let settledAt: number | null = null;
    const pending = defaultRunner(join(dir, "slow.cmd"), [], { shell: true, timeoutMs: 4000, env: { ...process.env } as Record<string, string> });
    void pending.then(() => { settledAt = Date.now(); }, () => { settledAt = Date.now(); });
    let seen = false;
    while (!seen && settledAt === null) {
      seen = (await count()) >= 1;
      if (!seen) await sleep(100);
    }
    assert.ok(seen, "grandchild ping is running before the timeout");
    const r = await pending;
    assert.equal(r.timedOut, true);
    const took = (settledAt ?? Date.now()) - t0;
    assert.ok(took < 8000, `took ${took} ms`);
    let left = await count();
    for (const end = Date.now() + 5000; left > 0 && Date.now() < end; left = await count()) await sleep(200);
    assert.equal(left, 0, "grandchild ping is gone after the timeout");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("leak probe: noisy stdout + `denied <tok>` stderr; nothing from either stream reaches the error, registry untouched", async () => {
  const tok = "probeTokenValue.abcdef0123456789";
  const noise = Array.from({ length: 80 }, (_, i) => `noiseword_number_${String(i).padStart(3, "0")}_xyz`).join(" ");
  const stdout = `garbage ${tok} ${noise}`;
  await assert.rejects(issueSessionToken("t3", { run: runner({ code: 1, stdout, stderr: `denied ${tok}` }).run }), (e: unknown) => {
    assert.ok(e instanceof T3AuthError);
    const all = everything(e);
    for (const s of [tok, "garbage", "noiseword", "denied"]) assert.ok(!all.includes(s), s);
    return true;
  });
  // a failed call must not have registered noise globally
  assert.equal(redact("noiseword_number_000_xyz"), "noiseword_number_000_xyz");
});

test("pinned session token survives 100 ticket registrations; revoke(token) unpins it", async () => {
  const token = "pinned-session-token-value-0001";
  const { run } = runner({ code: 0, stdout: issueOut(token) });
  await issueSessionToken("/h/t3", { run });
  for (let i = 0; i < 100; i++) registerSecret(`ticket-value-${String(i).padStart(4, "0")}-xx`);
  assert.ok(!redact(`x ${token} y`).includes(token));
  await revokeSession("/h/t3", SID, runner({ code: 0 }).run, token);
  assert.ok(redact(`x ${token} y`).includes(token), "unpinned after revoke");
});

test("a failed issue with an error JSON on stdout does not redact error tags later", async () => {
  const out = JSON.stringify({ error: "AuthSessionIssueFailed", method: "bearer-access-token" });
  await assert.rejects(issueSessionToken("t3", { run: runner({ code: 1, stdout: out }).run }), T3AuthError);
  const e = new RpcError("agentSessions.import", { _tag: "AuthSessionIssueFailed", method: "bearer-access-token" });
  assert.equal((e.cause as { _tag: string })._tag, "AuthSessionIssueFailed");
  assert.equal((e.cause as { method: string }).method, "bearer-access-token");
});

test("shell path also rejects '!' (win32)", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(issueSessionToken(String.raw`C:\a!b\t3.cmd`, { run: runner({ code: 0, stdout: issueOut("opaque-token-value-1234567890") }).run }), T3AuthError);
});

function fakeProcess() {
  const em = new EventEmitter() as EventEmitter & { pid: number; kills: [number, string][]; kill: (pid: number, sig: string) => boolean };
  em.pid = 4242;
  em.kills = [];
  em.kill = (pid, sig) => { em.kills.push([pid, sig]); return true; };
  return em;
}
const counts = (p: EventEmitter) => ["exit", "SIGINT", "SIGTERM"].map((ev) => p.listenerCount(ev));

test("trackChild: handlers installed once while children run, removed when the set empties", () => {
  const p = fakeProcess();
  assert.deepEqual(counts(p), [0, 0, 0]);
  const killed: string[] = [];
  const ua = trackChild(() => killed.push("a"), p);
  const ub = trackChild(() => killed.push("b"), p);
  assert.deepEqual(counts(p), [1, 1, 1], "installed once, lazily");
  ua();
  assert.deepEqual(counts(p), [1, 1, 1]);
  ub();
  ub(); // idempotent
  assert.deepEqual(counts(p), [0, 0, 0], "removed when empty");
  assert.deepEqual(killed, []);
});

test("trackChild: exit kills running children without re-raising", () => {
  const p = fakeProcess();
  const killed: string[] = [];
  trackChild(() => killed.push("a"), p);
  trackChild(() => killed.push("b"), p);
  p.emit("exit", 0);
  assert.deepEqual(killed.sort(), ["a", "b"]);
  assert.deepEqual(counts(p), [0, 0, 0]);
  assert.deepEqual(p.kills, []);
});

test("trackChild: SIGINT/SIGTERM kill children, then re-raise the signal (Ctrl+C is not swallowed)", () => {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const p = fakeProcess();
    const killed: string[] = [];
    trackChild(() => { killed.push("a"); throw new Error("kill failed"); }, p);
    trackChild(() => killed.push("b"), p);
    p.emit(sig, sig);
    assert.deepEqual(killed.sort(), ["a", "b"], "a throwing kill does not stop the others");
    assert.deepEqual(counts(p), [0, 0, 0]);
    assert.deepEqual(p.kills, [[4242, sig]], `${sig} re-raised on self`);
  }
});

test("trackChild: does not re-raise when another SIGINT listener owns the signal", () => {
  const p = fakeProcess();
  const other = () => {};
  p.on("SIGINT", other);
  trackChild(() => {}, p);
  p.emit("SIGINT", "SIGINT");
  assert.deepEqual(p.kills, []);
  assert.equal(p.listenerCount("SIGINT"), 1);
});

test("B15: a failed revoke names the revoke command in its hint, not the issue command", async () => {
  await assert.rejects(revokeSession("/h/t3", SID, runner({ code: 1 }).run), (e: unknown) => {
    assert.ok(e instanceof T3AuthError);
    assert.match(String(e.hint), /t3 auth session revoke/);
    assert.doesNotMatch(String(e.hint), /issue/);
    return true;
  });
});
