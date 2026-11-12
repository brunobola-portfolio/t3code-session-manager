# Spike S1: T3Code `/ws` RPC and HTTP wire format

- **Tested live against:** T3 Code Nightly desktop, `serverVersion` `0.1.9-nightly.20261110.4465`, `orchestrationProtocolVersion` 2, `databaseMigration` 80, Windows 11 x64, on 2026-11-10.
- **Source read:** `pingdotgg/t3code` at commit `c0cb75e8` (about 0.1.8-nightly.20261105), plus `effect@4.1.2` (`effect/rpc`, which is the pinned catalog version).
- **Differences between the clone and live 0.1.9:** none observed. Every frame shape, scope rule, error frame and HTTP status that was predicted from source matched the live server. (`server.getSettings` does not exist in either. See §5.)
- **Read-only:** no writing RPC or mutation was sent. The `agentSessions.import` call used an invalid payload that is rejected in the protocol loop before the auth middleware and the handler run (§4.4). The only state the spike created is two bearer sessions in T3's auth store (labels `t3sm-spike-S1` and `t3sm-spike-S1-narrow`, TTL 1h).

## Decision: hand-rolled JSON frames are sufficient

`effect/rpc` with `RpcSerialization.layerJson` puts one plain JSON object in each WebSocket text frame. The envelope has fixed fields (`_tag`, `id`/`requestId`, `tag`, `payload`, `headers`, `exit`). Request ids are client-chosen strings or numbers and are echoed back unchanged. The server never pings or sends anything unsolicited. Unary RPCs (everything t3sm needs: `agentSessions.scan`, `agentSessions.import`, `server.getConfig`, `server.updateSettings`) return exactly one `Exit` frame and need no client `Ack`. Only streams need `Ack` (§4.3), and t3sm needs none. Adding `effect` (about 4 MB, and fast-moving v4) would buy nothing over a ~100-line client.

Strict validation of response shapes is done by our own decoders (Task 12), not by T3's schemas.

## 1. Discovery

`~/.t3/userdata/server-runtime.json`:

```json
{"version":1,"pid":129232,"host":"0.0.0.0","port":3773,"origin":"http://127.0.0.1:3773","startedAt":"2026-11-10T15:46:19.666Z","serverVersion":"0.1.9-nightly.20261110.4465","managedPolicy":null,"ownerId":"<uuid>"}
```

- Use `origin`.
- **The file is not removed when the app quits.** During this spike it pointed at a dead pid/port for six hours. "T3Code running" must be decided by a live request (e.g. `GET {origin}/.well-known/t3/environment`, ~3 ms), not by the file existing. ECONNREFUSED means exit 3.

`GET {origin}/.well-known/t3/environment`:
- Needs no auth (it also accepts a Bearer).
- Returns 200 with `{environmentId, label, platform:{os,arch}, serverVersion, orchestrationProtocolVersion, databaseMigration, capabilities:{…~70 flags}}`.
- Fixture: `http-environment.json`. Use `serverVersion` for the compatibility gate and `orchestrationProtocolVersion === 2`.

## 2. Auth

### 2.1 Bearer token (CLI)

```
C:\Users\<user>\.t3\bin\t3.cmd auth session issue --token-only [--label t3sm] [--ttl 1h] [--scope <s>]...
```

- Exit 0. Stdout is the token plus a newline, and nothing else (logs are suppressed with `--token-only`). The token is ~670 chars of base64url JSON claims plus a signature, starting `eyJ2Ijox`.
- Takes ~1 s. Works even when the server is **not** running (it signs locally against the userdata secret store).
- Each call creates a persistent session record. List and revoke with `t3 auth session list|revoke`.
- Default TTL is 30 days.
- **Scopes:** with no `--scope`, the token gets `AuthStandardClientScopes`: 16 permissions, including `orchestration:read`, `orchestration:operate` and `settings:write`, plus providers:manage, environment:maintain, filesystem:*, terminal:* and others. `--scope` is repeatable and **replaces** the default set (`apps/server/src/cli/authScopes.ts`).
- t3sm should request exactly `--scope orchestration:read --scope orchestration:operate`. Add `--scope providers:manage` only when `server.updateSettings` carries a `providerInstanceMutation`; it is required then (`RpcAuthorization.ts`, `requiredScopesForSettingsUpdate`). *(Corrected in Task 12: `settings:write` was dropped. t3sm only sends empty patches with a mutation, and those need `providers:manage` alone, RpcAuthorization.ts 244-250.)*
- Other flags: `--json` prints `{sessionId, token, method, scopes, subject, client, expiresAt}`. `--subject <s>` is also accepted.

