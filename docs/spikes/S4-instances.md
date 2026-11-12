# Spike S4: second Claude instance through `server.updateSettings`

- **Tested live against:** T3 Code Nightly `0.1.9-nightly.20261110.4465` (orchestration protocol 2), Claude Code CLI `2.1.322`, Windows 11 x64, on 2026-11-10.
- **Source read:** the `pingdotgg/t3code` clone used by S1 (`packages/contracts/src/providerInstance.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/rpc.ts`, `apps/server/src/serverSettings.ts`, `apps/server/src/ws.ts`, `apps/server/src/provider/ProviderInstanceRegistryHydration.ts`, `apps/server/src/provider/Drivers/ClaudeHome.ts`, `packages/client-runtime/src/state/providerInstanceDisplay.ts`).
- **Method:** bearer token with `--scope orchestration:read --scope orchestration:operate --scope settings:write --scope providers:manage` (label `t3sm-spike-S4`, TTL 2 h). Raw `/ws` frames as in S1. Before any write, `server.getConfig` was saved and `~/.t3/userdata/settings.json` was copied (read-only) to `.spike/`. The live settings file was never edited by hand. T3 was not restarted, and no T3 sqlite was opened.
- **Changes left in place (target state):** a new instance `claude-org` (home `~/.claude-org`), and `claudeAgent` pinned to `homePath = ~/.claude`. §7 gives the reversal payloads.

Paths below use `<home>` for `C:\Users\<user>`. Emails are written as `<personal email>` and `<org email>`.

## Verdict

One `server.updateSettings` call with `providerInstanceMutation: {operation: "create"}` adds the instance and leaves every other instance and setting alone. The new instance authenticated as the **org account** about 2 s later. It needed **only** `config.homePath`: `CLAUDE_SECURESTORAGE_CONFIG_DIR` is **not** required on this machine. Pinning `claudeAgent` to `~/.claude` kept its `continuation.groupKey` and its threads unchanged.

## 1. Request and response

Request frame (fixture `test/fixtures/t3-wire/ws-updatesettings.request.json`):

```json
{"_tag":"Request","id":"1","tag":"server.updateSettings","payload":{
  "patch":{},
  "providerInstanceMutation":{"operation":"create","instanceId":"claude-org","instance":{
    "driver":"claudeAgent","displayName":"Claude · Work","accentColor":"#7C3AED","enabled":true,
    "config":{"homePath":"<home>\\.claude-org"}}}},
 "headers":[]}
```

Response: `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":<ServerSettings>}}`. The value is the **full** `ServerSettings` (about 3.4 KB, every default filled in, secrets redacted). Its `providerInstances` is the complete map after the mutation. The request took 13 to 30 ms. Fixture: `ws-updatesettings.exit.json`.

> **What actually happened live:** the first `create` carried a typo path, `<home>.claude-org` with the separator missing. That came from a shell-quoting slip in the spike script, not from T3. T3 accepted it: the instance went to `status:"error"`, `auth.status:"unauthenticated"` about 1 s later, and **no directory was created**. An `upsert` with the right path, 9 s later, fixed it. The committed fixtures show the intended path. Lesson for Task 15: build `homePath` with `path.join`/`path.resolve`, never with string literals, and verify `continuation.groupKey` afterwards (§4).

Live sequence (from `.spike/raw-s4/log.txt`, emails masked):

| t | call | result |
|---|---|---|
| 17:02:07.576 | `create claude-org` (typo path) | Success, 30 ms |
| +29 ms | getConfig | `claude-org` present: `status:"warning"`, `auth.status:"unknown"` |
| +1069 ms | getConfig | `status:"error"`, `auth.status:"unauthenticated"` (path does not exist) |
| 17:02:16.297 | `upsert claude-org` (correct path) | Success, 13 ms |
| +44 ms | getConfig | `status:"warning"`, `auth.status:"unknown"`, groupKey already `claude:home:<home>\.claude-org` |
| **+2096 ms** | getConfig | `status:"ready"`, `auth:{status:"authenticated", type:"Claude Team", label:"Claude Team Subscription", email:<org email>, workspaceId}`, `usageLimits` present |
| 17:02:37.066 | `upsert claudeAgent` (pin) | Success, 14 ms |
| +48 ms | getConfig | `claudeAgent` `status:"warning"`, `auth.status:"unknown"`, groupKey unchanged |
| **+2118 ms** | getConfig | `claudeAgent` `ready`, `authenticated`, `type:"Claude Max"`, `<personal email>` |
| 17:02:47.879 | identical `upsert claude-org` again | Success, 14 ms. **No re-probe**: `checkedAt` unchanged |
| 17:02:49.112 | `create claude-org` again | Failure (see §2) |

## 2. Merge semantics: patch vs mutation

`server.updateSettings` input is `{patch: ServerSettingsPatch, providerInstanceMutation?: ProviderInstanceMutation}` (`rpc.ts` 823). The handler (`ws.ts` 2648) calls `updateSettings(patch)` when there is no mutation. Otherwise it calls `updateProviderInstance(mutation, patch)`, which applies the patch first and then the mutation, in one write under one semaphore (`serverSettings.ts` 1350).

