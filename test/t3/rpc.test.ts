import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RpcClient, buildWsUrl, type Transport } from "../../src/t3/rpc.ts";
import { MAX_EXACT_SCAN, RpcClosed, RpcError, RpcTimeout, T3AuthError, T3NotRunning, registerSecret, unregisterSecret, redact } from "../../src/t3/errors.ts";

const fx = async (n: string) => JSON.parse(await readFile(new URL(`../fixtures/t3-wire/${n}`, import.meta.url), "utf8"));

class FakeTransport implements Transport {
  sent: string[] = [];
  closed = 0;
  private f: (s: string) => void = () => {};
  private c: (n: number) => void = () => {};
  send(s: string) { this.sent.push(s); }
  onFrame(cb: (s: string) => void) { this.f = cb; }
  onClose(cb: (n: number) => void) { this.c = cb; }
  close() { this.closed++; }
  emit(v: unknown) { this.f(typeof v === "string" ? v : JSON.stringify(v)); }
  drop(code = 1006) { this.c(code); }
}
const id = (u: unknown) => u;
const withKey = (o: Record<string, unknown>, key: string, v: unknown) => ({ ...o, [key]: v });

test("request frames byte-match the recorded S1/S2/S4 requests (id aside)", async () => {
  for (const [file, tag] of [["ws-request-scan.json", "agentSessions.scan"], ["ws-import.request.json", "agentSessions.import"], ["ws-updatesettings.request.json", "server.updateSettings"]] as const) {
    const rec = await fx(file);
    const t = new FakeTransport();
    const c = new RpcClient(t);
    const p = c.call(tag, rec.payload, id, 50);
    assert.equal(t.sent[0], JSON.stringify(withKey(rec, "id", "1")));
    c.close();
    await assert.rejects(p, RpcClosed);
  }
});

test("success decodes; ids increment as strings; numeric echo matches", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const scan = await fx("ws-scan.exit.json");
  const probe = await fx("ws-probe-numeric-id.exit.json");
  const a = c.call("agentSessions.scan", {}, (u) => (u as { candidates: unknown[] }).candidates.length);
  const b = c.call("server.probe", {}, id);
  assert.equal(JSON.parse(t.sent[1]!).id, "2");
  t.emit(withKey(probe, "requestId", 2)); // numeric echo of "2"
  t.emit(withKey(scan, "requestId", "1"));
  assert.equal(await a, scan.exit.value.candidates.length);
  assert.deepEqual(await b, {});
  assert.equal(c.pendingCount, 0);
});

test("array frames are handled and Pong is ignored", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p = c.call("server.probe", {}, id);
  t.emit([await fx("ws-pong.json"), withKey(await fx("ws-probe-numeric-id.exit.json"), "requestId", "1")]);
  assert.deepEqual(await p, {});
});

test("typed failure -> RpcError{tag, cause}; Die -> RpcError; missing scope too", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const cases = [
    ["ws-import-project-not-found.exit.json", "AgentSessionImportProjectNotFoundError"],
    ["ws-missing-scope.exit.json", "EnvironmentAuthorizationError"],
    ["ws-unknown-tag.exit.json", null],
    ["ws-invalid-payload.exit.json", null],
  ] as const;
  for (const [i, [file, errTag]] of cases.entries()) {
    const p = c.call("agentSessions.import", {}, id);
    t.emit(withKey(await fx(file), "requestId", String(i + 1)));
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.tag, "agentSessions.import");
      if (errTag) assert.equal((e.cause as { _tag: string })._tag, errTag);
      return true;
    });
  }
  assert.equal(c.pendingCount, 0);
});

test("a decoder that throws rejects the call with that error", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p = c.call("server.probe", {}, () => { throw new Error("shape"); });
  t.emit(withKey(await fx("ws-probe-numeric-id.exit.json"), "requestId", "1"));
  await assert.rejects(p, /shape/);
});