### 2.2 Session check

`GET /api/auth/session` with `authorization: Bearer <token>` returns 200. Fixture: `http-auth-session.json`.

```json
{"authenticated":true,"auth":{"policy":"remote-reachable","bootstrapMethods":[…],"sessionMethods":[…],"sessionCookieName":"t3_session_3773","serverUpdateScope":"environment:maintain"},
 "scopes":[…legacy subset…],"permissions":[…full grant list…],"sessionMethod":"bearer-access-token","expiresAt":"…"}
```

- **Check `permissions`, not `scopes`.** `scopes` is a legacy-filtered subset: our default token showed 7 `scopes` against 16 `permissions`, and `settings:write` appears only in `permissions`.
- Without a Bearer: 200 `{"authenticated":false,"auth":{…}}` (fixture `http-auth-session-unauthenticated.json`).

### 2.3 WebSocket ticket

```
POST {origin}/api/auth/websocket-ticket/rpc
authorization: Bearer <token>
(no body)
```

- Returns 200 with `cache-control: no-store` and body `{"ticket":"<signed token>","expiresAt":"<now+5min ISO>"}`. Fixture: `http-websocket-ticket.json`.
- `/api/auth/websocket-ticket` without `/rpc` also works and issues a ticket for any use (for older clients). Prefer `/rpc`.
- TTL is 5 minutes. The ticket is stateless and can be reused within its TTL unless it is DPoP-bound (ours are not). Mint a fresh ticket for each connection.
- Takes ~2 ms.

### 2.4 Auth error bodies (HTTP)

| case | status | body (fixture) |
|---|---|---|
| no / invalid credential | 401 | `{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential","traceId":"…"}` (`http-401-missing-credential.json`) |
| missing scope | 403 | `{"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"orchestration:read","requiredPermission":"orchestration:read","traceId":"…"}` (`http-403-insufficient-scope.json`) |
| shell without `x-t3-orchestration-protocol: 2` | 400 | empty body |

## 3. WebSocket connection

```
ws://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket=<encodeURIComponent(ticket)>
```

- Use Node's global `WebSocket`. No subprotocol and no extra headers are needed. The socket opened in ~5 ms.
- **Do not** add `frameParts=1`. The web client uses it to have large frames split into parts; without it every message arrives as one complete frame. Single frames of 241 KB were observed.
- `orchestrationProtocol` missing or not `2` gives HTTP 426 `{"code":"orchestration_protocol_incompatible","message":"…","orchestrationProtocolVersion":2}` (from source). Node's `WebSocket` only shows an `error` event with no status, as observed for `orchestrationProtocol=1`.
- A bad ticket gives HTTP 401 (`EnvironmentAuthInvalidError`, from source). Node's `WebSocket` again only shows an `error` event, as observed. When the socket fails to open, re-check with `GET /api/auth/session` to tell a dead server, a bad token and a version mismatch apart.
- Alternative path (Node-only undici extension): `new WebSocket(url, { headers: { authorization: "Bearer …" } })` with no `wsTicket` **also opened** (the server falls back to normal request auth). It is not standard WHATWG, so keep the ticket flow as the primary path.
- Optional query params t3sm does not need: `clientCapabilities=…` (settings secret references), `dpop=…`.
- Closing: just `ws.close()`. Sending `{"_tag":"Eof"}` first is optional. After `Eof` the server ends the client once in-flight requests finish, but the socket was not closed by the server within 1 s.
- The server keeps the session as "connected" while the socket is open. It also closes the socket if the session is revoked (`awaitInvalidation`).

## 4. Frames

All frames are UTF-8 JSON text. The server's decoder also accepts a JSON **array** of messages in one frame. The server never batched replies in this spike, but a robust client should accept `Array.isArray(msg) ? msg : [msg]`.

