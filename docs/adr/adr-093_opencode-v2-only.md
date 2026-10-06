# ADR-093: opencode moves to 2.x only

**Status:** Accepted (2026-10-06, owner; arc started with S0). It comes from the spike in
[`docs/opencode-v2-spike.md`](../opencode-v2-spike.md), which has the evidence, citations and live
transcripts this ADR relies on. **Owner decisions recorded 2026-10-06** (Daniel):

- ChatGPT is vended as an access token only;
- the data dir is shared with the user's opencode;
- the native inbox replaces the ADR-053 host queue for opencode;
- there is no separate sign-in import.

They are folded into §5, §6, §9 and the slices.
**Supersedes** (for opencode, when the arc lands at S10):

- ADR-032 §non-fatal denials mechanism (`continue_loop_on_deny`).
- ADR-024 opencode queue semantics (no dequeue).
- [ADR-053](adr-053_queue-item-identity-cc-parity.md)'s host-held queue **for opencode**. The owner
  decided on 2026-10-06 to use opencode's native inbox (§9). ADR-053 stays in force for the other
  engines.

**Amends** (when the arc lands at S10):

- [ADR-019](adr-019_opencode-engine-backend.md) (server pool, spawn, wire).
- [ADR-022](adr-022_opencode-permission-mapping.md) (rule shape, tool ids).
- [ADR-029](adr-029_opencode-custom-agent-crud.md) and [ADR-031](adr-031_opencode-config-leaf-merge-writes.md)
  (v2 config keys).
- [ADR-033](adr-033_cross-engine-dispatch.md) (caller identity).
- [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) and
  [ADR-021](adr-021_neutral-auth-account-model.md) (where opencode credentials live).
- [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) (manifest coordinates, ceiling).

**Relates to:** [ADR-028](adr-028_opencode-native-config-in-place.md),
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md),
[ADR-090](adr-090_user-stop-is-not-an-error.md),
[ADR-092](adr-092_model-catalogs-per-engine-and-a-clean-boot.md) (stdin-ended engine processes).

## Context

Upstream builds new work only on the 2.x line: npm `@opencode/cli`, branch `v2`, 25 releases between
2026-09-11 and 2026-10-06. 1.x (`opencode-ai`) gets provider fixes only. It has no published EOL,
so it can stop without notice. A System `opencode` is increasingly 2.x (Homebrew core, upstream
install links), and ClaudeUI marks it `incompatible`.

2.x is not wire-compatible with 1.x:

- Every route moved under `/api/*`.
- The SSE vocabulary is replaced.
- Permissions are `{action, resource, effect}` with renamed tools.
- Credentials moved from `auth.json` into the DB.
- v1 plugins do not run.
- The listen line changed.

The owner wants 2.x **only**: floor 2.0.x, ceiling 3.0.0, no dual stack.

The spike asked whether the three capabilities ClaudeUI cannot give up survive. All three do, and
each was proven live against 2.0.23 with a localhost fixture model:

1. **Non-fatal denial.** `reply {decision:"reject", message}` fails the tool with
   `permission.rejected` + message. The model receives it as the tool result and the turn continues.
   A deny rule behaves the same. A reject **without** a message ends the turn.
2. **Caller identity.** opencode puts `_meta["ai.opencode/sessionID"]` on every MCP `tools/call`.
   A 12-line v2 plugin (`tool.hook("execute.before")`, mutable `event.input`) also stamps
   `__xeng_caller_session` and `__xeng_call_id` into the args that reach the MCP server.
3. **Owned credentials.** `POST /api/credential {id, integrationID, label, value}` accepts a
   caller-chosen id and applies without a restart. `DELETE /api/credential/{id}` removes it.

## Decision

Proposed: **GO**, on the conditions in §8.

### 1. Package, manifest and installer (amends ADR-082)

