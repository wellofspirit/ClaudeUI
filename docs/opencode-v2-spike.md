# opencode 2.x spike: can ClaudeUI move to 2.x only?

Date: 2026-10-06. Time-boxed spike: research plus a throwaway prototype. Read with the draft decision
[ADR-097](adr/adr-097_opencode-v2-only.md) and the prior research in `.cache/followup-opencode-adoption.md`
(main checkout).

**Verdict: GO, with conditions.** All three blockers have a working 2.x answer, each proven against
the real 2.0.23 binary:

- non-fatal denial
- caller identity
- owned credentials

The conditions are about churn and credential lifecycle discipline, not about capability (see "Top risks").

Evidence conventions:

- FACT means proven by reading source at the pinned tag (`vendor/opencode-v2-src` @ `v2.0.23`,
  `0fd7e2829`) or by a live run.
- RECOMMENDATION is my proposal.
- Live runs used the real `opencode serve --stdio` 2.0.23 against a localhost OpenAI-compatible
  fixture model. There were no real provider calls.
- Every process ran with `HOME` and `XDG_{DATA,CONFIG,CACHE,STATE}_HOME` under
  `.cache/opencode-v2-spike/home*`.
- Transcripts are in `.cache/opencode-v2-spike/logs/` and `.cache/opencode-v2-spike/chatgpt/logs/`.
  They are not committed.
- The ChatGPT probe (§3a) additionally ran under `sandbox-exec` (loopback only) behind a refusing
  recording proxy. Nothing reached auth.openai.com or chatgpt.com.

## Setup and provenance

- Source: `git worktree add vendor/opencode-v2-src v2.0.23` from the existing `vendor/opencode-src`.
  The path matches the `/vendor/*-src/` ignore rule. All 25 tags `v2.0.0` … `v2.0.24` were fetched.
- Binary: `@opencode/cli-darwin-arm64@2.0.23`, the platform package listed in
  `@opencode/cli@2.0.23.optionalDependencies`.
  - Fetched straight from `registry.npmjs.org`. No install scripts ran. `@opencode/cli` has a
    `postinstall.mjs` that copies the platform binary; it was not run.
  - Tarball sha512 = `5qZx8IqfCKdymb711qBxkjBtNJZ9H2JIkrqIUiLwsrxmIyDMKu8tPTxKKMH91sC5fElZbrBP9M8Jq6LckDnxUw==`,
    which equals npm `dist.integrity`. The meta package also matched (`/a6FNuG/…AoQ==`).
  - Binary SHA-256 `e7bef8c36d9ea0cbc5253bb3367f2c286ea68fed9ea827a341760186b9e12831`, 179 MB.
  - `repository` = `git+https://github.com/anomalyco/opencode.git`. Maintainer `thdxr <d@ironbay.co>`,
    the same sole maintainer as `opencode-ai`. Published by `GitHub Actions <npm-oidc-no-reply@github.com>`
    (OIDC trusted publishing), the same publisher as `opencode-ai@1.18.34`.
  - There is no npm provenance attestation (`dist.attestations` is null). The same is true of the 1.x
    packages.
  - macOS signature: `Developer ID Application: Anomaly Innovations, Inc. (5NZ4Q7NXJ4)`, valid under
    `codesign --verify --strict`.
  - `--version` prints `opencode v2.0.23`. Note the `v`: 1.x prints a bare version.
- npm `latest` moved to **2.0.24** during the spike (tag dated 2026-10-06). Its OpenAPI is
  byte-identical to 2.0.23.

## Prototype transcript (what was driven end-to-end)

Driver: `.cache/opencode-v2-spike/drive.mjs`. Fixture: `fixture-provider.mjs`. Plugin:
`xeng-plugin-v2/`. Plain-HTTP fetch and SSE, no SDK.

| Step                                                                                                                                                                                    | Result                  | Log                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------- |
| `serve --stdio --port 0` → first stdout line `{"url":"http://127.0.0.1:N"}`, boot ≈ 90–110 ms                                                                                           | ✅                      | `transcript-basic.log`                       |
| `POST /api/session {location, permissions}` → `POST /prompt "hello"` → `session.text.delta` "echo: hello spike" → `session.execution.succeeded`; `session.usage.updated {cost, tokens}` | ✅                      | `transcript-basic.log`                       |
| Tool ask → `permission.asked` → reply `reject` + message → **turn continues**; the model gets the reason as the tool result                                                             | ✅                      | `transcript-deny.log`                        |
| reply `reject` without a message → turn ends `session.execution.interrupted`                                                                                                            | ✅ (behaviour recorded) | `transcript-deny.log`                        |
| reply `once` → shell runs → model sees the output                                                                                                                                       | ✅                      | `transcript-deny.log`                        |
| Deny rule via `PATCH /api/session/:id {permissions}` → non-fatal `permission.rejected`, turn continues                                                                                  | ✅                      | `transcript-blocked-steer.log`               |
| Steer mid-stream, two queued items, cancel one (`DELETE /inbox/:id`) → steer and queue delivered in order, cancelled item never reaches the model                                       | ✅                      | `transcript-blocked-steer.log`               |
| Interrupt mid-stream → `{interrupted:true}`, `session.execution.interrupted`, partial text kept in history                                                                              | ✅                      | `transcript-basic-interrupt-sub-history.log` |
| Subagent (`subagent` tool) → child session on the same SSE feed, linked by `parentID` and by tool `metadata.sessionID`                                                                  | ✅                      | same                                         |
| History: `GET /message` hot, then stdin close → process exits 0 → new process → identical list (cold)                                                                                   | ✅                      | same, `history-hot-*.json`                   |
| Question tool → `form.created` → `POST /form/:id/reply {answer:{q0:"Banana"}}` → continues                                                                                              | ✅                      | `transcript-form.log`                        |
| MCP hosted tool with the v2 plugin → MCP server receives `__xeng_caller_session` + `__xeng_call_id` in args **and** `_meta["ai.opencode/sessionID"]`                                    | ✅                      | `transcript-basic-mcp.log`                   |
| Credential `POST /api/credential` (ClaudeUI-chosen id and label) → next model call carries the key → `DELETE` → gone                                                                    | ✅                      | `transcript-cred.log`                        |
| Legacy `auth.json` import (1.18.34 data dir → 2.0.23 open)                                                                                                                              | ✅                      | `v1-then-v2.sh` output (below)               |
| Second directory on the same server (`x-opencode-directory`)                                                                                                                            | ✅                      | `transcript-form-multi.log`                  |
| Env names leaking into shell tools                                                                                                                                                      | measured                | `transcript-envleak.log`                     |
| ChatGPT access-token-only vending, rotate-by-replace, refresh-window failure, shared active slot, under `sandbox-exec` + refusing proxy (§3a)                                           | ✅                      | `chatgpt/logs/transcript.log`                |
| **Not driven:** a real ChatGPT token, compaction, reasoning deltas (the fixture emits none), image attachments, SSE reconnect, Windows.                                                 | ⬜                      |                                              |