### 4.1 Client → server

```json
{"_tag":"Request","id":"2","tag":"agentSessions.scan","payload":{},"headers":[]}
```

- `id`: string **or** number. It is echoed verbatim in `requestId`: `"2"` comes back as `"2"` and `6` comes back as `6`. Recommendation: a monotonically increasing integer, sent as a string.
- `tag`: the RPC name (e.g. `agentSessions.scan`).
- `payload`: the RPC's encoded input. `{}` for scan, getConfig and probe.
- `headers`: an array of `[name, value]` pairs. It is required; send `[]`. Malformed headers give a Die "Invalid request headers".
- Optional, unused by t3sm: `isNotification: true` (no reply), `discard: true`, and `traceId`/`spanId`/`sampled` (the server runs with tracing disabled).

Other client frames:

```json
{"_tag":"Ping"}                          → server replies {"_tag":"Pong"} (~2 ms)
{"_tag":"Ack","requestId":"s1"}          → only for streams, after each Chunk (§4.3)
{"_tag":"Interrupt","requestId":"s1"}    → cancel an in-flight request/stream
{"_tag":"Eof"}                           → "no more requests"; optional
```

### 4.2 Server → client: unary success

```json
{"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{ …RPC success value… }}}
```

- Unary RPCs send exactly one frame: no Chunk, no Ack, nothing else.
- **No keep-alive is required.** The server sent nothing in 3 s of idle time. It never pings, so the client never has to answer anything. The web client pings for its own liveness detection; t3sm can rely on a per-call timeout instead.

### 4.3 Server → client: streams (only for reference; t3sm uses none)

Captured with the read-only `subscribeServerConfig`, payload `{}`:

```json
{"_tag":"Chunk","requestId":"s1","values":[{"version":1,"type":"snapshot","config":{…ServerConfig…}}]}
```

- The server sends one `Chunk`, then **blocks until the client sends `{"_tag":"Ack","requestId":"s1"}`**. Each Chunk needs its own Ack.
- `Interrupt` ends the stream with `{"_tag":"Exit","requestId":"s1","exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":3007}]}}`.
- Fixtures: `ws-stream-chunk.json`, `ws-stream-interrupted.exit.json`.

### 4.4 Failures

`exit._tag === "Failure"` carries `cause`, an array of the following:

| cause entry | meaning | observed |
|---|---|---|
| `{"_tag":"Fail","error":{…}}` | typed domain error from the RPC's `error` schema; `error._tag` names it | missing scope: `{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read","requiredPermission":"orchestration:read"}` (`ws-missing-scope.exit.json`) |
| `{"_tag":"Die","defect":<string or {name,message,…}>}` | protocol-level failure | unknown tag: `"defect":"Unknown request tag: server.getSettings"` (`ws-unknown-tag.exit.json`); payload schema failure: `"defect":"Missing key\n  at [\"projectId\"]"` for `agentSessions.import` with `{}` (`ws-invalid-payload.exit.json`) |
| `{"_tag":"Interrupt","fiberId":n}` | interrupted (client Interrupt or server shutdown) | `ws-stream-interrupted.exit.json` |

- **Where an invalid payload is rejected.** Per `effect/rpc/RpcServer.ts` (`makeProtocol` loop), the payload is decoded with the RPC schema **before** `server.write`, which means before the `RpcAuthorization` middleware and before the handler. An undecodable payload therefore cannot cause side effects. A missing scope is caught by the middleware before the handler.
- **Extra keys are tolerated.** `agentSessions.scan` with `{"bogus":1}` succeeded.
- **Socket-level defect** (no `requestId`):

  ```json
  {"_tag":"Defect","defect":{"name":"SyntaxError","message":"Unexpected token 'o', \"not json\" is not valid JSON"}}
  ```

  Sending a non-JSON frame produced this (`ws-malformed-json.defect.json`). The socket stayed open and later requests worked. However, `WS_RPC_SERVER_OPTIONS` says socket-level `Defect` frames "end every pending client request". A client must fail **all** pending calls when it receives a `Defect`.
