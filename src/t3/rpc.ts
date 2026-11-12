import { RpcClosed, RpcError, RpcTimeout, T3AuthError, registerSecret } from "./errors.ts";
import { parseLocalOrigin } from "./runtime.ts";

export interface Transport {
  send(frame: string): void;
  onFrame(cb: (frame: string) => void): void;
  onClose(cb: (code: number) => void): void;
  close(): void;
}

/** ws URL per S1 §3. The ticket is URL-encoded; never log this URL. */
export function buildWsUrl(origin: string, ticket: string): string {
  const base = parseLocalOrigin(origin);
  if (!base) throw new T3AuthError("refusing to open a websocket to a non-local origin");
  registerSecret(ticket);
  const u = new URL("/ws", base);
  u.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  u.search = `?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`;
  return u.href;
}

/** Node's global WebSocket. Rejects after 10 s or on a failed open (message never includes the URL/ticket). */
export function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); ws.binaryType = "arraybuffer"; } catch { reject(new RpcClosed("could not open websocket to T3 Code")); return; }
    let opened = false;
    let frameCb: (f: string) => void = () => {};
    let closeCb: (c: number) => void = () => {};
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* ignore */ } reject(new RpcClosed("websocket connect timed out after 10 s")); } }, 10_000);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send: (f) => ws.send(f),
        onFrame: (cb) => { frameCb = cb; },
        onClose: (cb) => { closeCb = cb; },
        close: () => { try { ws.close(); } catch { /* ignore */ } },
      });
    });
    ws.addEventListener("message", (ev) => frameCb(typeof ev.data === "string" ? ev.data : new TextDecoder("utf-8").decode(ev.data as ArrayBuffer)));
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      if (!opened) reject(new RpcClosed("websocket closed before opening (dead server, bad ticket or protocol mismatch)"));
      else closeCb(ev.code);
    });
    ws.addEventListener("error", () => {
      if (!opened) { clearTimeout(timer); reject(new RpcClosed("websocket failed to open (dead server, bad ticket or protocol mismatch)")); }
      else closeCb(1006);
    });
  });
}

interface Pending {
  tag: string;
  decode: (u: unknown) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SCAN_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Minimal client for effect/rpc JSON frames (S1 §4). Unary calls only; streams are interrupted and rejected. */
export class RpcClient {
  private t: Transport;
  private next = 0;
  private pending = new Map<string, Pending>();
  private closed = false;

  constructor(t: Transport) {
    this.t = t;
    t.onFrame((f) => this.handle(f));
    t.onClose(() => this.failAll(() => new RpcClosed()));
  }

  get pendingCount(): number { return this.pending.size; }

  call<T>(tag: string, payload: unknown, decode: (u: unknown) => T, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosed());
    const ms = timeoutMs ?? (tag.startsWith("agentSessions.") ? SCAN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const id = String(++this.next);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new RpcTimeout(tag, ms));
          this.trySend({ _tag: "Interrupt", requestId: id });
        }
      }, ms);
      this.pending.set(id, { tag, decode, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.t.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcClosed(`send failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(() => new RpcClosed());
    try { this.t.close(); } catch { /* ignore */ }
  }

  private trySend(m: unknown): void {
    try { this.t.send(JSON.stringify(m)); } catch { /* connection already gone */ }
  }

  private take(id: unknown): Pending | undefined {
    if (typeof id !== "string" && typeof id !== "number") return undefined;
    const key = String(id);
    const p = this.pending.get(key);
    if (p) { clearTimeout(p.timer); this.pending.delete(key); }
    return p;
  }

  private failAll(mk: () => unknown): void {
    this.closed = true;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { clearTimeout(p.timer); p.reject(mk()); }
  }

  private handle(frame: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(frame); } catch { return; }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m && typeof m === "object") this.handleOne(m as Record<string, unknown>);
    }
  }

  private handleOne(m: Record<string, unknown>): void {
    switch (m._tag) {
      case "Exit": {
        const p = this.take(m.requestId);
        if (!p) return;
        const exit = m.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
        if (exit?._tag === "Success") {
          try { p.resolve(p.decode(exit.value)); } catch (e) { p.reject(e); }
          return;
        }
        const cause = Array.isArray(exit?.cause) ? (exit!.cause as { _tag?: string; error?: unknown; defect?: unknown }[]) : [];
        const fail = cause.find((c) => c?._tag === "Fail");
        const die = cause.find((c) => c?._tag === "Die");
        if (fail) p.reject(new RpcError(p.tag, fail.error));
        else if (die) p.reject(new RpcError(p.tag, { _tag: "Defect", defect: die.defect, message: typeof die.defect === "string" ? die.defect : (die.defect as { message?: string } | null)?.message }));
        else p.reject(new RpcError(p.tag, { _tag: cause[0]?._tag ?? "UnknownFailure" }));
        return;
      }
      case "Chunk": {
        // t3sm uses no streams: stop it and fail the call.
        const p = this.take(m.requestId);
        if (!p) return;
        this.trySend({ _tag: "Interrupt", requestId: m.requestId });
        p.reject(new RpcError(p.tag, { _tag: "StreamUnsupported", message: "stream-unsupported" }));
        return;
      }
      case "Defect":
        // Socket-level defect ends every pending request (S1 §4.4).
        this.failAllWith(m.defect);
        return;
      case "ClientProtocolError": {
        const ids = Array.isArray(m.requestIds) ? (m.requestIds as unknown[]) : [];
        for (const id of ids) {
          const p = this.take(id);
          if (p) p.reject(new RpcError(p.tag, { _tag: "ClientProtocolError", message: "client protocol error" }));
        }
        return;
      }
      default: // Pong and anything unknown
        return;
    }
  }

  private failAllWith(defect: unknown): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    const message = typeof defect === "string" ? defect : (defect as { message?: string } | null)?.message;
    for (const p of all) { clearTimeout(p.timer); p.reject(new RpcError(p.tag, { _tag: "Defect", defect, message })); }
  }
}