- **`patch.providerInstances` replaces the whole map.** The contract comment says: "Replace whole maps to avoid half-merged driver configs." (`settings.ts` 1708). Sending `{patch:{providerInstances:{"claude-org":…}}}` would **delete every other explicit instance**. t3sm must never use it, except as a whole-map restore.
- **`providerInstanceMutation` is per entry** (`applyProviderInstanceMutation`, `serverSettings.ts` 185):
  - `create`: inserts. It **fails if the id already exists** with `{"_tag":"Fail","error":{"_tag":"ServerSettingsError","settingsPath":"<home>\\.t3\\userdata\\settings.json","operation":"create-provider-instance","providerInstanceId":"claude-org"}}` (observed live, 5 ms).
  - `upsert`: sets `providerInstances[id] = instance`. This **replaces that entry whole** and does not deep-merge `config`, `environment` and so on. Send the full desired entry.
  - `remove`: deletes the entry.
  - Observed live: upserting `claudeAgent` kept `claude-org` in the returned map, and the reverse also held.
- **Diff before against after** (`getConfig`): in `settings`, only the `providerInstances` key changed. In `providers[]`, the only difference is the new `claude-org` entry, which appears directly after `claudeAgent`. `codex`, `claudeAgent` and the 8 disabled drivers kept the same fields, ignoring status, auth and timestamps. On disk, `settings.json` gained only the `providerInstances` block. It is written synchronously: the file showed the change right after the RPC returned.
- **Scope:** an empty `patch` plus a mutation needs only `providers:manage`. A non-empty patch adds `settings:write` (`requiredScopesForServerSettingsPatch`). t3sm's token for instance work therefore needs `providers:manage`.
- **Idempotency for Task 15:** read `getConfig.settings.providerInstances`. If the id is absent, `create`. If it is present and deep-equal to the desired entry, do nothing. An identical `upsert` is harmless, but there is no reason to send it. If it is present and different, treat it as a conflict (a user edit) and do not overwrite silently. Handle a `create-provider-instance` error as "already exists" and re-read.

## 3. Formats

- **Instance id** (`ProviderInstanceId`, `providerInstance.ts`): trimmed, non-empty, at most 64 chars, `/^[a-zA-Z][a-zA-Z0-9_-]*$/`. `claude-org` is valid and was used. Implicit instances use the driver kind as id (`claudeAgent`).
- **Driver** (`ProviderDriverKind`): same slug rules. Claude is `claudeAgent`.
- **`ProviderInstanceConfig`**: `{driver, displayName?: TrimmedNonEmptyString, accentColor?: TrimmedNonEmptyString, environment?: EnvVar[], enabled?: boolean, config?: unknown}`. The driver decodes `config`. For Claude it is `ClaudeSettings`: `{binaryPath, homePath, customModels, launchArgs, autoCompactWindow, idleCompaction, enabled}`, all defaulted. A boolean `config.enabled` is folded into the instance's `enabled` on normalize.
- **`accentColor`**: the server accepts any non-empty string. The UI only **renders** `/^#[0-9a-fA-F]{6}$/` (`normalizeProviderAccentColor`) and ignores anything else. Use `#RRGGBB`. Chosen: `#7C3AED`.
- **`environment`** is an **array**, not a map: `[{name: /^[a-zA-Z_][a-zA-Z0-9_]*$/ (≤128), value: string | SecretReference, sensitive: boolean}]`. The design's `InstanceSpec.environment: Record<string,string>` has to be converted to this shape on the wire. (It was not needed here; see §5.)
- **`displayName`** of an explicit instance without one (the pinned `claudeAgent`) still shows the driver default `"Claude"` in `providers[].displayName`. The pin did not rename it.

## 4. Where the account / auth status lives

- **`server.getConfig` → `value.providers[i]`** with `instanceId === "<id>"`:
  - `auth.status`: `"unknown"` while probing, then `"authenticated"` or `"unauthenticated"`.
  - `auth.email`: the account email. This is **the field to check**.
  - `auth.type` / `auth.label`: the plan (`"Claude Team"` / `"Claude Team Subscription"` for org, `"Claude Max"` for personal).
  - `auth.workspaceId`.
  - `status`: `"warning"` while probing, then `"ready"` or `"error"`.
  - `checkedAt`: when the probe started.
  - `continuation.groupKey`: `claude:home:<resolved homePath>`.
- **Cache file `~/.t3/caches/<instanceId>.json`** (here `claude-org.json`): the same provider snapshot (`instanceId`, `auth`, `status`, `usageLimits`, …). It was created on the first probe. t3sm should use getConfig and not read this file.
- **Result:** `claude-org` reported `<org email>` (matched the expected org address) with `Claude Team`. `claudeAgent` reported `<personal email>` with `Claude Max`. Each was checked by exact comparison in a local script, and nothing was written to disk.
- **Timing:** the probe finishes about **2.1 s** after the RPC (two runs: 2096 ms and 2118 ms). Task 15 should poll `getConfig` every 1 s until `auth.status !== "unknown"` **and** `checkedAt >= requestTime`, with a ~30 s timeout. A wrong or missing home shows `status:"error"`, `auth.status:"unauthenticated"` within ~1 s.