- The manifest `id` stays `opencode`. `tested` = `floor` = the pinned 2.0.x (2.0.23 or 2.0.24 at
  cut-over; the API is identical). `ceiling` = `3.0.0`.
- Platform packages: `@opencode/cli-<plat>` (`darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`, `windows-x64`, plus `-baseline`/`-musl` variants not used today). This replaces
  `opencode-<plat>`.
- The tarball member is still `package/bin/opencode[.exe]`. Integrity and binary SHA-256 are reviewed
  per platform, as today.
- Provenance at 2.0.23: `repository` anomalyco/opencode; maintainer `thdxr`; published by GitHub
  Actions OIDC; darwin binary signed `Developer ID Application: Anomaly Innovations, Inc. (5NZ4Q7NXJ4)`.
- Upstream version listing reads `@opencode/cli-<plat>`. Detection must parse `opencode v2.0.23`
  (leading `v`). `candidates.ts` already lists `@opencode/cli`. Also probe the `opencode2` bin name.
- A System 1.x becomes **too old** (below the floor), which is the ADR-082 outcome for that case.

### 2. Server lifecycle (amends ADR-019)

- Spawn `opencode serve --stdio --port 0`.
- Read the first stdout line as JSON `{url}`. This replaces `PORT_PATTERN`.
- Pass the password via `OPENCODE_PASSWORD` (Basic `opencode:<pw>`). `--stdio` scrubs it from the
  child env, so tools cannot read it.
- Ending the process = closing stdin, the same pattern as pi (ADR-092). A kill stays only as the
  timeout fallback.
- Never use `--service`.
- **One server per distinct config injection**, not per cwd. The working directory travels per
  request (`x-opencode-directory` / `location.directory`). That makes one long-lived server per app,
  plus private detached servers where ADR-019 needed them (side questions, agent generation).
- Env: `OPENCODE_DISABLE_AUTOUPDATE=1` and `OPENCODE_CONFIG_CONTENT`. XDG dirs are left at the user's
  defaults: shared data dir, §6.

**As built (S2, 2026-10-06).**

- `opencode serve --stdio --hostname 127.0.0.1 --port 0`; only a loopback `{url}` is accepted. The
  password goes in `OPENCODE_PASSWORD` (2.x deletes it from its own env in stdio mode), plus
  `OPENCODE_DISABLE_AUTOUPDATE=1`; no XDG or HOME override (shared data dir, §6). Shutdown closes
  stdin and tree-kills only after 5 s.
- One server per CONFIG, not per cwd: keyed by a digest of what is injected (bridged MCP, plugin
  dir, agent-permission overlay). A config change starts a new server for new leases; the old one
  ends at its last release. `releaseIfCurrent` releases exactly; `release(cwd)` the newest holder.
- MCP readiness is per (server, directory): 2.x connects MCP per directory and registers its tools
  about 100 ms after "connected", with no public event. The production plugin exposes an RPC
  (`POST /api/rpc/claudeui-xeng/tools`) listing the registered `claudeui_*` tools; `acquire` waits
  (10 s cap, logged, never throws) until `claudeui_dispatch_agent` is there. Fallback: `GET
/api/mcp` connected plus 400 ms. Callers that run no turn pass `waitForHostedTools:false`.
- The hosted MCP host is multi-session (one transport per MCP session), since one server serves
  every directory; mockup tools resolve their directory per call from the calling session.

### 3. Permissions (amends ADR-022; supersedes the ADR-032 mechanism)

- Rules compile to `{action, resource, effect}`. Key table:
  - `bash→shell`, `task→subagent`;
  - `write/patch/apply_patch/multiedit→edit`;
  - `read/glob/grep/webfetch/websearch/skill/question/external_directory` unchanged;
  - `execute` (Code Mode);
  - MCP `<server>_<tool>`.
- Dead keys are dropped: `list`, `todowrite`, `todoread`, `doom_loop`, `lsp`, `plan_*`, `batch`,
  `codesearch`, `invalid`.