## Blockers

### 1. Non-fatal denials (ADR-032): ANSWERED

**FACT (source):**

- `Permission.reply` with `reply === "reject"` fails the pending deferred with
  `CorrectedError{feedback: message}` when a message is present. Without one it fails with
  `DeclinedError` (`packages/core/src/permission.ts:276-292`).
- Any other pending asks in the same session are rejected with the same feedback, because
  "Feedback applies to the whole batch, so parallel asks don't end the step" (`:283-295`).
- `assert` tunnels only `DeclinedError` as a defect. `CorrectedError` "intentionally stays typed so
  the leaf can turn it into ToolFailure and the model continues" (`permission.ts:246-253`).
- `SessionModelRequest.executeTool` turns only Declined/Cancelled into a step failure
  (`session/model-request.ts:384-397`).
- `to-session-error.ts:61-62` maps both `BlockedError` (deny rule) and `CorrectedError` to
  `{type:"permission.rejected", message}`.
- There is no config flag. This is the built-in behaviour, and `experimental.continue_loop_on_deny`
  is listed as an unsupported legacy key (`core/src/config/normalize.ts:46-52`).

**FACT (live, `transcript-deny.log`):**

- `POST /api/session/:sid/permission/:rid/reply {decision:"reject", message:"ClaudeUI denied: use a read-only command instead"}` → 204.
- Then `session.tool.failed {error:{type:"permission.rejected", message:"ClaudeUI denied: …"}}`.
- The fixture then received a 3rd request whose last message is `role:"tool"`, content
  `{"error":{"type":"permission.rejected","message":"ClaudeUI denied: use a read-only command instead"},"content":[]}`.
- The model replied and the turn ended `session.execution.succeeded`.
- A deny **rule** (`{action:"shell",resource:"echo *",effect:"deny"}`) behaves the same, with message
  "Permission denied: shell".
- `reject` **without** a message ends the turn: `session.tool.failed {type:"aborted"}`,
  `session.step.failed`, `session.execution.interrupted`.

**RECOMMENDATION:** always send a non-empty message on reject. ClaudeUI already does (`answers.feedback || 'User denied'`, OpencodeSession.ts:1842). Keep that invariant and pin it with a test: a messageless reject in 2.x is a hard stop, not a soft deny. Delete the `continue_loop_on_deny` injection.

### 2. Caller identity (ADR-033): ANSWERED, with two mechanisms

**FACT (source):**

- The v2 plugin API has `ctx.tool.hook("execute.before", event)`. The event is
  `{tool, sessionID, agent, messageID, id (call id), input}`, and `input` is **mutable**
  (`plugin/src/promise/tool.ts` ToolHooks; trigger at `core/src/tool.ts:103-111`).
- The snapshot executor runs the tool with the hook-returned `event.input` (`tool.ts:271-283`).
  Built-in `tool-input-repair.ts` uses exactly this mechanism.
- Independently, every MCP `tools/call` carries `_meta: {"ai.opencode/sessionID": <sessionID>}`
  (`core/src/mcp/client.ts:358`, fed from `tool/mcp.ts:52-66`). That is native caller identity with
  no plugin, but without the call id.
- Plugin loading (`core/src/config/plugin/source.ts:150-153`): a configured absolute path must be a
  **directory**, not a file. A file path is rejected with the warning "configured plugin path must be
  a directory" and the plugin silently does not load. The directory resolves `server` or `index`
  (`plugin/src/host.ts:17-43`).
- The default export must be `{id, setup(ctx)}` (Promise API) or `{id, effect}`
  (`core/src/plugin/module.ts` `Module`). No imports are needed.
- MCP tools default to **Code Mode** (`codemode` defaults to true, `schema/src/mcp.ts`). The model
  then sees only an `execute` tool, with `tools.spike.spike_echo(...)` inside its catalog. Live proof:
  the first run's tool list had no `spike_echo`.
- Code Mode inner calls do pass through `execute.before`, but with the outer `execute` call's id
  (`tool.ts:241-243`).
- The MCP server must use `codemode: false` to get a direct tool and a 1:1 call id. That key is only
  valid in the native `mcp: {servers: {...}}` shape. The legacy flat `mcp: {name: {...}}` shape is
  normalized through `ConfigMCPV1` (`normalize.ts:248-292`).

**FACT (live, `transcript-basic-mcp.log`):** config `mcp.servers.spike = {type:"remote", url, headers:{Authorization:"Bearer …"}, codemode:false}` plus `plugins:[<dir>]`. The MCP server received:

```json
{
  "name": "spike_echo",
  "arguments": {
    "text": "hello-from-model",
    "__xeng_caller_session": "ses_ef0688222ffe…",
    "__xeng_call_id": "call_fx_3"
  },
  "_meta": { "ai.opencode/sessionID": "ses_ef0688222ffe…", "progressToken": 2 }
}
```