## 5. Is `CLAUDE_SECURESTORAGE_CONFIG_DIR` required? No (on Windows)

With only `config.homePath = <home>\.claude-org` and no `environment`, the instance authenticated as the org account. `makeClaudeEnvironment` sets `CLAUDE_CONFIG_DIR` to the resolved `homePath` (`ClaudeHome.ts`), and on Windows Claude Code keeps its OAuth credentials inside the config dir. So `environment` stays absent. On macOS the credentials live in the Keychain; a second instance there may need `CLAUDE_SECURESTORAGE_CONFIG_DIR`. This is untested, and t3sm should check `auth.email` after creating the instance and only then add the env as `[{name:"CLAUDE_SECURESTORAGE_CONFIG_DIR", value:<home>, sensitive:false}]` before re-checking.

## 6. Pinning `claudeAgent` (Step 3c)

Payload: `{"patch":{},"providerInstanceMutation":{"operation":"upsert","instanceId":"claudeAgent","instance":{"driver":"claudeAgent","config":{"homePath":"<home>\\.claude"}}}}`. The payload has no `displayName`, `enabled` or `accentColor`, so nothing is renamed, and enabled defaults to true.

- Before the pin, `settings.providerInstances` had no `claudeAgent` key. The instance was implicit (`deriveProviderInstanceConfigMap` synthesizes `{driver}` for each built-in driver missing from the map). Its home came from `resolveClaudeHomePath`: `homePath` if non-empty, otherwise the **inherited `CLAUDE_CONFIG_DIR`**, otherwise `~/.claude`. That is why the pin matters: a T3 launched from a shell with `CLAUDE_CONFIG_DIR=~/.claude-org` would silently move the implicit `claudeAgent` to the org home.
- After the pin: `continuation.groupKey` stayed `claude:home:<home>\.claude`. The instance re-probed in 2.1 s, still authenticated with `<personal email>`. `GET /api/orchestration/shell` returned the same threads before and after, grouped by `providerInstanceId|modelSelection.instanceId`: 1 active thread, 0 archived, all `claudeAgent|claudeAgent`. Nothing was re-keyed.
- `settings.defaultModelSelection` (`claudeAgent`), `favorites` and `textGenerationModelSelection` are unchanged.

## 7. Reversal payloads

Each needs `providers:manage`.

| undo | payload |
|---|---|
| remove the org instance | `{"patch":{},"providerInstanceMutation":{"operation":"remove","instanceId":"claude-org"}}` |
| unpin `claudeAgent` (back to implicit) | `{"patch":{},"providerInstanceMutation":{"operation":"remove","instanceId":"claudeAgent"}}`. The implicit `{driver:"claudeAgent"}` is re-synthesized, and its home follows the inherited `CLAUDE_CONFIG_DIR` again. |
| restore exactly the pre-spike map | `{"patch":{"providerInstances":{}}}`. This replaces the whole map, so use it only when the backup map is known: it was `{}` on 2026-11-10, backed up in `.spike/settings-before.json` and `.spike/settings.json.bak`. |

Removing `claude-org` while threads point at it leaves those threads with an unknown instance. `rollbackRun` (Task 17) should remove an instance only if it created it (`instance-created` journal entry) and no thread uses it.

## 8. Usage and limits per instance

`providers[i].usageLimits` is **per instance**: `{checkedAt, windows:[{id:"five_hour"|"seven_day"|"seven_day_fable", kind, label, usedPercent, resetsAt?, windowDurationMins}], resetCredits:{availableCount, nextExpiresAt, nextCreditId}}`. `claude-org` and `claudeAgent` showed different values (for example, weekly 73% against 39%). They first appeared within the same ~2 s probe. The Usage → Limits UI reads per account (`ComposerUsageLimits.tsx` takes `account.accentColor`), so the accent tells the two apart.

## 9. Not verified visually

The spike did not look at the T3Code window (Settings → Providers, the composer picker, the Usage panel). Everything above comes from `server.getConfig`, which is the same `providers[]` snapshot the web client renders. The maintainer should check the picker once: two Claude entries, "Claude" and "Claude · Work" (violet).

## 10. Fixtures (scrubbed: `<home>` becomes `C:\Users\demo`, emails become `personal@example.com` / `org@example.com`, workspaceIds are zeroed)

- `ws-updatesettings.request.json`: the create frame.
- `ws-updatesettings.exit.json`: Success with the full `ServerSettings`.
- `ws-getconfig-instances.exit.json`: an after-state excerpt with `settings.providerInstances` (both entries) and the two `claudeAgent`-driver entries of `providers[]` (models trimmed to 1; slashCommands, skills and workspaceSnapshots emptied).