- Per-session rules: `permissions` on `POST /api/session` and `PATCH /api/session/:id`. Children
  inherit the parent's rules.
- **Invariant: every reject carries a non-empty message.** That includes host-decided and judge
  (auto-mode) rejects. A messageless reject is a hard stop in 2.x. A unit test pins it.
- `experimental.continue_loop_on_deny` is no longer injected.
- A `resource:"*"` + `deny` rule hides the tool from the model. The `opencodeWireRuleset`
  "whole-category deny goes last" transform must be re-verified against that rule.

### 4. Caller identity (amends ADR-033)

- Primary signal: the dispatcher reads the caller session from the MCP request
  `_meta["ai.opencode/sessionID"]`.
- The `claudeui-xeng` plugin is rewritten as a **directory** plugin
  (`resources/opencode/claudeui-xeng/{index.js,package.json}`). 2.x refuses a plugin path that is a
  file, and only logs a warning. It default-exports `{id, setup(ctx)}` and stamps
  `__xeng_caller_session` and `__xeng_call_id` from `execute.before`.
- If the call id is missing, dispatch still works (no live streaming), as today.
- The `claudeui` MCP server and the bridged servers are injected as
  `mcp.servers.<name> = {type, url, headers, codemode:false}`. Without `codemode:false`, opencode
  hides MCP tools behind its Code Mode `execute` tool, and the call id becomes the `execute` call's id.

**As built (S2).** `_meta["ai.opencode/sessionID"]` always wins: the engine sets it outside
anything the model or a plugin controls. The plugin's `__xeng_caller_session` stamp is the fallback
for a request without `_meta`. The plugin's `__xeng_call_id` (which keys live streaming to the tool
card) is trusted only when the same call carries the plugin's session stamp and it agrees with
`_meta`, so a lone or disagreeing call id cannot redirect a dispatch. The plugin is an import-free
directory (`resources/opencode/claudeui-xeng/`), unpacked from the asar like the 1.x plugin.

### 5. Credentials (amends ADR-068 / ADR-021; ownership per ADR-082 §8)

ClaudeUI manages every credential and vends it to opencode (owner decision). Evidence:
spike §3a, from a live run of 2.0.23 under `sandbox-exec` (loopback only) behind a refusing proxy,
with fake JWTs.

**Shapes**

- Keys: `cred_claudeui_<provider>_v<n>`, `{type:"key", key}`.
- ChatGPT: `cred_claudeui_<account>_v<n>`,
  `{type:"oauth", methodID:"chatgpt-browser", refresh:"", access, expires:<real expiry + 24 h>, metadata:{accountID}}`,
  `activate:true`, label `claudeui:<source>`.
- `metadata.accountID` is mandatory. opencode takes the `chatgpt-account-id` header only from it
  (it reads JWT claims only when it refreshes the token itself).
- Access-only is accepted. ChatGPT mode follows: the chatgpt.com codex baseURL, the account header,
  the eligible-model filter, and `cost:[]`.

**Rotation = replace, never PATCH**

- `PATCH /api/credential/{id}` accepts only `{label}`. A value in the body is silently ignored.
- Re-POSTing an existing id is a 409.
- So ClaudeUI rotates with `POST` of the next generation (`activate:true`), then `DELETE` of the
  previous one:
  - no gap;
  - one `credential.switched`, which also reloads the openai plugin's cached ChatGPT state (account
    header, mode);
  - the next request carries the new bearer;
  - no restart.
- The vault refreshes about 15 min before expiry. opencode itself refreshes at `expires <= now+5min`.

**Inside opencode's 5-min window with `refresh:""` (failure mode)**

- opencode POSTs an empty refresh to `auth.openai.com`.
- The turn fails as `session.execution.failed {error:{type:"provider.auth"}}`.
- The row is left unchanged (not deleted, not deactivated, no event).
- There is no single-flight: 2 concurrent turns made 3 attempts.
- A rotation recovers without a restart.
- A server booted inside the window falls out of ChatGPT mode until the next `Switched`, which a
  rotation provides.