test("no reply -> RpcTimeout and the pending entry is cleaned up", async () => {
  const c = new RpcClient(new FakeTransport());
  const p = c.call("server.getConfig", {}, id, 20);
  await assert.rejects(p, RpcTimeout);
  assert.equal(c.pendingCount, 0);
});

test("default timeouts: agentSessions.* 120000, others 15000", () => {
  const real = global.setTimeout;
  const seen: number[] = [];
  // @ts-expect-error spy
  global.setTimeout = (fn: () => void, ms: number) => { seen.push(ms); return real(fn, 0).unref(); };
  try {
    const c = new RpcClient(new FakeTransport());
    c.call("agentSessions.scan", {}, id).catch(() => {});
    c.call("server.getConfig", {}, id).catch(() => {});
    c.close();
  } finally { global.setTimeout = real; }
  assert.deepEqual(seen, [120_000, 15_000]);
});

test("transport close rejects all pending with RpcClosed; later calls reject too", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p1 = c.call("a", {}, id);
  const p2 = c.call("b", {}, id);
  t.drop();
  await assert.rejects(p1, RpcClosed);
  await assert.rejects(p2, RpcClosed);
  assert.equal(c.pendingCount, 0);
  await assert.rejects(c.call("c", {}, id), RpcClosed);
});

test("socket-level Defect fails every pending call", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p1 = c.call("a", {}, id);
  const p2 = c.call("b", {}, id);
  t.emit(await fx("ws-malformed-json.defect.json"));
  await assert.rejects(p1, RpcError);
  await assert.rejects(p2, RpcError);
  assert.equal(c.pendingCount, 0);
});

test("stream Chunk -> Interrupt sent and call rejected as stream-unsupported", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p = c.call("server.subscribeServerConfig", {}, id);
  t.emit(withKey(await fx("ws-stream-chunk.json"), "requestId", "1"));
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && (e.cause as { _tag: string })._tag === "StreamUnsupported");
  assert.deepEqual(JSON.parse(t.sent[1]!), { _tag: "Interrupt", requestId: "1" });
  // the late interrupted Exit is ignored
  t.emit(withKey(await fx("ws-stream-interrupted.exit.json"), "requestId", "1"));
});

test("garbage frames are ignored; close() is idempotent", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p = c.call("a", {}, id);
  t.emit("not json");
  t.emit({ _tag: "Exit", requestId: "99", exit: { _tag: "Success", value: 1 } });
  c.close(); c.close();
  assert.equal(t.closed, 1);
  await assert.rejects(p, RpcClosed);
});

test("buildWsUrl follows S1, encodes the ticket and derives ws/wss from the parsed origin", () => {
  assert.equal(buildWsUrl("http://127.0.0.1:3773", "a b+c"), "ws://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket=a%20b%2Bc");
  assert.ok(buildWsUrl("https://localhost", "t").startsWith("wss://localhost/ws?"));
  assert.throws(() => buildWsUrl("http://evil.example.com", "t"), T3AuthError);
  assert.throws(() => buildWsUrl("http://user:pw@127.0.0.1:3773", "t"), T3AuthError);
});

test("timeout sends Interrupt, and a late Exit for that id is ignored", async () => {
  const t = new FakeTransport();
  const c = new RpcClient(t);
  const p = c.call("server.getConfig", {}, id, 20);
  await assert.rejects(p, RpcTimeout);
  assert.deepEqual(JSON.parse(t.sent[1]!), { _tag: "Interrupt", requestId: "1" });
  t.emit(withKey(await fx("ws-probe-numeric-id.exit.json"), "requestId", "1")); // must not throw
  assert.equal(c.pendingCount, 0);
});

test("redact removes registered values (non-JWT) and token-shaped patterns", () => {
  registerSecret("plain-opaque-ticket-9");
  const s = redact("a plain-opaque-ticket-9 b Bearer abc.def wsTicket=zzz&x=1 token: ABCDEFGHIJKLMNOP1234 eyJhbGciOiJIUzI1 " + "A1".repeat(20));
  for (const bad of ["plain-opaque-ticket-9", "abc.def", "zzz", "ABCDEFGHIJKLMNOP1234", "eyJhbGciOiJIUzI1", "A1".repeat(20)]) assert.ok(!s.includes(bad), bad);
  assert.match(redact("token expired or lacks permissions"), /token expired or lacks permissions/);
});

