# opencode 2.x wire protocol

How ClaudeUI talks to opencode 2.x ([ADR-097](../adr/adr-097_opencode-v2-only.md)): the pin, the
server lifecycle, the routes and events it uses, permissions, credentials, the inbox, the
`claudeui-xeng` plugin, the config it injects, and the contract suite that gates every pin bump.
Facts are for the pinned version and cite `vendor/opencode-v2-src/...` at that tag. The spike's
evidence and live transcripts are in [`docs/opencode-v2-spike.md`](../opencode-v2-spike.md); the
as-built decisions per slice are ADR-097's "As built" sections.

The 1.x adapter (`OpencodeV1Client`, `OpencodeV1Session`, `protocol/`, `event-mapper.ts`) is still
in the tree until slice S10 deletes it; nothing in this document applies to it.

## Pin

- opencode **2.0.24**, tag `v2.0.24`, commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69` (verified
  against upstream's `refs/tags/v2.0.24`). Spec and event sources are byte-identical to 2.0.23, the
  S0 pin; only the packages' `version` fields moved.
- **One pin.** The version is the harness manifest's `tested`
  (`src/shared/harness-manifests/opencode.json`); `scripts/generate-opencode-protocol.mjs` reads it
  and keeps only the reviewed commit (`PIN_COMMIT`), which it proves the tag still names. A unit
  test pins `manifest.tested` = `provenance.json#version` = `events.reviewed.json#version`.
- Source checkout: `vendor/opencode-v2-src` at the tag (gitignored, like every `vendor/*-src`).
  The generator reads the pinned commit with `git show`, so the checkout's HEAD does not matter; it
  also honours `OPENCODE_V2_SRC`, and from an agent worktree falls back to the main checkout's
  `vendor/opencode-v2-src`. (`vendor/opencode-src` is the 1.x checkout; S10 retires it.)
- Floor = tested, ceiling `3.0.0`.

## Acquisition (ADR-082 §4, ADR-097 §1)

- npm: `@opencode/cli` (bins `opencode` and `opencode2`, both `bin/opencode.exe`, a placeholder its
  postinstall replaces with a hard link to the platform build on every OS) and one package per host,
  `@opencode/cli-<os>-<arch>` (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
  `windows-x64`, `windows-arm64`, plus `-baseline` / `-musl` variants). Each platform tarball holds
  exactly `package/package.json` and `package/bin/opencode[.exe]`.
- ClaudeUI's managed copy: the installer reads `@opencode%2fcli-<os>-<arch>/<version>` from
  `registry.npmjs.org`, checks the tarball against npm's `integrity` and, for the tested version,
  the reviewed `integrity` and `binarySha256` in the manifest, and keeps only the binary
  (`~/.claude/ui/harnesses/opencode/<version>/opencode[.exe]`). Windows on arm64 still runs the x64
  build. `bun run ensure-opencode` installs the tested version; `update-opencode` reinstalls it.
- Provenance (2.0.24): every package's `repository` is `anomalyco/opencode`, maintainer `thdxr`,
  published by GitHub Actions through npm trusted publishing (OIDC); the darwin binaries are signed
  `Developer ID Application: Anomaly Innovations, Inc. (5NZ4Q7NXJ4)`.
- `--version` prints `opencode v2.0.24` (1.x printed the bare version; a source build without a
  version prints `opencode vlocal`). Detection reads both; a 1.x install is labelled too old
  ("opencode 1.18.34 is from the 1.x line; ClaudeUI uses opencode 2.x (2.0.24 or newer)"), and
  `opencode2` is searched on PATH beside `opencode`. Homebrew's `opencode` formula is a 2.x source
  build with the version stamped in (`OPENCODE_VERSION`), found at `<prefix>/bin/opencode` as
  System and labelled by its version like any other.

## Server lifecycle (`opencode-server-spawn.ts`, `OpencodeServerManager.ts`)