**What the vault must do**

1. Refresh and rotate on a ≥15-min lead.
2. On system resume or unlock, and as a gate before dispatching any opencode turn, ensure the active
   ChatGPT row expires more than 15 min out. If it does not, refresh and rotate first. If refreshing
   fails (offline), hold the turn with an auth notice instead of sending it.
3. Map `provider.auth` on an openai session to `auth-required` plus an immediate refresh and rotate.
4. On boot, delete stale generations of its own (every `cred_claudeui_*` but the current one per
   account; this covers a crash between POST and DELETE), and re-assert the active slot.

**Padded expiry (owner decision 2026-10-06).** The vended `expires` is the token's real expiry
plus 24 h, so opencode's own `expires <= now+5min` check never fires and it never sends the empty
refresh token to auth.openai.com: not after sleep, not on a missed gate, not from concurrent turns,
and a server booted near the real expiry keeps ChatGPT mode. The vault schedules from the REAL
expiry (it decodes it from the access token, never from the row). A token that really expires is
rejected by chatgpt.com, which reaches ClaudeUI as a failed turn and takes rule 3's refresh and
rotate path; S7 confirms that an expired bearer surfaces as `provider.auth`, and maps whatever it
does surface as. The pre-turn gate (rule 2) stays, as an optimisation rather than what correctness
rests on. The cost: the user's own opencode, if it ever runs on ClaudeUI's row (only after a crash,
since quit restores their credential), sees a later expiry than the real one.

**Ownership and active slot (shared DB)**

- ClaudeUI deletes or rotates **only** `cred_claudeui_*` ids. User rows, including those opencode
  imported once from `auth.json`, are never touched.
- `fed-token-history` fingerprints are retired for opencode.
- While a ChatGPT account is connected in ClaudeUI, ClaudeUI's row is the active `openai` credential,
  as in 1.x. Rotation and boot re-assert it with `activate:true`.
- opencode's `DELETE`-of-active promotes the **newest** remaining row, not the previously active one.
  So ClaudeUI records the previously active `openai` id when it first takes the slot. On disconnect,
  and on graceful quit, it `DELETE`s its rows and re-`activate`s that id if it still exists.
  - On quit, the user's own opencode would otherwise keep a token nobody refreshes. It would then
    fail `provider.auth` after at most about 1 h.
- A user sign-in that takes the slot later is respected until ClaudeUI's next rotation or boot. It is
  logged, not fought live.

**Other**

- ClaudeUI never writes `auth.json` and has no import step. opencode's own one-shot migration imports
  `auth.json` into a 1.x-created DB as user rows.
- No `recycleAll()` after an auth change: 2.x hot-reloads.
- `GET /api/credential` returns secrets to the password holder only. The password is scrubbed from
  the engine's tools.

### 6. Data dir (owner decision: shared)

- ClaudeUI spawns 2.x on the user's default data dir: shared DB and sessions, as in 1.x. Config stays
  the user's (ADR-028).
- On first 2.x start, a 1.x-created DB is migrated in place: `session_v2`, the v1 session copy, and
  the one-shot `auth.json` import.