The tool events and the stored history show the **un-stamped** input `{text}`. The stamped args are
only on the wire, which is the same property ADR-033 relied on in 1.x. Prototype:
`.cache/opencode-v2-spike/xeng-plugin-v2/index.js` (12 lines).

**RECOMMENDATION:**

- Read the caller session from `_meta["ai.opencode/sessionID"]` first. It is a first-party upstream
  contract and works even if the plugin fails to load.
- Keep the plugin only for `__xeng_call_id` (live streaming, ADR-033 M3).
- Ship the plugin as a directory (`resources/opencode/claudeui-xeng/index.js` + `package.json`).
- Emit the `claudeui` server with `codemode:false` in the native `mcp.servers` shape.
- Treat a missing call id as degraded but working, as today.

### 3. Credentials: ANSWERED (access-token-only, shared DB, owned ids)

**FACT (source):**

- 2.x stores credentials in the DB `credential` table: `{id, integration_id, label, value, active}`,
  several per integration, one active (`core/src/credential.ts`).
- The public HTTP CRUD (`openapi.json` @ 2.0.23) is:
  - `GET/POST /api/credential`
  - `PATCH/DELETE /api/credential/{id}`
  - `POST …/{id}/activate`
- The list and create routes are **new in 2.0.23**. update, remove and activate existed earlier.
- `CreateInput = {id?, integrationID, label?, value: {type:"key",key,metadata?} | {type:"oauth",methodID,refresh,access,expires,metadata?}, activate?}`
  (`schema/src/credential.ts`).
- `integrationID` is the provider id (`openai`, `openrouter`, …).
- ChatGPT/Codex-client OAuth stays supported as `methodID:"chatgpt-browser"` with the Codex client id
  `app_EMoamEEZ73f0CkXaXp7hrann` (`plugin/provider/openai.ts:15,23,108`). opencode **refreshes and
  rewrites** that credential itself (`refresh()`, `:350-383`), but only when the credential carries a
  refresh token. With `refresh:""` the attempt fails and nothing is written (§3a P3).
- 2.x also adds a new first-party "Sign in with ChatGPT" (`chatgpt-token-sharing`, dynamic client
  registration, `plugin/provider/chatgpt.ts`). That flow is opencode's own, not the Codex client.
- Other routes: `/api/integration/{id}/connect/{key|oauth|command}` covers interactive connect.
  `GET /api/credential` returns secret values to any holder of the server password.
- `auth.json` is read only by a one-shot DB migration, `20260805200742_import_legacy_credentials`
  (`core/src/database/migration/…ts`):
  - It runs once per DB.
  - It skips an integration that already has a row.
  - It maps `api`→`key`, `oauth`→`oauth` with methodID `chatgpt-browser` for `openai`, and
    `wellknown`→`key`.
  - It never deletes or rewrites `auth.json`.
- On a **fresh** DB, bootstrap marks every migration as done without running it
  (`database/migration.ts:30-46`). Live: a fresh data dir with `auth.json` imported **nothing**.

**FACT (live):**

- `transcript-cred.log`:
  - Before: no credential, and the request carries no `Authorization` header.
  - `POST /api/credential {id:"cred_claudeui_spike01", integrationID:"fixture", label:"claudeui:vault:spike01", value:{type:"key",…}}` → 200, `active:true`.
  - Events `credential.updated`, `credential.switched`, `provider.updated`, `model.updated` fire.
  - The next model request carries the key with **no server restart**. `DELETE` → 204 → list empty.
  - A caller-chosen id is accepted verbatim.
- `v1-then-v2.sh`:
  1. 1.18.34 creates a DB plus a session in a data dir with `auth.json`.
  2. 2.0.23 opens the same dir: the credential is imported (label "API key"), `migration/v1` reports
     `completed`, and the 1.x session is visible.
  3. Rewriting `auth.json` and reopening does **not** re-import.

**Owner decisions (Daniel, 2026-10-06):**

- ClaudeUI manages every credential and vends it to opencode.
- ChatGPT is vended as an **access token only** (`refresh:""`), so opencode can never rotate a
  refresh token.
- The data dir is **shared** with the user's opencode.
- There is no separate sign-in import.

#### 3a. Access-token-only ChatGPT vending probe (2026-10-06)

**Method: hermetic in two layers.**

- `opencode serve` ran under `sandbox-exec -f .cache/opencode-v2-spike/chatgpt/loopback-only.sb`,
  i.e. `(deny network-outbound)` plus `(allow network-outbound (remote ip "localhost:*"))` plus unix
  sockets.
  - Control check: curl under the profile got `EPERM` for `1.1.1.1` and `auth.openai.com`, while
    loopback worked.
- `HTTPS_PROXY`/`HTTP_PROXY` pointed at a local **recording proxy that forwards nothing** (403 to
  every CONNECT), with `NO_PROXY=127.0.0.1,localhost`. Bun's `fetch` honours it, so every outbound
  attempt is logged by host.
- A spike-only directory plugin (`chatgpt/redirect-plugin/`) hooks `session.hook("http.request")`.
  The hook gets the fully built web `Request` (`core/src/session/model-request.ts:320-337`). The
  plugin records the URL plus the `authorization`/`chatgpt-account-id`/`originator` headers, then
  rewrites the URL to the localhost fixture, which answers in Responses-API SSE.
- `providers.openai.settings.transport:"http"` keeps the request on HTTP. The ChatGPT default is
  `websocket` (`openai.ts:262`).
- The tokens were fake JWTs carrying `chatgpt_account_id` plus a tag.
- Result: **0 bytes left the machine**. The proxy saw only `CONNECT auth.openai.com:443` (10 attempts,
  all refused). The model requests that reached the fixture were all redirected from
  `https://chatgpt.com/backend-api/codex/responses`.