| What          | 2.x                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command       | `opencode serve --stdio --hostname 127.0.0.1 --port 0` (never `--service`)                                                                                                                                                                                                                                                                                                              |
| Listen line   | The FIRST stdout line is JSON `{"url":"http://127.0.0.1:<port>"}`; only a loopback `http:` URL with a port is accepted                                                                                                                                                                                                                                                                  |
| Auth          | HTTP Basic `opencode:<password>`; the password goes in `OPENCODE_PASSWORD` (the legacy `OPENCODE_SERVER_PASSWORD` is deleted from the child env). In `--stdio` mode the server deletes both from its own env, so its tools cannot read it                                                                                                                                               |
| Env           | `OPENCODE_CONFIG_CONTENT` (the injection, §Config; it holds secrets — never logged), `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_SHARE=1`. No `HOME`/`XDG_*` override: the data dir is SHARED with the user's own opencode (owner decision, ADR-097 §6)                                                                                                                          |
| End           | Close stdin (the `--stdio` lease, as pi, ADR-092); a tree kill (`taskkill /T` on Windows) only if the process outlives 5 s. If ClaudeUI dies the pipe closes and the server ends anyway                                                                                                                                                                                                 |
| Keying        | ONE server per distinct config injection (`configIdentity`, a digest of bridged MCP + plugin dir + agent permission overlay), not per cwd: the directory travels per request. In practice one long-lived server per app; a cwd with a project-scoped Claude MCP server gets its own. A config change starts a new server for new leases; the old one ends at its last release (drained) |
| Leases        | `acquire(cwd)` (turn-running: waits for the hosted tools and requires the plugin guard), `acquire(cwd, {waitForHostedTools:false})` (reads), `lingerMs` (a read lease keeps the server idle 60 s after the last release), `acquireIfRunning` (a background read that must never spawn), `acquireDetached` (a server of the caller's own)                                                |
| Release       | `releaseIfCurrent(cwd, conn)` is exact (a server's URL + password is unique per spawn); `release(cwd)` releases the NEWEST holder and is only right for an acquire/release pair around one call                                                                                                                                                                                         |
| Death         | An unexpected exit fans out to `subscribeExit` listeners (exact per lease)                                                                                                                                                                                                                                                                                                              |
| First contact | Before a server serves anything that can activate a location, the credential store's proven-copy cleanup runs on it (S7); until it succeeds the server serves credential-route leases only (fail closed, `OpencodeCredentialCleanupError`)                                                                                                                                              |
| Readiness     | Per (server, directory): `POST /api/rpc/claudeui-xeng/tools` lists the registered `claudeui_*` tools; `acquire` waits (10 s cap, logged, never throws) until `claudeui_dispatch_agent` is there. Fallback: `GET /api/mcp` connected + 400 ms                                                                                                                                            |
| Guard         | Per (server, directory): `POST /api/rpc/claudeui-xeng/guard` must answer `{permissionHook:true, mcpDirect:true}` within 10 s, else a turn-running `acquire` throws `OpencodePermissionGuardError` (fail closed; only `active` is memoized)                                                                                                                                              |
| Config reload | After a ClaudeUI config write: per server `POST /api/location/reload`, then readiness again — but never on a server with a running execution (a reload cancels pending asks and forms; opencode's own config watcher applies the files there, ~0.5 s)                                                                                                                                   |

## Requests (`OpencodeClient.ts`)

Every request carries `authorization` and `x-opencode-directory: encodeURIComponent(<dir>)`. A
request without the directory header is answered for the SERVER's cwd, never the caller's project.
Typed per operationId from the generated table; a non-2xx is `OpencodeApiError` (the operation's
error union when tagged), our timeout `OpencodeTimeoutError` (60 s; `generate` 240 s, under undici's
300 s `headersTimeout`).

| Area        | Routes ClaudeUI uses                                                                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions    | `POST /api/session`, `GET /api/session/{id}`, `GET /api/session`, `PATCH /api/session/{id}`, `DELETE /api/session/{id}`, `POST …/agent`, `POST …/model`, `POST …/fork`                                                            | `session.create` IGNORES the directory header: the client always sends `location:{directory}` (a child, `parentID`, inherits its parent's). `GET /api/session` is GLOBAL (every directory in the DB); `directory` narrows it, `parentID=null` keeps roots. `PATCH {permissions}` REPLACES |
| Turns       | `POST …/prompt`, `POST …/command`, `POST …/interrupt`, `GET /api/session/active`, `POST …/generate`                                                                                                                               | `prompt`/`command` enqueue into the inbox and answer at once; the turn is followed on the feed. `active`: absent = idle. `interrupt?resume=true` lets queued steers run after the stop. `generate` is one transient completion (nothing written)                                          |
| Inbox       | `GET …/inbox`, `DELETE …/inbox/{id}`, `PATCH …/inbox/{id} {delivery}`                                                                                                                                                             | See §Inbox                                                                                                                                                                                                                                                                                |
| Asks        | `GET …/permission`, `POST …/permission/{id}/reply`, `GET …/form`, `POST …/form/{id}/reply`, `DELETE …/form/{id}?message=`                                                                                                         | Replies go to the ASKING session (a child answers its own asks). See §Permissions                                                                                                                                                                                                         |
| History     | `GET …/message` (cursor paged; the client reads oldest first)                                                                                                                                                                     | Rows: `user`, `assistant` (per step), `tool` parts inside assistant content, `idle` (a turn's end and outcome), `compaction`, `synthetic`, `agent-switched`, …                                                                                                                            |
| Shells      | `GET /api/shell/{id}`, `GET /api/shell/{id}/output?cursor=`                                                                                                                                                                       | 2.x pushes no shell output; `tool.progress` carries the `shellID` and ClaudeUI pages the output (it re-reads the bytes of a character cut at a page end)                                                                                                                                  |
| Catalog     | `GET /api/integration` (the activation barrier), `/api/agent`, `/api/command`, `/api/skill`, `/api/model`, `/api/model/default`, `/api/provider`, `/api/mcp`, `GET /api/location`, `GET /api/config`, `POST /api/location/reload` | A cold location answers its catalogs EMPTY for ~100–250 ms until its plugins load; `integration.list` waits for them, so the client awaits it once per directory. `/api/model` can stay empty right after boot (`modelListIsAuthoritative`)                                               |
| Credentials | `GET/POST /api/credential`, `PATCH /api/credential/{id} {label}`, `DELETE /api/credential/{id}`, `POST /api/credential/{id}/activate`, the integration OAuth flow routes                                                          | See §Credentials                                                                                                                                                                                                                                                                          |
| Plugin RPC  | `POST /api/rpc/{rpcID}/{method}` (`{input}` → `{output}`)                                                                                                                                                                         | The spec's params omit `{method}`; the client builds the path                                                                                                                                                                                                                             |
| Events      | `GET /api/event` (SSE)                                                                                                                                                                                                            | See §Event feed                                                                                                                                                                                                                                                                           |

## Event feed (`opencode-event-stream.ts`, `protocol-v2/events.ts`)

- One feed per SERVER: every directory and session. Consumers filter by `eventSessionID(event)`.
- No replay. The reconnecting reader yields `{kind:'connected', reconnected}`; `reconnected:true`
  (or the first `connected` of a resumed session) means **re-read state**:
  `reconcileAfterReconnect` reads `GET /api/session/active` FIRST (a turn's idle row is written
  inside its terminal publish, before the execution leaves the active set), then messages,
  permissions, forms and the inbox for every followed session, and the S4 mapper applies them
  idempotently (by message, call, request, inbox and idle-row id).
- Liveness: a 15 s server heartbeat keeps the reader's 45 s stall watchdog quiet; a run of 8
  failed connects gives up (callers that must not give up pass `maxConsecutiveFailures: Infinity`);
  a 4xx other than 408/429 is fatal (the server is not the one we spawned).
- Consumed events (curated in `events.ts`; anything else fails `isOpencodeEvent`):
  - durable: `session.created`, `session.agent.selected`, `session.model.selected`,
    `session.renamed`, `session.permissions`, `session.deleted`, `session.inbox.enqueued/
delivered/cancelled/delivery.changed`, `session.execution.started/succeeded/failed/
interrupted{reason}`, `session.step.started/streamed/ended/failed`, `session.text.started/
ended`, `session.reasoning.started/ended`, `session.tool.input.started/ended`,
    `session.tool.called/success/failed`, `session.retry.scheduled`,
    `session.compaction.started/ended/failed`;
  - ephemeral: `session.usage.updated`, `session.text.delta`, `session.reasoning.delta`,
    `session.tool.input.delta`, `session.tool.progress`, `session.compaction.delta`,
    `permission.asked/replied`, `form.created/replied/cancelled`, `credential.updated/switched`,
    `provider.updated`, `model.updated`.
- Facts the S4 mapper (`v2-event-mapper.ts`) is built on: one assistant message per STEP
  (`assistantMessageID`); `text`/`reasoning` ordinals count per kind within a step;
  `tool.called` (with the real input) comes BEFORE the tool runs and before its ask; a subagent
  call links its child by `tool.progress.metadata.sessionID` (child events before the link are
  held); a turn ends with `execution.succeeded` / `failed{error}` / `interrupted{reason}`, and
  `interrupted{shutdown}` after a messageless reject or form cancel is a decline, not a shutdown;
  an interrupt drops pending asks WITHOUT `permission.replied` (the mapper retracts them).
- Usage: `step.ended` carries the step's cost and DISJOINT tokens (cache subtracted from input,
  reasoning beside output); `session.usage.updated` is the session cumulative (it also counts title
  generation, which no step carries).

## Turns, the inbox and the queue (ADR-097 §9)

- Every prompt ClaudeUI posts carries its own inbox id `msg_claudeui_<32 hex>` (2.x requires the
  `msg_` prefix). Re-posting an id the session already has returns the first admission unchanged
  (idempotent); an id owned by another session is a 409.
- `delivery: 'steer'` folds the prompt into the running turn at its next step boundary (and starts
  a turn on an idle session); `'queue'` holds it until the turn ends. ClaudeUI posts every prompt
  as `steer` (ADR-053 §1 timing) and keeps ADR-053's queue card; take-back is `DELETE …/inbox/{id}`
  after the item's own POST settled — opencode answers 204 even for a delivered item, so the stored
  row (`GET …/message/{id}`) decides who won. `PATCH …/inbox/{id}` switches steer ↔ queue.
- Stop is `POST …/interrupt?resume=true` (queued steers still run). A teardown interrupts the own
  session and every child whose call is open, cancels ClaudeUI's undelivered inbox items, and
  waits (5 s cap) until `GET /api/session/active` lists none of them (`session-support.ts`
  `stopOpencodeSessions`): a server shutdown keeps a running execution's claim, and opencode would
  resume it headless on its next start.

## Permissions (ADR-097 §3; `permission-v2.ts`, `permission-keys.ts`)

- Rules are `{action, resource, effect}`, last match wins, no match = `ask`. Actions: `shell`
  (Claude `Bash`), `subagent` (`Task`), `edit` (also write/patch/apply_patch/multiedit), `read`,
  `glob`, `grep`, `webfetch`, `websearch`, `skill`, `question`, `external_directory`, `execute`
  (Code Mode), MCP tools as `<server>_<tool>`. Dead 1.x keys are dropped (`list`, `todowrite`,
  `doom_loop`, `lsp`, `batch`, …).
- A whole-category deny (`resource:"*"`) last for its action HIDES the tool from the model.
- Per-session rules ride `POST /api/session {permissions}` and `PATCH` (which REPLACES). The
  session ruleset ClaudeUI sends only tightens: mode gates (asks) → the user's compiled rules (no
  allows under auto; no mutating allows in plan) → plan enforcement → `{execute,*,deny}` → the
  `claudeui_dispatch_agent` ask, whole-category denies moved last.
- An ask is `permission.asked` (`Permission.Request`: `id`, `sessionID`, `action`, `resources`,
  `metadata`, `source:{type:'tool', messageID, id}` = the call, `save` = the "always" patterns).
  The reply is `POST …/permission/{id}/reply {decision:'once'|'always'|'reject', message?}`.
  **A reject WITHOUT a message ends the whole turn** (the call fails `aborted`, then
  `interrupted{shutdown}`, which keeps the execution claim); with a message the call fails
  `permission.rejected` and the model reads the message. So every ClaudeUI reject and form cancel
  carries a message, and `OpencodeClient` refuses a blank one before sending. ClaudeUI never sends
  `always`: opencode's saved table is shared with the user's own opencode.
- A deny rule answers server-side: the call fails `permission.rejected` "Permission denied:
  <action>" (no rule dump). Path resources are relative to the session dir for any file in it or
  its git worktree (`../x` from a sub-dir), absolute otherwise; ClaudeUI compiles deny/ask path
  rules conservatively to every form (`permission-paths.ts`).
- Children: a subagent child copies its parent's WHOLE session ruleset, after its own agent's
  rules, at creation. ClaudeUI PATCHes `childSessionRuleset(parent, agent)` on
  `session.created{parentID}`, on the child's `session.agent.selected` and on every parent
  re-apply (`child-rulesets.ts`, shared by chats and dispatch targets); a PATCH that fails twice
  interrupts the child and refuses its asks (fail closed).

## Forms

`form.created {form}` (the `question` tool): reply `POST …/form/{id}/reply {answer:{<field
key>: value}}` (a choice's OPTION VALUE, a list for a multiselect); dismiss
`DELETE …/form/{id}?message=…` — the message is mandatory for the same reason as a reject's.
Dispatch targets hide `question` (nobody can answer) and cancel any form that still arrives.

## The `claudeui-xeng` plugin (`resources/opencode/claudeui-xeng/`)

A DIRECTORY plugin (2.x ignores a plugin path that is a file, with only a warning), import-free,
default export `{id, setup(ctx)}`, listed in the injected `plugins`. Only the opencode ClaudeUI
spawns loads it.

| Hook / RPC                    | Why                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.hook('execute.before')` | Stamps `__xeng_caller_session` and `__xeng_call_id` into `claudeui_dispatch_agent`'s arguments (events keep the model's input)                                                                                                                                                                                                        |
| `permission.evaluate`         | Re-evaluates the CONFIGURED rules (agent, then session) read back by session id and keeps the STRICTER effect, so the user's saved "always" rows never answer ClaudeUI's gates; for a child it also holds the agent's own rules alone. Tighten-only; unreadable rules → `ask`; runs only when opencode's own deny check found no deny |
| `mcp.transform`               | Sets `codemode:false` on every resolved MCP server in place, so the user's own servers are direct tools (Code Mode's `execute` stays hidden), without reading their headers or env                                                                                                                                                    |
| `rpc claudeui-xeng.tools`     | Lists the registered `claudeui_*` tools (hosted-tools readiness)                                                                                                                                                                                                                                                                      |
| `rpc claudeui-xeng.guard`     | `{permissionHook, mcpDirect}` — both hooks registered (the turn-running acquire requires it)                                                                                                                                                                                                                                          |

## Hosted MCP and caller identity (ADR-097 §4; `mcp-http-host.ts`, `opencode-hosted-tools.ts`)

- ClaudeUI serves its hosted tools (`render_mermaid`, `create_mockup`, `show_mockup`,
  `dispatch_agent`) as the `claudeui` MCP server per opencode server: Streamable HTTP on loopback,
  a static bearer, `oauth:false`, `codemode:false`; one MCP session per opencode location.
- opencode puts `_meta["ai.opencode/sessionID"]` on EVERY `tools/call`. It wins: the engine sets it
  outside anything the model or a plugin controls. The plugin's stamp is the fallback for a request
  without `_meta`; its call id (which keys live streaming to the tool card) is trusted only when the
  stamp's session agrees with `_meta`.
- A subagent CHILD calling `dispatch_agent` is named by `_meta` as the child; the hosted tool walks
  `parentID` (`GET /api/session/{id}`, up to 8 levels) to the ClaudeUI chat it descends from, and
  the dispatch belongs to that chat (its targets are disposed with it). No ClaudeUI ancestor → the
  call is refused.
- Mockups resolve their directory per call from the calling session (ClaudeUI's own, else the
  server's session record).

## Credentials (ADR-097 §5; `credential-store.ts`)

- Credentials live in opencode's DB (`/api/credential`), not `auth.json`. ClaudeUI owns rows
  `cred_claudeui_<slot>_v<n>` (keys: `{type:'key', key}`; ChatGPT:
  `{type:'oauth', methodID:'chatgpt-browser', refresh:'', access, expires: JWT exp + 24 h,
metadata:{accountID}}`) plus the sign-ins started from ClaudeUI (labelled
  `claudeui:signin:<hex>`). It never touches other rows, except deleting ones PROVEN to be a copy
  of its own sign-in.
- Rotation is replace, never PATCH (`PATCH` takes only `label`; a value is silently ignored, a
  re-POST of an id is a 409): POST the next generation `activate:true`, then DELETE the previous.
  2.x hot-reloads credentials (`credential.switched`); there is no recycle.
- opencode resolves (and may refresh) the active OAuth credential only when a LOCATION activates
  its plugins, never at boot or on a credential route — which is why the first-contact cleanup
  runs before any location request.
- An expired ChatGPT bearer surfaces as `session.execution.failed {error:{type:'provider.auth'}}`.

## Config ClaudeUI injects (`opencode-server-config.ts`) and edits (S8)

- Injected (`OPENCODE_CONFIG_CONTENT`, 2.x keys only): `mcp.servers.<name>` (the user's Claude MCP
  catalog for the cwd + `claudeui`, all `codemode:false`), `plugins: [<claudeui-xeng dir>]`,
  `agents.<name>.permissions` (the mode-less overlay: `plan` denies the `general` subagent).
  Nothing else (no `experimental.continue_loop_on_deny`, no `autoupdate`).
- The user's own config stays theirs (ADR-028). ClaudeUI's editors write 2.x keys only and read
  both shapes (2.x normalizes a 1.x file in memory); see ADR-097 §6 "As built (S8)" for the key
  mapping (`agents`, `system`, `permissions`, `request.body`, `capabilities.input`, `variants`,
  `providers`, `experimental.policies`, …). `src/shared/opencode-config-schema.json` is generated
  from the pinned `Config.InfoEncoded`.

## Session list and history (ADR-097 §6, S9; `opencode-session-list.ts`)

- The sidebar lists every root session with ONE paged `GET /api/session?parentID=null` (global);
  archived sessions are left out, the cwd is `location.directory`. A DB created by 2.x has only
  `session_v2`, so there is no direct SQLite read any more.
- Dispatch targets and ClaudeUI's throwaways (`xeng-dispatch`, `side-question`, `agent-generate`)
  are not listed.
- Never blocks the panel: served from the last listing at once; ONE background refresh in flight at
  a time (concurrent triggers share it), at most every 20 s; a refresh that changed the list
  re-emits the merged directory listing once.
- Spawn policy `onInteraction` (owner, 2026-10-07): a refresh may start a server only for the first
  listing of the process, then only on an interaction (the sidebar opening, the app focusing — the
  renderer's `session:list-opencode` nudge) when the listing is older than 5 min. Otherwise it rides
  ANY running server (`acquireIfRunning(…, {anyConfig: true})`: the routes are global). A failed
  start or read backs off exponentially (40 s … 30 min). The usage reconciler never starts one.
  Not installed → [] and no server. History (`GET …/message` of the session and its children) and
  delete ride a running server and start one only when none runs.

## Dispatch targets (ADR-033 on 2.x, S9; `cross-engine-dispatcher.ts`)

- A target holds its OWN turn-running lease (released exactly) and a client scoped to the caller's
  cwd; the feed is shared PER SERVER. It is created with its ruleset (the session's
  `buildSessionRuleset` over the user's deny/ask rules only, then `{claudeui_dispatch_agent,*,
deny}` and `{question,*,deny}`), agent (`plan` in plan mode) and model in the body, titled
  `xeng-dispatch` (the usage reconciler skips it).
- A turn: re-apply the LIVE mode's ruleset (PATCH when changed, switch the agent; a mode switch
  mid-turn re-applies at once), the ChatGPT pre-turn gate, then an inbox prompt (`steer`) — never
  once a Stop or abort has fired. The turn has started when its own inbox item is DELIVERED (a fresh
  execution or one it joined); only a terminal output after that settles it. The target's own S4
  mapper yields the text (the last own step that said something), the usage (every step, children's
  included; steps outside any dispatch turn are metered as rows of their own) and the asks.
- A subagent caller's own deny/ask rules (option a, `caller-restriction.ts`) join the target's
  rules on every target engine, only tighter, and are named to the judge.
- Asks: refused with a message when no dispatch turn is running (idle or draining); a form is
  cancelled with a message; a child's ask its own agent denies is refused; then
  the host pre-check (`host-precheck.ts`: user deny rules, plan mode, user ask rules); then
  ClaudeUI's judge under a judged auto parent, else a card on the dispatching chat. Replies go to
  the asking session, never `always`, every reject with a message.
- Stop/timeout/abort drain the target: wait for an in-flight prompt POST, interrupt the session and
  followed children, cancel that prompt's inbox item, interrupt any execution that starts meanwhile
  (bounded); the next turn waits for it. Dispose also deletes the session before releasing the
  lease. A server exit or a lost feed fails the turn in flight and drops the server's targets (their
  sessions deleted through the next live server); a creation across either rolls back.

## Generated types

`src/core/opencode/protocol-v2/` (the 1.x adapter keeps `protocol/` until S10):

| File                   | What                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.ts`           | GENERATED from `packages/protocol/openapi.json` at the pinned commit: every component schema as a type, plus `Operations` / `OPERATIONS` per operationId. |
| `provenance.json`      | GENERATED: tag, commit, spec sha256, generator version, the sha256 of `openapi.ts`.                                                                       |
| `events.ts`            | HAND-CURATED: the SSE events ClaudeUI consumes (see above).                                                                                               |
| `events.reviewed.json` | The sha256 of every upstream file `events.ts` was transcribed from, at the commit it was reviewed against.                                                |

```sh
bun run generate-opencode-protocol   # regenerate
bun run check-opencode-protocol      # fail on drift; prints + / - / ~ per type and operation
```

**Why the events are curated.** The spec types the SSE payload as an opaque JSON string
(`V2EventEncoded`; the server's own `/openapi.json` says the same). The payloads exist only as
Effect Schemas in `packages/schema/src`, and dumping them to JSON would mean installing and running
upstream's source tree. So `events.ts` transcribes the consumed events by hand and references the
generated component types wherever a payload is one (TokenUsage.Info, Permission.Request, Form.Info,
…). A bump that changes any transcribed source file fails generate and check until someone reviews
the upstream diff (the failure prints the `git diff` command), updates `events.ts`, and runs
`bun scripts/generate-opencode-protocol.mjs --accept-events`.

The unit test `src/core/opencode/__tests__/opencode-protocol-v2.test.ts` runs everywhere: it pins the
emitter, checks the committed `openapi.ts` against provenance, and regenerates byte-for-byte when
the upstream checkout is present.

## Contract suite (the per-bump gate, ADR-097 §8.1)

`src/integration/opencode-v2/` drives a real `opencode serve --stdio` against a localhost
fixture model (scripted by markers in the last user message — `harness/fixture-provider.ts`). It is
gated and skips cleanly without the gate:

```sh
bun run ensure-opencode   # the tested version into the managed store, once
OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode-v2
```

The binary defaults to the managed store's copy of the manifest's `tested` (honouring
`CLAUDEUI_HARNESS_STORE`); `OPENCODE_V2_BIN=/abs/path/to/opencode` overrides it.

- Every server runs with `HOME`/`XDG_*` under `.cache/opencode-v2-it/`, a refusing proxy in every
  proxy variable, models.dev fetch and autoupdate off, and on darwin under a loopback-only
  `sandbox-exec` profile. It is ended by closing stdin, and SIGKILLed if that fails.
- A failed test prints the redacted event sequence, the requests the model received, refused
  outbound attempts and the engine log, and keeps its `.cache/opencode-v2-it/<label>-*` directory
  (`OPENCODE_V2_KEEP=1` keeps all of them).
- The binary must report the pinned version; to try a candidate before bumping, add
  `OPENCODE_V2_ALLOW_VERSION_MISMATCH=1`.
- The ChatGPT credential case needs `sandbox-exec`, so it runs on darwin only.

What it covers, per file: the raw client and wire facts (`client`, `turn`, `inbox`, `permission`,
`form`, `mcp-identity`, `credential`, `paths`, `ruleset`, `plugin-permissions`), the S4 mapper
against recorded and live sequences (`mapper`), and the production stack end to end — the server
manager (`server-manager`: readiness, `_meta` identity incl. a subagent child's, a second
directory, stdin-EOF end), the chat (`session`), credentials (`credentials-s7`), config
(`config`), the dispatcher with an opencode target (`dispatch`: judged ask → runs → returns, a
judge block as a reject with its reason, a card in default mode) and the session list (`session-list`:
two directories in one global listing, the directory filter, delete, history).

## Bump procedure

1. Fetch upstream tags into `vendor/opencode-v2-src` and check the new tag out there.
2. In `src/shared/harness-manifests/opencode.json` set `tested` and `floor`, with each platform
   package's reviewed `integrity` and `binarySha256` (download, verify against npm, hash the binary).
3. Set `PIN_COMMIT` in `scripts/generate-opencode-protocol.mjs` to the tag's commit (check it
   against `git ls-remote origin refs/tags/v<version>`).
4. `bun run generate-opencode-protocol`: review the drift report; if an event source changed,
   review its `git diff`, update `protocol-v2/events.ts`, then `--accept-events`. The generated
   config schema (`src/shared/opencode-config-schema.json`) moves with it.
5. `bun run ensure-opencode`, then the contract suite above (twice, and once with
   `--maxWorkers=4`). Read the files the S4–S8 notes name as wire facts (mapper, credential
   resolution, config normalization, plugin hooks) for the release's changes.
6. Before a release: the Windows lifecycle/shell run (ADR-097 §8.2).