- Concurrent writers (a user's TUI or `--service` server) are allowed: WAL plus
  `busy_timeout=5000`, no cross-process lock.
- Bus events are per process. A credential rotation reaches another running opencode process only
  through its per-request DB read (bearer). An account change reaches it only after its own next
  `Switched`.
- The session list moves from a direct SQLite `SELECT … FROM session` to
  `GET /api/session?directory=…&parentID=null`. A DB created fresh by 2.x has only `session_v2`.
- The first `/api/model` after a server boot can be empty (cold location; full at +1.5 s), so
  discovery must not negative-cache it (ADR-092).

### 7. Wire layer

- Types are generated from the pinned `packages/protocol/openapi.json` by a repo script
  (`scripts/generate-opencode-protocol.mjs`, no new dependency; the spike prototype passes
  `tsc --strict`).
- The generated file is committed with provenance (tag and spec SHA). CI fails on drift.
- No `@opencode/client` dependency.

### 8. Conditions on the GO

1. Each pin bump runs the contract integration suite: the spike driver turned into
   `src/integration/opencode/*` (fixture provider, deny+message, steer/queue/cancel, interrupt,
   subagent, form, MCP identity, credential CRUD, cold history).
2. A Windows run of the lifecycle and shell slices passes before release.
3. The §5 vault rules ship with tests: lead-time rotation, the resume/pre-turn gate,
   `provider.auth` → auth-required plus rotate, boot cleanup, active-slot restore. A
   real-token smoke check against chatgpt.com passes before release, otherwise opencode ChatGPT
   vending ships disabled.

### 9. Queue (owner decision: native inbox)

- opencode's inbox replaces ADR-053's host-held queue for opencode sessions:
  - queue items are inbox items with ClaudeUI-chosen ids (idempotent `POST /prompt {id, delivery}`);
  - dequeue = `DELETE /api/session/:id/inbox/:inboxID`;
  - steer↔queue = `PATCH …/inbox/:inboxID {delivery}`;
  - the queue UI renders from `session.inbox.enqueued/delivered/delivery.changed/cancelled`.
- Proven live: steer, two queued items and a cancel, delivered in order; the cancelled item never
  reached the model.
- Other engines keep ADR-053.

## Migration slices (order, rough size)

The estimates assume the ADR-026 loop with one implementer and orchestrator review.

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Size  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| S0  | Protocol codegen script + generated types + a contract-test harness (fixture provider, the spike driver as an integration suite)                                                                                                                                                                                                                                                                                                                                                                                 | 2–3 d |
| S1  | Harness: manifest → `@opencode/cli-*` 2.0.x, floor = tested, ceiling 3.0.0; version parse `v`; installer/upstream listing; `opencode2` candidate                                                                                                                                                                                                                                                                                                                                                                 | 1–2 d |
| S2  | Server manager: `--stdio` spawn/JSON url/stdin-close shutdown, shared data dir (no XDG override), single server keyed by config, v2 `OPENCODE_CONFIG_CONTENT` builder (`mcp.servers`+`codemode:false`, `plugins`, `agents.*.permissions`), directory plugin                                                                                                                                                                                                                                                      | 3–4 d |
| S3  | Client rewrite on generated types (session create/get/list/delete, prompt+inbox, interrupt, permission/form reply, message list, agents, commands, skills, mcp, models/providers, credentials, event SSE)                                                                                                                                                                                                                                                                                                        | 3–4 d |
| S4  | Event mapper rewrite (text/reasoning/tool/step/usage/execution/permission/form/inbox/compaction/retry; child sessions via `session.created.parentID` + `tool.progress.metadata.sessionID`; reconnect = re-read state) + cold-history converter + cost seed                                                                                                                                                                                                                                                       | 5–7 d |
| S5  | OpencodeSession: inbox-backed steer/queue with stable ids and dequeue (retire the ADR-053 host-held queue for opencode, §9), interrupt (ADR-090), approvals incl. auto-mode with mandatory reject message, forms → AskUserQuestion, plan agent, side-question/agent-generate on the new API                                                                                                                                                                                                                      | 5–7 d |
| S6  | Permission compiler/ruleset/subagent-permissions: v2 rule shape + key table + wholly-denied semantics; ADR-022/085 regression pass                                                                                                                                                                                                                                                                                                                                                                               | 2–3 d |
| S7  | Credentials (§5): CredentialSync/OpencodeAuthProvider/shared-provider adapter → `/api/credential` with `cred_claudeui_*` generations; ChatGPT access-only vending, rotate-by-replace, the resume/pre-turn gate, `provider.auth` → auth-required plus rotate, boot cleanup, active-slot remember/restore, quit cleanup; provider/model discovery → `/api/provider`, `/api/model` (no negative cache of a cold-boot empty list), `/api/integration`; drop the `auth.json` writer, fingerprints and recycle-on-auth | 5–7 d |
| S8  | Config: native-config editor and agent CRUD on v2 keys (`agents`, `system`, `permissions`, `request.body`, `capabilities.input`, variants), schema snapshot from `Config.InfoEncoded`, leaf-merge writers emit v2 keys, `POST /api/location/reload`                                                                                                                                                                                                                                                              | 4–5 d |
| S9  | Cross-engine dispatcher's structural opencode client + `_meta` identity; opencode session list via API; docs (`docs/protocol-opencode/`), architecture doc, ADR status updates                                                                                                                                                                                                                                                                                                                                   | 2–3 d |
| S10 | Real-app verification (verifier-electron), Windows pass, then remove 1.x code paths                                                                                                                                                                                                                                                                                                                                                                                                                              | 2–3 d |

Total: about 34–48 working days, roughly 7–10 weeks. The order is S0 → S1 → S2 → S3 → (S4 ∥ S6)
→ S5 → S7 → S8 → S9 → S10.

The work ships as one arc on a branch. Nothing reaches `main` until S10, because a half-ported
adapter cannot run either line.

## Rollback

- Until S10 merges, `main` keeps 1.18.x and the arc lives on a branch.
- After the merge, rollback means reverting the arc's merge commit. That restores the 1.x manifest,
  adapter and `auth.json` writer.
- The data dir is shared, so by then the user's DB has been migrated by 2.x (`session_v2` added).
  - The 1.x runner skips unknown migrations and keeps booting.
  - Sessions created under 2.x live in `session_v2` and are invisible to 1.x.
  - Cross-version semantics are unverified (upstream #52395).
  - ClaudeUI's `cred_claudeui_*` rows are inert for 1.x, which reads `auth.json`.
- Before release, test a hermetic 2.x → 1.x reopen of a migrated DB, the reverse of the spike's
  1.x → 2.x probe.
- The previous ClaudeUI release remains the "I need 1.x" escape hatch for users.

## Consequences

- **Gains:**
  - true dequeue and edit of queued input;
  - a stdin-bound engine lifetime;
  - one server for all directories (no per-cwd spawn race);
  - hot credential changes;
  - a first-party caller-identity signal;
  - generated, drift-checked wire types.
- **Losses:**
  - the opencode plan panel (`todo.updated` has no 2.x source);
  - per-model `reasoning`/`temperature` keys (they become variants and `body`);
  - the `doom_loop` ask;
  - the `chatgpt-account-id` follows a rotation only in the ClaudeUI-owned server process;
  - ChatGPT tokens now need a vault-side lifecycle (§5) because opencode cannot refresh them.
- **Risk:** the API `info` still says "Experimental" (version `0.0.1`). After the 2.0.4 audit cut,
  the routes ClaudeUI uses changed only additively, except the form-reply `message` query, which was
  added and removed. Expect pin bumps every 1–2 weeks, gated by §8.1.

## Owner decisions

Resolved 2026-10-06:

- shared data dir;
- no sign-in import;
- native inbox replaces ADR-053 for opencode;
- access-token-only ChatGPT.

- padded ChatGPT expiry (real + 24 h, §5);
- start now (S0 landed 2026-10-06). The API's "Experimental" label is mostly stale: upstream's
  audit holds every non-`/api/experimental/*` route to its stable commitment, and of 20 releases
  after the 2.0.4 audit cut, 14 changed no contract and none broke a route ClaudeUI uses.
- full real-app verification of every opencode feature at S10, with real turns on a free model the
  owner selected (Nemotron 3.5 Flash Lightning or GPT-6 Luna).