- Driver `chatgpt/drive-chatgpt.mjs`, log `chatgpt/logs/transcript.log`.

**P1 — access-only POST is accepted and enters ChatGPT mode: YES.**

- `POST /api/credential {id:"cred_claudeui_acct111", integrationID:"openai", label, activate:true, value:{type:"oauth", methodID:"chatgpt-browser", refresh:"", access:<jwt>, expires:now+60m, metadata:{accountID:"acct-111"}}}`
  → 200, `active:true`.
- Events: `credential.updated`, `provider.updated`, `model.updated`,
  `credential.switched(cred_claudeui_acct111)`, then provider/model/integration reloads.
- `/api/model` lists 18 ChatGPT-eligible openai models, all `cost:[]` (model filtering active,
  `openai.ts:273-301`).
- The turn's request: `https://chatgpt.com/backend-api/codex/responses`, `Bearer <A>`,
  `chatgpt-account-id: acct-111`, `originator: opencode` → `succeeded`.
- `accountID` comes **only** from `metadata.accountID`. opencode reads JWT claims only when it
  refreshes the token itself (`openai.ts:378-387`), so ClaudeUI must send `metadata.accountID`.

**P2 — updating the token in place is impossible over HTTP.**

- `PATCH /api/credential/{id}` accepts only `{label}`: the request schema is
  `{label}`, `additionalProperties:false`, and the handler calls `update(id, {label})`
  (`server/src/handlers/credential.ts`).
- Live: `PATCH {label, value}` returned 204, the value was **ignored**, and the next turn still sent
  `Bearer A`.
- Re-POSTing the same id → **409** `ConflictError: Credential already exists`.
- (`Credential.update` with a value publishes no event (`core/src/credential.ts:205-254`). Even an
  in-process value change would not reload the plugin's cached `chatgpt` object, only the per-request
  bearer (`model-resolver.ts:366-369`).)
- **What works is rotate-by-replace:** `POST` a new id `cred_claudeui_acct111_v<n>` with
  `activate:true`, then `DELETE` the previous id.
  - Events: `credential.switched(<new>)` + reloads, then `credential.updated` (deleting an inactive
    row does not switch).
  - The next request carried `Bearer B`.
  - Rotating to a different account (`acct-222`) changed the header to `chatgpt-account-id: acct-222`.
    The `Switched` re-runs the plugin's `load()` (`openai.ts:323-328`).
  - No restart, and no gap: the old row stays until the new one is active.

**P3 — expires inside the 5-minute window with `refresh:""`: the turn fails, nothing is mutated,
and a rotation recovers it.**

- `connection.resolve` refreshes when `expires <= now+5min` (`core/src/integration.ts:696-713`). It
  POSTs `grant_type=refresh_token&refresh_token=` to `https://auth.openai.com/oauth/token`
  (`openai.ts:350-376`). The proxy logged and refused each attempt.
- The session sees `session.execution.failed {error:{type:"provider.auth", message:"Request failed: 403"}}`.
  There is no step and no model request, and no retry event.
  - With real network, auth.openai.com would reject the empty refresh token with a 4xx. The error type
    is the same; only the status changes.
- The row is **unchanged**: still active, still the same access and expires. It is not deleted and
  not deactivated, and no `credential.*` event fires.
- Activating a credential that is already inside the window (the `Switched` → `load()` path) also
  fires a refresh attempt (2 attempts during the rotate itself).
- Recovery: rotate-by-replace to a fresh token → the next turn `succeeded` with the new bearer and
  ChatGPT mode. No restart needed.
- Boot trap (P3b), proven:
  - Restarting the server while the active row is inside the window leaves the plugin's cached
    `chatgpt` unset. Its `load()` swallows the failed refresh (`openai.ts:239-247`,
    `orElseSucceed(undefined)`), so the provider falls back to plain API-key mode.
  - The first turn fails `provider.auth` (2 refresh attempts).
  - A rotate-by-replace (which publishes `Switched`) restores ChatGPT mode; the next turn succeeded on
    chatgpt.com with `chatgpt-account-id`.

**P4 — shared DB, active slot (all live):**

- User row active → ClaudeUI `POST activate:true` → ClaudeUI's row active. Events:
  `credential.updated`, `credential.switched(cred_claudeui_…)`, provider/model reloads.
- ClaudeUI `DELETE` (its row active) → the **newest remaining** row by `time_created` becomes active
  (`credential.ts` `remove`). Events: `credential.updated`, `credential.switched(<user id>)`. The next
  turn used the user's bearer and account.
- P4c: the user had row U1 (older, previously active) and U2 (newer). ClaudeUI activated, then deleted
  → **U2** became active, not U1. opencode does not remember the previously active row.
- P4b: if the user signs in again after ClaudeUI vended, `POST` defaults `activate` to true, so the
  user's new row takes the slot and ClaudeUI's row goes inactive with no other signal than
  `credential.switched`. Deleting an inactive ClaudeUI row fires only `credential.updated`.