- Other possible server frames (from source, not observed): `{"_tag":"ClientProtocolError","error":…,"requestIds":[…]}`, which should fail those ids.

**Client rule set (complete):**
1. Accept a frame that is one object or an array of objects.
2. On `Exit`, resolve or reject `requestId`.
3. On `Chunk`, append the values and send `Ack`.
4. On `Defect`, reject everything pending.
5. Ignore `Pong`.
6. On `close` or `error`, reject everything pending.

### 4.5 Timing (live, this machine)

| call | time | response size |
|---|---|---|
| `t3 auth session issue` | ~1000 ms | 673 B |
| `POST /api/auth/websocket-ticket/rpc` | 2 ms | 260 B |
| WS open | 5 ms | |
| `server.probe` `{}` → `{}` | 1 ms | 68 B |
| `agentSessions.scan` (cold, first call after server start) | **2895 ms** | 8.6 KB (25 candidates) |
| `agentSessions.scan` (2nd and 3rd calls) | 836 ms, 803 ms | 8.6 KB |
| `server.getConfig` | 15 ms | **241 KB** |
| `GET /api/projects` | 3 ms | 1.8 KB |
| `GET /api/orchestration/shell` | 10 ms | 3.7 KB |

The scan covered `~/.claude-org` (inherited `CLAUDE_CONFIG_DIR`, see §7) plus `~/.codex`. Use per-call timeouts of 120 s or more for scan; S2 measures larger sets.

## 5. RPCs t3sm uses

Scopes come from `apps/server/src/auth/RpcAuthorization.ts`. Schemas come from `packages/contracts/src/rpc.ts` and `agentSessions.ts`.

| tag | payload | success value | errors (`Fail`) | scope |
|---|---|---|---|---|
| `agentSessions.scan` | `{}` | `{candidates: Candidate[], scannedAt: ISO, truncated?: true}` | `AgentSessionScanError{operation:"read-settings"\|"read-projects", cause}`, `EnvironmentAuthorizationError` | orchestration:read |
| `agentSessions.import` | `{projectId, expectedWorkspaceRoot?}` | `{importedCount, skippedCount}` (non-negative ints) | `AgentSessionImportProjectChangedError{projectId}`, `AgentSessionImportProjectNotFoundError{projectId}`, `AgentSessionScanError`, `EnvironmentAuthorizationError` | orchestration:operate |
| `server.getConfig` | `{}` | `ServerConfig` (see below) | `KeybindingsConfigError`, `ServerSettingsError`, `EnvironmentAuthorizationError` | orchestration:read |
| `server.updateSettings` (not called) | `{patch: ServerSettingsPatch, providerInstanceMutation?: {operation:"create"\|"upsert", instanceId, instance: ProviderInstanceConfig} \| {operation:"remove", instanceId}}` | `ServerSettings` | `ServerSettingsError`, `EnvironmentAuthorizationError` | settings:write (+ providers:manage when there is a mutation; only providers:manage when `patch` is empty) |
| `server.probe` | `{}` | `{}` | | orchestration:read (cheap liveness) |

`Candidate` (live; fixture `ws-scan.exit.json`):

```ts
{ path: string; title: string; projectId?: string; sources: ("claudeAgent"|"codex"|"pi")[];
  threadCount: number; lastActiveAt: string | null; alreadyImported: boolean;
  git?: { remoteKey: string | null; repository: string | null } | null }
```