test("errors never carry tokens or tickets when serialized", () => {
  const secret = "eyJ2Ijox.SECRET.sig";
  const errs = [
    new T3AuthError(`failed ${secret}`, { hint: "x" }),
    new RpcError("agentSessions.scan", { _tag: "Boom", message: `bad ${secret}` }),
    new RpcTimeout("agentSessions.scan", 5),
    new RpcClosed("closed"),
    new T3NotRunning(),
  ];
  for (const e of errs) {
    const s = JSON.stringify(e) + e.message + String(e.stack ?? "").split("\n")[0] + JSON.stringify(Object.getOwnPropertyNames(e).map((k) => String((e as never)[k])));
    assert.ok(!s.includes("SECRET"), `${e.name} leaked`);
  }
});

test("RpcError.cause keeps ids and file names (structured redaction is narrow)", () => {
  const cause = { _tag: "AgentSessionImportProjectNotFoundError", projectId: "00000000-0000-4000-8000-000000000007", path: "rollout-2026-11-10T12-00-00-0123456789abcdef0123456789abcdef.jsonl", note: "Bearer abc.def" };
  const e = new RpcError("agentSessions.import", cause);
  const c = e.cause as typeof cause;
  assert.equal(c.projectId, cause.projectId);
  assert.equal(c.path, cause.path);
  assert.equal(c.note, "<redacted>");
});

test("redact: UUIDs survive in free text, long digit runs do not; huge input is capped and fast", () => {
  assert.ok(redact("project 00000000-0000-4000-8000-000000000007 missing").includes("00000000-0000-4000-8000-000000000007"));
  assert.ok(!redact("x " + "a1".repeat(20) + " y").includes("a1a1a1a1"));
  const t0 = Date.now();
  const out = redact("token:" + "a".repeat(500_000) + "!");
  assert.ok(out.length <= 8300 && Date.now() - t0 < 500);
});

test("secret registry is capped (LRU 64) and unregisterSecret removes a value", () => {
  registerSecret("first-registered-secret");
  for (let i = 0; i < 70; i++) registerSecret(`filler-secret-number-${String(i).padStart(3, "0")}`);
  assert.ok(redact("first-registered-secret").includes("first-registered-secret"), "oldest evicted");
  assert.ok(!redact("filler-secret-number-069").includes("number-069"));
  unregisterSecret("filler-secret-number-069");
  assert.ok(redact("filler-secret-number-069").includes("number-069"));
});

test("token pattern covers JSON and key=value forms", () => {
  const v = "ABCDEFGHIJKLMNOP1234567890";
  for (const s of [`{"token": "${v}"}`, `{"token":"${v}"}`, `token=${v}`, `token: ${v}`]) assert.ok(!redact(s).includes(v), s);
});

test("a registered secret straddling the 8192 cut is still removed", () => {
  const secret = "straddling-secret-value-xyz";
  registerSecret(secret);
  const out2 = redact("a".repeat(8180) + secret + "tail");
  assert.ok(!out2.includes("straddling"));
});

test("exact-value pass scans at most 1 MiB, so huge failure payloads stay cheap", () => {
  assert.equal(MAX_EXACT_SCAN, 1024 * 1024);
  for (let i = 0; i < 64; i++) registerSecret(`cost-secret-${String(i).padStart(4, "0")}-q`);
  const big = "x".repeat(128 * 1024 * 1024) + "cost-secret-0001-q";
  const t0 = performance.now();
  const out = redact(big);
  const ms = performance.now() - t0;
  assert.ok(out.length <= 8300);
  assert.ok(ms < 150, `took ${ms.toFixed(0)} ms`);
});