**P5 — concurrency inside the window: no single-flight.** Two concurrent turns produced **3**
refresh attempts (each per-request `resolve` refreshes independently, plus the plugin's `load()`).
Both turns failed `provider.auth`. Harmless with `refresh:""` (nothing to rotate), but each attempt
is a real request to auth.openai.com in production.

**Side finding:** right after boot, the first `GET /api/model` returned **0** openai models (cold
location). At +1.5 s it returned 18 (`chatgpt/model-after-boot.mjs`). Discovery must not
negative-cache the first answer (the ADR-092 lesson).

#### 3b. Credential design (RECOMMENDATION, following the owner decisions)

1. **Vend.** Each ChatGPT account becomes `cred_claudeui_<account>_v<n>`:
   - `refresh:""`;
   - `expires` = the token's real expiry;
   - `metadata.accountID` set;
   - `activate:true`.

   API keys become `cred_claudeui_<provider>_v<n>` (`type:"key"`), rotated only when the key changes.

2. **Rotate = replace.** `POST` the new generation with `activate:true`, then `DELETE` the old one.
   There is no `PATCH` (P2). The vault refreshes about 15 min before expiry, which keeps every vended
   row out of opencode's 5-min window during normal operation.
3. **Sleep/wake and offline.** On resume (`powerMonitor` resume/unlock), and before dispatching any
   opencode turn, the vault checks the active ChatGPT token:
   - if it expires within 15 min, refresh and rotate first;
   - if it cannot refresh (offline), hold the turn with an auth notice rather than letting opencode
     fire empty refreshes and fail `provider.auth`.

   Map `session.execution.failed {error.type:"provider.auth"}` on an openai session to
   `auth-required` plus an immediate vault refresh and rotate. The rotation's `Switched` also heals
   the boot trap (P3b).

   Option for the owner: pad the vended `expires` (for example real + 24 h). opencode would then
   never attempt a refresh, and a really expired token fails at chatgpt.com with a 401 instead. The
   trade-off: no traffic to auth.openai.com, but the row lies about its expiry to the user's own
   opencode in the shared DB. I lean to the real expiry plus the gate above.

4. **Ownership.** ClaudeUI removes or rotates only ids starting with `cred_claudeui_`.
   - On boot it deletes stale generations of its own: every `cred_claudeui_*` except the current one
     per account. This covers a crash between POST and DELETE.
   - It never touches the user's rows.
   - The fed-token fingerprint history becomes unnecessary for opencode.
5. **Active slot (shared DB).**
   - While a ChatGPT account is connected in ClaudeUI, ClaudeUI's row is the active `openai`
     credential, as in 1.x. Every rotation re-asserts it (`activate:true`), and so does ClaudeUI boot.
   - Before first taking the slot, remember the previously active `openai` id. On disconnect,
     `DELETE` ClaudeUI's row, then `POST /activate` that remembered id if it still exists. opencode
     would otherwise pick the newest row (P4c).
   - A user sign-in that later takes the slot (P4b) is respected until ClaudeUI's next rotation or
     boot re-asserts. Log it; don't fight it live.
6. **App quit.** In a shared DB, the user's own opencode reads ClaudeUI's active row. Once ClaudeUI
   stops refreshing it, that row runs into the 5-min window and the user's opencode fails
   `provider.auth` with empty refresh attempts. On graceful quit, ClaudeUI removes its ChatGPT rows
   and restores the remembered user row. A crash leaves the row until the next ClaudeUI start.
7. `auth.json`:
   - ClaudeUI never writes it.
   - opencode imports it once into a 1.x-created DB (the user's existing sign-ins become user-owned
     rows that ClaudeUI never touches).
   - No ClaudeUI import step.

## Mapping

### 4. Permissions

**FACT:**

- Rule = `{action, resource, effect: allow|deny|ask}`, last match wins, default `ask` on `resource:"*"`
  (`permission.ts:88-97`).
- A rule with `resource:"*"` and `effect:"deny"` **removes the tool from the model's list**
  (`tool.ts` `whollyDisabled`). 1.x `opencodeWireRuleset` relies on whole-category denies staying
  visible-but-denied, so this needs re-checking.
- Per-session rules: `POST /api/session {permissions}` at create, `PATCH /api/session/:id {permissions}`
  later (204, event `session.permissions`). Live-proven. Child sessions **inherit** the parent's
  rules (live: the child `session.created.permissions` equals the parent's).
- Ask: `permission.asked {id:"per_…", sessionID, action, resources[], save[], source:{type:"tool", messageID, id:<callID>}, metadata?}`.
  Reply: `POST /api/session/:sid/permission/:rid/reply {decision: once|always|reject, message?}` → 204.
  `permission.replied {sessionID, requestID, reply}`.
- `save` carries the "always" patterns (for example `echo *`), the analogue of 1.x `always`.
  `always` persists to a project-scoped saved table (`/api/permission/saved`). ClaudeUI never sends
  `always` (ADR-085 S2), so no change there.
- Action ids (`core/src/tool/plugin/*.ts` `name`):
  - `shell` (was bash), `subagent` (was task), `edit` (covers write/patch/multiedit: `write.ts` and
    `patch.ts` declare `permission:"edit"`).
  - `read`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `question`, `external_directory`,
    `execute` (Code Mode).
  - MCP: `<server>_<tool>` sanitized with `[^a-zA-Z0-9_-]→_` (`tool/mcp.ts:16-17`).
  - `opencode_list_mcp_resources` / `opencode_read_mcp_resource`.
  - Upstream's own v1→v2 map is `write|patch→edit`, `task→subagent`, `bash→shell`
    (`core/src/v1/config/migrate.ts:29-33`).
- **Gone:**
  - `list`, `todowrite`/`todoread`: no todo tool, so ClaudeUI's `session:plan` from `todo.updated`
    has no source.
  - `doom_loop`, `lsp`, `plan_enter`/`plan_exit`, `batch`, `codesearch`, `invalid`.
- The shell `resources` are per parsed sub-command (`ShellParse.scan`), e.g. `["echo spike-tool-ran"]`.
  The host-side globbing in `broad-bash-globs.ts` and `wildcard.ts` carries over. The matching itself
  is the same `Wildcard.match`.

**RECOMMENDATION:**

- Change the compiler's output field names and its key table.
- Drop dead keys.
- Re-examine the deny-moves-to-end logic against "wholly denied ⇒ tool hidden".
- Plan mode maps to agent `plan`. Upstream's plan agent denies `edit` except a plan dir and allows
  `question`.

### 5. Events → ClaudeUI's engine-neutral stream

**FACT:**

- SSE `GET /api/event`. Each `data:` is `{id, created, type, location:{directory}, data, durable?:{aggregateID, seq, version}}`.
- The payload is under `data`. 1.x used `properties`.
- One feed carries every location and session the server knows (live: ws and ws2 events on one stream).
- There is no `Last-Event-ID` replay (no handler reads it). Text and reasoning deltas, `usage.updated`,
  `tool.progress` and `permission.*` are **ephemeral**; lifecycle and tool start/end events are
  durable. A reconnect must therefore re-read state, as 1.x did:
  - `GET /message`;
  - `GET /api/session/:id/permission`, `/form`, `/inbox`;
  - `GET /api/session/active`.

| 2.x event                                                                                                                                                   | ClaudeUI output (`dispatchMapperOutput`)                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `session.text.started/delta/ended`                                                                                                                          | `stream` text → `item-open/delta/seal`, then `message` (text block)                                                                |
| `session.reasoning.started/delta/ended`                                                                                                                     | `stream` thinking (not driven: fixture)                                                                                            |
| `session.tool.input.started/delta/ended`                                                                                                                    | optional live tool-input streaming (new capability)                                                                                |
| `session.tool.called {id, input}`                                                                                                                           | `message` tool_use                                                                                                                 |
| `session.tool.progress {metadata}`                                                                                                                          | bash live output (`bash-stream-gate`); for `subagent`, `metadata.sessionID` registers the child                                    |
| `session.tool.success {content, metadata}` / `failed {error:{type,message}}`                                                                                | `tool_result` (error flag; `permission.rejected` → PermissionDenialBlock)                                                          |
| `session.step.ended {cost, tokens{input,output,reasoning,cache{read,write}}, finish}`                                                                       | per-step metering; `cost_update`                                                                                                   |
| `session.usage.updated {cost, tokens}` (session cumulative)                                                                                                 | `cost_update` / status line                                                                                                        |
| `session.execution.succeeded / failed / interrupted`                                                                                                        | `result` / `error` / user-stop (ADR-090: interrupted is not an error)                                                              |
| `session.retry.scheduled`                                                                                                                                   | retry notice                                                                                                                       |
| `session.compaction.started/delta/ended/failed`, `session.compacted`                                                                                        | `compact_separator`                                                                                                                |
| `permission.asked / replied`                                                                                                                                | `approval` / `approval-resolved`                                                                                                   |
| `form.created {form:{id, fields[{key,title,description,type,options,custom}], metadata:{kind:"question", tool:{messageID,id}}}}` / `form.replied/cancelled` | AskUserQuestion approval; reply `{answer:{q0:"…"}}` (a string for a single choice: an array was rejected `FormInvalidAnswerError`) |
| `session.inbox.enqueued / delivered / delivery.changed / cancelled`                                                                                         | queue rows with stable ids (ADR-053)                                                                                               |
| `session.created {parentID}`                                                                                                                                | child-session registration (subagents)                                                                                             |
| `session.renamed`                                                                                                                                           | title                                                                                                                              |
| `todo.updated`                                                                                                                                              | **no 2.x source**: the plan panel stays empty for opencode                                                                         |

- Usage and cost: tokens stay disjoint, with the same fields as 1.x. Cost is computed by opencode
  from config/models.dev cost (live 0.00018 for 120 in / 30 out at $1/$2 per M). Per-message
  `cost`/`tokens` sit on assistant history rows, so the `opencodeHistorySeed` logic ports almost 1:1.
- Cold history: `GET /api/session/:id/message` (paginated, `limit/order/cursor/type`). Rows are typed:
  - `user {text, files?}`;
  - `assistant {agent, model, content:[text|reasoning|tool{id,name,state{status,input,content,metadata}}], cost, tokens, finish}`;
  - `idle {outcome: succeeded|interrupted|…}`;
  - plus `synthetic`, `agent-switched`, `model-switched`, `compaction`, `shell`.
    The list was identical across a process restart.
- Subagents: the `subagent` tool creates a child session (`parentID`) whose events arrive on the same
  feed. The parent's tool content is `<subagent sessionID=… state="completed">…</subagent>`. The child
  is discoverable via `GET /api/session?parentID=`.
- `GET /api/session` is **global**: the `x-opencode-directory` header did not filter it (live: the ws2
  session appeared under ws). Filter with `?directory=`.

### 6. Config

**FACT:**

- `OPENCODE_CONFIG_CONTENT` is still honoured (`cli/src/server-process.ts:118`, `core/src/config.ts:210`).
- v1-shaped keys are normalized in memory with diagnostics (`normalize.ts`).
- Native keys:
  - `providers` (with `settings`, `headers`, `body`, `models{capabilities{tools,input,output}, variants[], cost, limit, disabled}`);
  - `agents` (`model, request{body}, system, description, mode, hidden, color, steps, disabled, permissions`);
  - `permissions`, `plugins`, `mcp:{timeout, servers}`, `commands`, `skills`, `instructions`,
    `references`, `media`, `compaction`, `experimental`.
- Unsupported legacy keys (dropped): top-level `logLevel/server/subagent_depth/layout`;
  `experimental.continue_loop_on_deny` and others; provider `id/whitelist/blacklist`;
  **model `attachment/reasoning/temperature/experimental/release_date`**.

**Replacements:**

- ADR-031 per-model `attachment` → `capabilities.input`.
- `temperature` → `body.temperature` (model, variant or agent `request.body`). This is how upstream
  migrates agent temperature (`v1/config/migrate.ts:37-41`).
- `reasoning` has no boolean. Reasoning is expressed through `variants[]` overlays.
- Agent CRUD (ADR-029) moves to `agents.<id>` with `system` (was `prompt`), `permissions` (was
  `permission`, now a rule array), `request.body` and `disabled` (was `disable`).
- Config writes: there is no general config-mutation API. `PATCH /api/experimental/config` accepts
  only `shell` (audit 024a). ClaudeUI keeps writing files (leaf-merge, ADR-031) and calls
  `POST /api/location/reload`. Watchers exist (`config/watch.ts`).
- The raw editor schema: 2.x publishes `https://opencode.ai/v2/cli.json` for the CLI config. The
  runtime config schema is in `openapi.json` `Config.InfoEncoded`. Generate the snapshot from that.

**RECOMMENDATION:**

- Build `OPENCODE_CONFIG_CONTENT` in native v2 shape only: `mcp.servers` with `codemode:false` for
  `claudeui` and the bridged servers, `plugins:[dir]`, `agents.<n>.permissions`.
- Stop injecting `continue_loop_on_deny` and `autoupdate`. Use `OPENCODE_DISABLE_AUTOUPDATE=1`
  (`services/updater.ts:456`).
- The user's own `opencode.json` stays readable because of v1 normalization, but ClaudeUI's
  **writers** must write v2 keys. Otherwise every save writes keys 2.x drops.

### 7. Server lifecycle

**FACT:**

- `serve` prints `server listening on <url>`. `serve --stdio` prints one JSON line `{"url":…}`,
  deletes `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` from its own env so tools cannot see them,
  and exits when stdin closes (`server-process.ts:78-81, 174-180`).
- Live: the stdin close gave exit code 0 within ~1 s. Upstream's own TUI spawns its server exactly
  this way (`cli/src/services/standalone.ts:20`, "EOF on this pipe as the end of its ownership lease").
- Basic auth: user `opencode`, password `OPENCODE_PASSWORD` (legacy `OPENCODE_SERVER_PASSWORD`). If
  neither is set, a random one is printed to stdout in default mode.
- One server serves every directory. `location` comes from the body or the `x-opencode-directory`
  header. Live: a ws2 session ran on the ws-cwd server.
- `--service` is a shared, registered background daemon with persisted config. Avoid it: its
  lifetime and password are outside ClaudeUI's control.
- Env visible to a shell tool (live): `OPENCODE_CONFIG_CONTENT`, `OPENCODE_SESSION_ID`, and the
  disable flags. **The config content leaks to tools.** It contains the MCP bearer token, the same as
  1.x.

**RECOMMENDATION:**

- Spawn `serve --stdio --port 0`, parse the first JSON line, and pass the password via env.
- Keep ADR-019's pool keying, but by config identity, not cwd. One server per distinct
  `OPENCODE_CONFIG_CONTENT`, which in practice means one per app. Fall back to per-cwd only if a
  per-cwd injection reappears. This removes the "starts take turns" migration race (one DB writer
  process).
- Move the MCP bearer token out of config content if feasible. Otherwise accept the risk as in 1.x.

### 8. Steer, queue, interrupt (ADR-024 / ADR-053)

**FACT (live):**

- `POST /prompt {text, delivery:"steer"|"queue", id?, resume?}` returns the inbox item
  (`{id:"msg_…", delivery}`).
- During a streaming `[slow]` turn, a steer and two queued items were posted, then
  `DELETE /api/session/:id/inbox/:qid` → 204 and `session.inbox.cancelled`.
- Delivery order observed at the model:
  - req#5 had `[slow]` + STEER;
  - req#6 had `[slow]`, STEER, QUEUED;
  - the cancelled item never appeared.
- `PATCH /inbox/:id {delivery}` promotes queue↔steer. A client-supplied `id` makes the prompt
  idempotent (`specs/v2/session.md:7-9`).
- Interrupt: `POST /interrupt` → `{interrupted:true}` → `session.execution.interrupted`. The partial
  assistant text is persisted and an `idle {outcome:"interrupted"}` row is written.
  `?resume=true` exists.

**RECOMMENDATION:**

- Map ClaudeUI's queue item id to the inbox id (client-chosen `id`). That gives true dequeue and edit,
  closing the ADR-024/053 "no dequeue" gap.
- Steer maps to `delivery:"steer"`.
- **OWNER DECISION (2026-10-06):** use opencode's native inbox and retire ADR-053's host-held queue
  for opencode:
  - queue rows are inbox items with ClaudeUI-chosen ids;
  - dequeue = `DELETE /inbox/:id`;
  - steer/queue toggle = `PATCH /inbox/:id {delivery}`;
  - the UI renders from `session.inbox.*` events.

### 9. Data dir

**FACT:**

- DB = `$XDG_DATA_HOME/opencode/opencode.db` (or `OPENCODE_DB`; channel-suffixed for non-stable
  channels, `cli/src/database-path.ts`). WAL, `busy_timeout=5000`.
- An in-process bootstrap lock exists per path (`core/src/database/database.ts:40-62`). There is no
  cross-process lock.
- A fresh 2.x DB has **only `session_v2`, no `session` table**. ClaudeUI's
  `opencode-session-list.ts` / `db.ts:1574` (`SELECT … FROM session`) breaks on it.
- A 1.x-created DB keeps `session` and gains `session_v2`. 2.x copies v1 sessions in
  (`database/v1-migration.bun.ts`; live `migration/v1: completed`).
- Upstream #52395 shows cross-line seq collisions when continuing a v1 session.

**OWNER DECISION (2026-10-06): share the user's opencode data dir.**

- The spike's original recommendation was to isolate it. That is superseded.
- ClaudeUI spawns 2.x with the default `XDG_DATA_HOME`, so sessions and the user's own sign-ins are
  shared, as in 1.x.

What this requires:

- **Credentials:** ownership by id prefix plus the active-slot rules in §3b.
- **Concurrent writers:** a user-run opencode (TUI standalone server, or the `--service` daemon) and
  ClaudeUI's server can both have the DB open.
  - There is WAL plus `busy_timeout=5000`, but no cross-process lock.
  - Bus events are per process. ClaudeUI's credential rotation is visible to the user's server only
    through the per-request DB read (bearer), not through `credential.switched`. So a different
    `chatgpt-account-id` would not reach the user's already-running server until its own next
    `Switched`.
  - Acceptable for one account. Note it for account switches.
- **Migration on first 2.x start:** if the user's DB is 1.x-created, 2.x migrates it in place: it
  adds `session_v2`, copies v1 sessions (`migration/v1`), and imports `auth.json` once. A rolled-back
  1.x ClaudeUI keeps working on the same file: the 1.x runner skips unknown migrations, and the
  prior research flagged cross-version semantics as unverified (#52395).
- Do **not** set `XDG_CONFIG_HOME`. ClaudeUI wants the user's global `opencode.json` and agents
  (ADR-028). Keep `HOME` real for tools.

Replace the direct SQLite read with `GET /api/session?directory=…&parentID=null` (paginated).

### 10. API churn and cadence

**FACT** (script `.cache/opencode-v2-spike/churn/diff.py`; operations compared on fully dereferenced
request and response schemas):

- 25 releases, 2026-09-11 → 2026-10-06. That is about one per day; many are bit-identical in API.
- Operations: 139 at v2.0.0 → **141** at v2.0.23.
- **v2.0.3 → v2.0.4 was the audit cut** (`V2_HTTP_API_AUDIT.md`): +22 / −28 operations, 102 changed.
  For example `/api/mcp/*`, `/session/import`, `/generate` and `instructions` moved under
  `/experimental`; `health`/`server`/`project/current` were removed.
- **Since v2.0.4 (19 releases):** +8 / −1 operations, 42 operation-changes. 13 of those touch
  response fields or params. All changes:
  - v2.0.6: `GET /api/status` → `/api/info`; `POST /api/location/reload` added.
  - v2.0.7: `POST /api/experimental/fs/write` added.
  - v2.0.9: provider/model `compaction` and `transport` fields reshaped (response).
  - v2.0.21: optional `?message` query added to form reply. v2.0.23: removed again.
  - v2.0.23: credential list and create, `/api/pair`, `/auth/connect/{code}`, `/api/vcs/init`
    added; the `chunkTimeout` type was widened.
  - Releases with zero API change: 2.0.5, 8, 10–12, 14, 16–20, 22, 24.
- Session event vocabulary: 50 → 51 types. `session.permissions.updated` was renamed to
  `session.permissions` at 2.0.4, and `session.metadata.updated` was added at 2.0.16.
  `git diff v2.0.4 v2.0.23 -- schema/src/{session-event,permission,form,session-message}.ts`
  = +18 / −4 lines.
- `info.description` is still "Experimental HttpApi surface for selected instance routes" and the
  version is `0.0.1`. It has not changed since 2.0.0.

**Reading:** after the audit cut, the parts ClaudeUI uses (session, prompt, inbox, permission, form,
event, credential, message) changed only additively, except the form-reply `message` flip-flop.
Expect a pin bump every 1–2 weeks with a mechanical generated-types diff.

**RECOMMENDATION:**

- Generate types from the pinned `openapi.json` and fail CI on a diff.
- Run a contract test per bump: the spike driver adapted as an integration test.
- Keep `@opencode/cli` floor = tested (ADR-082 2026-10-06 amendment) and ceiling `3.0.0`.

## Upsides confirmed

- **Inbox dequeue, idempotent prompt ids, promote/demote:** live (Q8).
- **`--stdio` lease:** live (exit 0 on stdin EOF; password scrubbed from the child env).
- **Single server, many directories:** live (Q7).
- **Hot credential changes without a recycle:** live (blocker 3).
- **Native MCP caller identity** (`_meta`): live (blocker 2).
- **Generated types:**
  - The repo has no OpenAPI→TS tool and I added no dependency. A 60-line zero-dependency generator
    (`.cache/opencode-v2-spike/gen/openapi-to-ts.mjs`) turns `openapi.json` into
    `gen/opencode-v2.gen.ts`: 2,207 lines, 255 schema types plus an `Operations` map. It passes
    `tsc --strict`.
  - The SSE payload is typed as `V2EventEncoded`, so event types can be generated too.
  - Recommended home: `scripts/generate-opencode-protocol.mjs`, mirroring
    `generate-codex-protocol.mjs`. Output goes to `src/core/opencode/protocol/` with a provenance
    file. Upstream's `@opencode/client` / `@opencode/sdk` are an alternative, but adopting them is a
    new runtime dependency (supply-chain review).

## Top risks

1. **Churn under an "Experimental" label.** Mitigation: generated types, an exact pin, and a contract
   test per bump. The post-audit churn is small (above).
2. **Plugin loading fails silently.** A file path or a broken plugin only logs a warning. Use
   `_meta` session identity as the primary signal so the worst case is "no live streaming".
3. **Messageless reject = hard stop.** Every reject path, including auto-mode/judge (`autoReply`),
   must carry a message.
4. **Wholly-denied tools disappear from the model's view.** This changes the semantics of ClaudeUI's
   "deny category" rules. Re-test ADR-022/085 behaviours.
5. **Lost features:**
   - `todo.updated` (no todo tool in 2.x).
   - Per-model `reasoning` boolean and `temperature` keys (they move to variants/body).
   - The `doom_loop` ask.
6. **Shared DB plus access-token-only credentials** (§3a/§3b):
   - every token rotation is a replace (no value PATCH over HTTP);
   - a turn inside opencode's 5-min refresh window fails `provider.auth` and sends empty refresh
     requests to auth.openai.com;
   - a server booted inside that window drops out of ChatGPT mode until the next `Switched`;
   - a quit ClaudeUI leaves the user's opencode holding a token nobody refreshes.

   All are handled by the §3b vault rules, which slice S7 must test.

7. **Upstream v2 instability** (prior research):
   - #53184: replayed side-effectful tool calls on failed turns (closed);
   - #52908: location-idle eviction strands background shells;
   - #52395: v1-session continuation.
8. **Not verified:**
   - ChatGPT vending against the real backend (the probe used fake JWTs and a localhost
     redirect; real chatgpt.com error shapes are unknown);
   - Windows (`--stdio` pipe semantics, Git Bash shell selection);
   - reasoning streams;
   - compaction;
   - SSE reconnect after a server stall.