Notes on candidates:
- `projectId` is present only when a T3 project already matches the path.
- Path casing is passed through as found. Live data had `d:\…` (lowercase drive, from transcripts) next to `D:\…` (the project's `workspaceRoot`).
- `truncated: true` was returned live. In source this flag is set when a per-source discovery budget is hit: `MAX_TRANSCRIPTS_PER_SOURCE` = 5000, operation budget 20000, metadata 64 MiB / 100k records (`AgentSessionScanner.ts`). Twenty-five candidates were still returned. S2 must find out which budget tripped.

**Settings / provider instances.** **There is no `server.getSettings` RPC.** It returns Die "Unknown request tag". The read path is `server.getConfig`:
- `value.settings` holds the full `ServerSettings` with every default filled in. On this machine `settings.providerInstances` is **`{}`**: no instance is configured explicitly, and `settings.json` has no `providerInstances` key.
- The **effective instances** are in `value.providers[]`, one per driver (10 here: codex, claudeAgent, cursor, grok, opencode, antigravity, fx, kiro, muse, pi). Each has `{instanceId, driver, displayName, continuation:{groupKey}, enabled, installed, version, status, auth:{status,type,label,email,workspaceId}, models[], slashCommands[], skills[], workspaceSnapshots?[], usageLimits?, versionAdvisory?, compatibilityAdvisory?, …}`.
- Implicit instances have `instanceId === driver`. The Claude home actually used shows in `continuation.groupKey` = `claude:home:<resolved CLAUDE_CONFIG_DIR or ~/.claude>`.
- Fixture: `ws-getconfig.exit.json`, trimmed.
- `ProviderInstanceConfig` (for updateSettings) = `{driver, displayName?, accentColor?, environment?, enabled?, config?: unknown}`. The Claude `homePath` lives inside `config`.

## 6. HTTP read endpoints

All of these take `authorization: Bearer <token>`.

| endpoint | extra headers | success | scope |
|---|---|---|---|
| `GET /api/projects` | none | `ProjectSnapshot {projects: Project[], updatedAt}` (`http-projects.json`) | orchestration:read |
| `GET /api/orchestration/shell` | **`x-t3-orchestration-protocol: 2`** (400 without it) | `{schemaVersion: 2, snapshotSequence, threads: ShellThread[], archivedThreads: [], projects: ShellProject[]}` (`http-orchestration-shell.json`) | orchestration:read |
| `GET /.well-known/t3/environment` | none (no auth needed) | see §1 | none |

Optional query params on shell (strings): `omitIdleSubagents`, `omitOlderSettled`.

`Project`:

```
{id, title, workspaceRoot, repositoryIdentity?: {canonicalKey, locator:{source,remoteName,remoteUrl}, rootPath, displayName, provider, owner, name} | null,
 faviconPath?, projectIcon?, defaultModelSelection: ModelSelection | null, defaultThreadEnvMode?, autoPull?, scripts: [], pinnedAt?, archivedAt?, createdAt, updatedAt, deletedAt}
```

- `workspaceRoot` uses native backslashes (`D:\…`). `repositoryIdentity.rootPath` uses forward slashes (`D:/…`).
- Shell projects have the same fields minus `deletedAt`.

`ModelSelection` on the wire is `{instanceId, model, options?: [{id, value}]}`. The decoder also accepts the legacy `{provider, model}`.

**Where things are in the shell snapshot** (per `threads[i]`):
- thread id: `threads[i].id`
- project: `threads[i].projectId`, which joins `projects[j].id` (the same ids as `/api/projects` and the scan's `candidate.projectId`)
- provider instance: `threads[i].providerInstanceId` and `threads[i].modelSelection.instanceId`
- also present: `historyOrigin` (the live thread had `"v1_import"`), `providerInstanceHistory[]`, `lineage.rootThreadId`, `itemCount`, `visibleItemCount`, `createdAt`, `updatedAt`, `archivedAt`, `deletedAt`

The one live thread has a plain-UUID `id` (`historyOrigin: "v1_import"`, a legacy import). The design's `import:<instanceId>:<sessionId>` id format for `agentSessions.import` threads was **not observable** read-only. This is an open item for S2.

### 6.1 Project mutations (source-derived, NOT sent)

```
POST /api/projects/mutate
authorization: Bearer <token>
content-type: application/json
```

Create (`http-project-mutate-create.request.json`):

```json
{"type":"project.create","commandId":"<uuid>","projectId":"<uuid>","title":"demo","workspaceRoot":"C:\\work\\demo","createWorkspaceRootIfMissing":false}
```

Optional fields: `defaultModelSelection`, `scripts`.

Update (`http-project-mutate-update.request.json`):

```json
{"type":"project.update","commandId":"<uuid>","projectId":"<uuid>","defaultModelSelection":{"instanceId":"claudeAgent","model":"claude-opus-4-6"}}
```

Optional fields: `title`, `workspaceRoot`, `autoPull`, `projectIcon`, `faviconPath`, `defaultThreadEnvMode`, `scripts`, `pinned`, `archived`. `defaultModelSelection: null` clears it.

- **Ids:** `commandId` and `projectId` are client-generated, non-empty, trimmed strings (branded). T3 uses UUIDs.
- **Success:** 200 with the resulting `Project`. The fixture `http-project-mutate.response.source-derived.json` is built from the `Project` schema, not captured live.
- **Errors:**
  - 400 `EnvironmentRequestInvalidError {code:"invalid_request", reason, traceId}`
  - 403 `EnvironmentScopeRequiredError`
  - 500 `EnvironmentInternalError`
- **Scopes:** orchestration:operate. A body that carries `scripts` also needs the `defaultProjectScripts` settings scope.
- There is also a `project.delete` variant (`{type, commandId, projectId, force?}`), which t3sm does not use.
- The same mutation exists as WS RPC `projects.mutate`. t3sm should use HTTP.

## 7. Findings that affect the plan

1. **The implicit `claudeAgent` instance follows the launching process environment.** In this run `providers[claudeAgent].continuation.groupKey` was `claude:home:C:\Users\<user>\.claude-org`, and `auth` reported the Team subscription. The cause: the desktop app (pid 129232) was relaunched from a Claude Code session whose process env had `CLAUDE_CONFIG_DIR=…\.claude-org`. That variable is **not** set at User or Machine level, so a normal Start-menu launch should give `~/.claude`. Design §3.3/§4.3 assumes `claudeAgent` = `~/.claude`. t3sm must (a) read the effective home from `groupKey` instead of assuming it, and (b) pin `homePath` explicitly for every Claude instance it manages, so the result does not depend on how T3 was launched. `doctor` should warn when the `groupKey` of `claudeAgent` differs from the configured account home.
2. `settings.providerInstances` is `{}`. Default instances are implicit. Creating a second Claude instance through `server.updateSettings` will be the first explicit entry, so check whether an explicit entry for the default `claudeAgent` id is also needed to pin its `homePath`. Task 11/12 must decide this.
3. Scan returned `truncated: true` even here (S2).
4. `server-runtime.json` goes stale when the app quits (§1).
5. Check token permissions with `permissions[]`, not `scopes[]` (§2.2).

## 8. Fixtures (`test/fixtures/t3-wire/`)

Scrubbing:
- emails become `user@example.com`
- UUIDs become `00000000-0000-4000-8000-00000000000N`, with a consistent mapping across files, so `projectId` joins still hold
- `C:\Users\<real>` becomes `C:\Users\demo`; the `.claude-org` dir becomes `.claude-alt`
- project paths become `<drive>:\work\demo-N`, keeping drive-letter case and separator style
- titles, git remotes and owners become `demo` values
- the machine label becomes `DEMO-PC`, the LAN IP `192.168.0.10`, tickets `<redacted-ticket>`
- skill/command descriptions become `Demo description`

Field names, nesting, types and nulls are unchanged.

Trimming (arrays only; every element kept is real):

| array | trimmed |
|---|---|
| `/api/projects` projects | 2 → 1 |
| shell `projects` | 2 → 1 (threads: 1, untrimmed) |
| `agentSessions.scan` candidates | 25 → 2: one `alreadyImported` with `projectId`, one with `git:null` |
| `server.getConfig` (and the stream chunk's `config`) `providers` | 10 → 2 (claudeAgent, codex) |
| `keybindings` | 87 → 1 |
| claudeAgent models / slashCommands / skills | 14/106/21 → 1 each |
| codex models / slashCommands / skills | 3/3/214 → 1 each |
| `models[].capabilities.optionDescriptors` and arrays inside `workspaceSnapshots[]` | → 1 |

Fixture files:

| file | content |
|---|---|
| `http-environment.json` | `/.well-known/t3/environment` |
| `http-auth-session.json`, `http-auth-session-unauthenticated.json` | `/api/auth/session` with and without Bearer |
| `http-websocket-ticket.json` | ticket response |
| `http-401-missing-credential.json`, `http-403-insufficient-scope.json` | HTTP error bodies |
| `http-projects.json`, `http-orchestration-shell.json` | read endpoints |
| `http-project-mutate-create.request.json`, `http-project-mutate-update.request.json`, `http-project-mutate.response.source-derived.json` | source-derived, not live |
| `ws-request-scan.json`, `ws-ping.json`, `ws-pong.json` | client frames and Pong |
| `ws-scan.exit.json`, `ws-getconfig.exit.json`, `ws-probe-numeric-id.exit.json` | success Exits |
| `ws-unknown-tag.exit.json`, `ws-invalid-payload.exit.json`, `ws-missing-scope.exit.json`, `ws-malformed-json.defect.json` | failures |
| `ws-stream-chunk.json`, `ws-stream-interrupted.exit.json` | stream |

## 9. Open items

- The `agentSessions.import` success and typed-error frames (`ProjectNotFound`/`ProjectChanged`) were not captured live (writing). Shapes come from the schema: `Exit/Success` `{importedCount, skippedCount}`, or `Exit/Failure` `[{_tag:"Fail", error:{_tag:"AgentSessionImportProjectNotFoundError", projectId}}]`. Capture them in S2.
- The `project.create`/`project.update` responses were not captured live (writing). Capture them in S2/Task 11.
- The thread id format of imported threads (`import:<instanceId>:<sessionId>`) still needs confirming in the shell after a real import.
- Which scan budget sets `truncated: true` on this machine (S2).

## Addendum (Task 12, 2026-11-11): orchestration commands (`thread.archive` / `thread.unarchive`)

- **Source:** first read from the `server.asar` bundled with the installed T3 Code Nightly `0.1.9-nightly.20261110.4465`, then confirmed against a fresh clone (`packages/contracts/src/orchestrationV2.ts` 2973-2993 and 3618, `apps/server/src/auth/RpcAuthorization.ts` 42). Not called live: T3 was not running, and both are writes.
- **RPC tag:** `orchestration.dispatchCommand` (the `ORCHESTRATION_WS_METHODS.dispatchCommand` constant). Defined as `Rpc.make("orchestration.dispatchCommand", {payload: OrchestrationCommand, success: {sequence: number}, error: OrchestrationV2DispatchCommandError | EnvironmentAuthorizationError})`.
- **Payload** = the command object itself (no wrapper):

  ```json
  {"type":"thread.archive","commandId":"<uuid>","threadId":"<thread id>"}
  {"type":"thread.unarchive","commandId":"<uuid>","threadId":"<thread id>"}
  ```

  `commandId` is client-generated (T3's own client uses a UUID), exactly as for `project.create`.
- **Success value:** `{"sequence": <non-negative integer>}` (the event sequence after the command). Decoder: `decodeDispatch`.
- **Typed error:** `OrchestrationV2DispatchCommandError {commandId, commandType, message, detail?, cause?}`.
- **Scope:** `orchestration:operate` (RpcAuthorization.ts 42).
- **Archived threads are not in `GET /api/orchestration/shell`.** `ShellStream.ts` 61-72 hard-codes `archivedThreads: []`, so the HTTP shell lists active threads only. Read archived ones with the RPC **`orchestration.getArchivedShellSnapshot`**: payload `{}`, success `{schemaVersion, snapshotSequence, projects: ShellProject[], threads: ShellThread[]}` (orchestrationV2.ts 3680), scope `orchestration:read`. `T3Api.listThreads()` merges both lists. A thread from the snapshot (or with `archivedAt` set) is `archived: true`, and the snapshot wins if a thread id appears in both.
- **`project.update` response:** a `Project`, the same as `project.create` (confirmed in the contract).
- **ServerProvider optionality (server.ts 211-245):** `displayName`, `accentColor`, `continuation`, `runtimePaths` and `availability` are optional. `auth` (`{status, email?}`) and `models` are required. Unavailable instances (`buildUnavailableProviderSnapshot`) have `availability:"unavailable"`, `enabled:false`, `auth.status:"unknown"`, `models:[]` and no continuation. The t3sm home of an instance is resolved in this order: `settings.providerInstances[id].config.homePath`, then `runtimePaths.homePath`, then the `<kind>:home:<dir>` part of `continuation.groupKey`.
