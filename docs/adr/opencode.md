# opencode engine

Governs: `src/core/opencode/`, `src/core/auth/OpencodeAuthProvider.ts`, `src/core/shared-providers/opencode-claims.ts`, `src/core/services/dispatch-opencode-targets.ts`, `src/shared/opencode-config-v1.ts`, `src/integration/opencode/`, `resources/opencode/claudeui-xeng/`, `scripts/generate-opencode-protocol.mjs`

ClaudeUI drives opencode 2.x only (`opencode serve --stdio`, HTTP plus one SSE feed); opencode 1.x is unsupported and no
fork exists. This record holds the engine's lifecycle, permission, identity, credential and config rules, the provider
Disable/Remove split, interaction and tool parity, and native subagents. Wire facts (routes, events, generated types,
the contract suite, the bump procedure) are in `docs/protocol-opencode/README.md` and `.claude/skills/bump-harness/`.
Neighbouring decisions live elsewhere: the permission mapping across engines (ADR-022) and the rule ladders (ADR-085)
are in `permissions.md`; the auto-mode judge (ADR-023, ADR-081, ADR-083, ADR-084, ADR-091) in `auto-mode-judge.md`;
queued-message take-back (ADR-053) and the disconnect contract (ADR-045) in `engine-model.md`; shared provider routing
(ADR-074) in `providers-and-models.md`; Claude agent definitions and skills in opencode (ADR-103, ADR-115) in
`shared-catalogs.md`; dispatch targets (ADR-033, ADR-105, ADR-108) in `dispatch.md`; the harness installer and the
manifest rules (ADR-082) in `harness-installs.md`.

## opencode runs on 2.x only, one server for every directory (ADR-097)

opencode 2.x is not wire-compatible with 1.x (routes under `/api/*`, a new SSE vocabulary, `{action, resource, effect}`
permissions, credentials in a DB, v1 plugins do not run), and upstream builds only the 2.x line. ClaudeUI supports 2.x
only, with no dual stack. The three capabilities ClaudeUI cannot give up all exist on 2.x: a non-fatal denial (a reject
with a message), a first-party caller identity, and owned credentials applied without a restart. The API still calls
itself experimental, so pin bumps are expected every one to two weeks and each is gated by §8.1.

What is read on purpose from the 1.x era is data, not a code path: 1.x-shaped config files, 1.x tool names in a
migrated session's history, and the copy of ClaudeUI's 1.x ChatGPT sign-in that 2.x imported from `auth.json`.
Accepted losses: the plan panel (`todo.updated` has no 2.x source, the panel stays hidden), per-model `reasoning` and
`temperature` keys (they become variants and `request.body`), the `doom_loop` ask.

### §1 Package, manifest and the version window

- Manifest id `opencode`; `tested` equals `floor` (the pinned release) and `ceiling` is `3.0.0`
  (`src/shared/harness-manifests/opencode.json`). A System 1.x is "too old" (below the floor), the ADR-082 outcome.
- Platform packages are `@opencode/cli-<plat>`; the tarball member is `package/bin/opencode[.exe]`; integrity and binary
  SHA-256 are reviewed per platform. Detection parses `opencode v2.x` (leading `v`) and also searches the `opencode2`
  bin name.
- Opencode's source checkout under `vendor/opencode-src` is the wire reference at the pinned tag; it moves with the pin.
- `opencode-pricing.ts` stays on models.dev, not 2.x `GET /api/model`: `/api/model` zeroes every model a ChatGPT plan
  covers (`cost: []`) and lists usable providers only.

### §2 Server lifecycle

- Spawn `opencode serve --stdio --hostname 127.0.0.1 --port 0`; the first stdout line is JSON `{url}` and only a
  loopback URL is accepted. Never `--service`. The password goes in `OPENCODE_PASSWORD` (HTTP Basic `opencode:<pw>`;
  `--stdio` scrubs it from the child env so tools cannot read it). `OPENCODE_DISABLE_AUTOUPDATE=1`. No `HOME` or `XDG_*`
  override: the data dir is shared (§6).
- The process ends by closing stdin (the pi pattern, ADR-092); a tree kill only after 5 s.
- **One server per distinct config injection, not per cwd.** The directory travels per request
  (`x-opencode-directory`, `location.directory`). The key is a digest of what is injected (bridged MCP, plugin dir,
  agent-permission overlay), so in practice one long-lived server per app; a cwd with a project-scoped MCP server gets
  its own. A config change gives new leases a new server; the old one ends at its last release.
- Leases are exact. `releaseIfCurrent(cwd, conn)` is the only release (URL plus password is unique per spawn); there is
  no cwd-only release, no `recycleAll`, no detached acquire. A server exit fans out to `subscribeExit` listeners
  (ADR-045, `engine-model.md`).
- A turn-running `acquire` waits for the hosted tools to register per (server, directory) (10 s cap, logged, never
  throws; `claudeui_dispatch_agent` is the marker, with `GET /api/mcp` plus 400 ms as fallback) and requires the plugin
  guard (§3). Callers that run no turn pass `waitForHostedTools:false`. Read-only leases keep an idle server for
  `READ_LINGER_MS` (60 s) so a burst of reads starts one server.
- The hosted MCP host is multi-session (one transport per MCP session) because one server serves every directory;
  mockup tools resolve their directory per call from the calling session.
- A credential or account change does not recycle servers: 2.x hot-reloads credentials (`credential.switched`).
  ADR-047's recycle-on-auth-change is gone with the 1.x engine.
- A ClaudeUI config write reloads each pooled server (`POST /api/location/reload`, then hosted-tools readiness per held
  directory) except a server with a running execution: a reload cancels pending asks and forms, and opencode's own
  config watcher applies the files there. Residual: an execution starting inside the check-to-reload window can lose an
  ask.

### §3 Permissions (amends ADR-022; replaces ADR-032's `continue_loop_on_deny`)

Rules compile to `{action, resource, effect}`, last match wins, no match asks (`permission-keys.ts` is the key table,
`permission-v2.ts` compiles and composes). Key table: `bash→shell`, `task→subagent`, `write/patch/apply_patch/multiedit
→edit`, `read/glob/grep/webfetch/websearch/skill/question/external_directory` unchanged, `execute` (Code Mode), MCP
tools as `<server>_<tool>`. Dead 1.x keys are dropped.

- **Every reject and every form cancel carries a non-empty message**, including host-decided and judge rejects. A
  messageless reject (or form cancel) is a hard stop: the call fails `aborted`, the turn ends `stopped/denied` or
  `stopped/form-cancelled`, and the interrupt keeps the execution claim, so opencode would resume it on its next start.
  `OpencodeClient` refuses a blank message before sending (the default reject text is "The user denied this tool call").
  A test pins it. `experimental.continue_loop_on_deny` is no longer injected.
- The session ruleset ClaudeUI sends only tightens, in this order: mode gates (catch-all asks) → the user's compiled
  rules (auto: no allows except the `additionalDirectories` `external_directory` allows; plan: no edit, shell or
  subagent allows) → plan enforcement → `{execute,*,deny}` and the wholly denied direct-tool families → the
  `claudeui_dispatch_agent` ask → whole-category denies moved last (`wireOrder`). There is no `{*: allow}` baseline (each
  agent has one natively), so a subagent's own narrowing holds for every action the session does not name.
  `PATCH /api/session/:id {permissions}` REPLACES.
- A whole-category deny (`resource:"*"` last for its action) hides the tool from the model. A user deny on a whole tool
  hides it (Claude Code parity); a narrow user deny stays a server-side deny per call (tool visible); mode gates never
  hide; plan mode hides `edit`/`write`/`patch`, image generation and the worktree tools and denies the `general`
  subagent; throwaway sessions run `{*,*,deny}`. `execute` (Code Mode, whose runtime has an ungated `fetch`) is hidden
  in every mode.
- **Direct tools are denied in every mode (opencode 2.2.x):** hiding `execute` makes Code Mode tools direct, and most
  run with no permission check, so `opencode_session_*`, `opencode_worktree_*`, `opencode_artifact_*` and
  `opencode_schedule_*` are wholly denied (`DIRECT_TOOL_DENY_RULES`, moved last so no user allow re-opens them). The
  plugin refuses `opencode_worktree_remove` (its permission id is `edit`). `opencode_models` and the MCP-resource tools
  stay available; a server-level MCP deny or ask also covers that server's `opencode_*_mcp_resource` calls.
  `experimental_image_generate` is a paid call the model can start unasked: gated like `webfetch` (ask), denied in plan.
- **`external_directory` asks in every mode, stated by ClaudeUI.** Since opencode 2.0.25 no agent asks for it by default.
  The mode gates carry `{external_directory,*,ask}`, followed by allows for opencode's own directories (`own-dirs.ts`:
  data tool-output and shell dirs, config, tmp from `GET /api/info` plus its `realpath`, and the plan agent's
  `<home>/.opencode/plan`), then the user's rules, so `additionalDirectories` compile to `<dir>/*` allows that outrank
  the ask. The session rules sit after the agent's, so the ask also outranks `explore`'s own allow, for `explore` as a
  primary-turn child and as a dispatch target's child. Any miss in computing the allows only adds asks, never a silent
  read.
- **Auto mode gates every MCP tool and asks for `subagent`, `websearch` and `skill`** (ADR-111 §2). A catch-all
  `{*_*, *, ask}` judges a server unknown when the rules were sent (a late connect, the user's own direct servers);
  `claudeui_*` is allowed (the dispatch ask comes later). Under `explore` the catch-all overlaps its own
  `external_directory` rule, so an MCP call there asks (judged) instead of being hidden.
- **MCP allows never land on a built-in** (`mcp__external__directory` would map to `external_directory`): a tool-level
  MCP allow whose action is a 2.x built-in is refused; its deny and ask are kept.
- **Paths.** 2.x asks with the path relative to the session dir for any file in the session dir or its git worktree
  (`../secrets/k` from a sub-dir session), absolute otherwise. Deny and ask rules therefore compile conservatively to
  every form the resolver can produce (`permission-paths.ts`: absolute, `../` forms against the dir and each ancestor
  whose subtree the literal prefix lies in, the glob part alone, `**/` also as zero directories, settings-relative `/x`
  against the session dir and the worktree root). Allows stay precise (an allow that misses costs an ask, never a
  grant). Contract: a session in `<repo>/pkg` with `deny Edit(//<repo>/secrets/**)` cannot edit `../secrets/x`.
- **Windows absolute rules.** `//c/rest`, `//c` and `//C:/rest` compile to the drive form `C:/rest` on win32 (keeping
  `/c/rest` matched nothing 2.x asks with, so the deny was inert); POSIX `//c/x` stays `/c/x`. A caller restriction names
  a Windows path by its bare drive form `D:/x`, never `/D:/x`.
- **Subagent children.** A child copies its parent's whole session ruleset after its own agent's rules.
  `childSessionRuleset(parent, agent)` = the parent's rules, then the agent's own deny rules that still hold at the end
  of its ruleset (narrow ones included; a deny the agent's own later allow carves is left out), then a whole-category
  deny for each action the parent opens and the agent wholly denies. The host PATCHes it on `session.created{parentID}`,
  on every parent re-apply and on `session.agent.selected`; `evaluateChildCall` is the host's backstop; a PATCH that
  fails twice interrupts the child and refuses its asks (fail closed). The plugin additionally evaluates a child's agent
  rules alone on every call (below), because a deny the agent carves itself cannot be restored by any child ruleset.
  Code in `child-rulesets.ts` is shared by chats and dispatch targets.
- **Saved "always" allows are ignored.** The plugin's `permission.evaluate` hook re-reads the session's and the agent's
  rules by session id, evaluates `agent ++ session` with opencode's matcher and keeps the stricter effect. It only
  tightens (allow → ask/deny), leaves a deny untouched and answers `ask` when it cannot read the rules. Saved rows
  therefore cannot answer a default-mode gate, the judge's asks or plan-mode shell. ClaudeUI never sends `always`, never
  deletes the user's saved rows, and only the opencode it spawns loads the plugin.
- **The user's own MCP servers are direct.** The plugin's `mcp.transform` sets `codemode:false` on every resolved server
  in place, reading no names, headers or env (a config overlay would have to copy the entry, secrets included). Their
  tools are offered as `<server>_<tool>` and go through ClaudeUI's approvals and `mcp__` rules; `execute` stays hidden.
- **The plugin is required (fail closed).** The guard RPC reports `{permissionHook, mcpDirect, modelGate}` (plus
  `allowlistLoaded`, logged only). Every turn-running `acquire` probes it per (server, directory) and throws
  `OpencodePermissionGuardError` (lease released) when the plugin is missing or does not confirm within 10 s: a clear
  error, never a silent downgrade. Turn-less acquires skip it.

### §4 Caller identity and opencode as a dispatch target

- The dispatcher reads the caller session from the MCP request `_meta["ai.opencode/sessionID"]`, which the engine sets
  outside anything the model or a plugin controls: it always wins. The plugin (a DIRECTORY plugin, import-free,
  `resources/opencode/claudeui-xeng/`; 2.x ignores a file plugin with only a warning) stamps `__xeng_caller_session` and
  `__xeng_call_id` from `execute.before` as the fallback; the call id (which keys live streaming to the tool card) is
  trusted only when the same call carries the plugin's session stamp and it agrees with `_meta`. A missing call id still
  dispatches, without live streaming.
- The `claudeui` MCP server and bridged servers are injected as `mcp.servers.<name> = {type, url, headers,
codemode:false}`; without `codemode:false` opencode hides MCP tools behind `execute` and the call id becomes
  `execute`'s.
- A subagent child calling `dispatch_agent` is named by `_meta` as the child; the hosted tool walks `parentID` (up to 8
  levels) to the ClaudeUI chat it descends from, and the dispatch belongs to that chat. No ClaudeUI ancestor (a target's
  own child, a foreign session) refuses the call.
- **A subagent caller's own restriction.** When the caller is a subagent child, the target runs under the chat's mode
  and rules plus the calling agent's own deny and ask rules, every child agent on the way up (`caller-restriction.ts`;
  unreadable → the call is refused, fail closed), mapped to Claude-form rules every target engine compiles. Only ever
  tighter (deny and ask only; a deny with no exact equivalent becomes the whole category; an MCP rule restricts the whole
  server; `external_directory` asks and Code Mode's `execute` are not mapped). It is named in the judge's subagent
  header and sticks to the target: a continuation from a caller the restriction does not cover is refused.
- **opencode as a target.** Each target takes its own turn-running lease (plugin guard required), released exactly; the
  event feed is shared per server (URL plus password). Its ruleset is `buildSessionRuleset` over the user's deny and ask
  rules only (ADR-085 §3, never allows; the user's additional directories since ADR-108), then
  `{claudeui_dispatch_agent,*,deny}` and `{question,*,deny}` (a form that still arrives is cancelled with a message).
  Every turn re-applies the live mode's ruleset and agent, fail closed, and a mode switch mid-turn re-applies at once.
  It runs the ChatGPT pre-turn gate (§5), then posts an inbox prompt (`steer`) and never after a Stop or abort. A turn
  has started when its own inbox item is delivered (also when steered into an already running execution) and only a
  terminal output after that settles it. Give-ups (Stop, timeout, abort, refused prompt) drain: await an in-flight
  prompt POST, interrupt the session and followed children, cancel that prompt's inbox item, re-interrupt an execution
  that starts meanwhile. Asks are refused with a message when no dispatch turn is running; otherwise: a child ask its own
  agent denies is refused → `hostPrecheck` (user deny rules, plan mode, user ask rules) → the judge under a judged auto
  parent (ADR-088), else a card on the dispatching chat; replies go to the asking session, never `always`. A target's
  session is kept and resumed from the ledger (ADR-105); only a creation that rolled back deletes its session.
  opencode to opencode dispatch stays refused (same engine). Dispatch itself is in `dispatch.md`.

### §5 Credentials

ClaudeUI manages every credential and vends it to opencode through `/api/credential`; it never writes `auth.json` and has
no sign-in import. `OpencodeCredentialStore` (`credential-store.ts`) is the only writer of ClaudeUI's rows, one lease
per operation, operations serialized.

- **Shapes.** Keys: `cred_claudeui_<integration>_v<n>`, `{type:"key", key}`, label `claudeui:key`. ChatGPT:
  `cred_claudeui_<account>_v<n>`, `{type:"oauth", methodID:"chatgpt-browser", refresh:"", access, expires, metadata:
{accountID}}`, `activate:true`, label `claudeui:chatgpt`. `metadata.accountID` is mandatory (opencode takes the
  `chatgpt-account-id` header only from it; a vend without one is refused). Access-only is accepted; ChatGPT mode then
  follows (codex baseURL, account header, eligible-model filter, `cost:[]`).
- **Rotation is replace, never PATCH** (`PATCH` takes only `label`; re-POSTing an id is a 409): POST the next
  generation `activate:true`, then DELETE the other generations of the slot. No gap, one `credential.switched`, no
  restart. Any vend, boot included, therefore also prunes what a crash between POST and DELETE left.
- **Padded expiry.** The vended `expires` is the token's real expiry plus 24 h (`CHATGPT_EXPIRY_PADDING_MS`), so opencode's
  own `expires <= now+5min` refresh never fires and it never sends the empty refresh token to auth.openai.com (after
  sleep, on a missed gate, from concurrent turns). The vault schedules from the real expiry (decoded from the access
  token, never from the row); one expiry (the earlier of JWT `exp` and the vault's) drives every opencode decision. A
  token that really expires is rejected by chatgpt.com, surfaces as `session.execution.failed {type:"provider.auth"}`
  and takes the refresh-and-rotate path. Accepted cost: the user's own opencode, if it ever ran on ClaudeUI's row (only
  after a crash), would see a later expiry than the real one.
- **What the vault must do.** Refresh and rotate on a lead of at least 15 min; on system resume or unlock re-schedule
  from the wall clock; gate every opencode turn (`opencodeTurnGate`, inside the session's establishing window so a
  queued item cannot overtake it): more than 15 min left passes, else refresh or re-vend; a needs-sign-in account is not
  refreshed; if refreshing fails the turn is held with `session:auth-required` and nothing is posted, queued items
  included. `provider.auth` on an `openai` turn refreshes and rotates at once (60 s cooldown). An expired token is never
  vended. On start, vend the active account (none → remove ClaudeUI's rows).
- **Ownership.** Automatic paths (vends, syncs, a shared-provider route removal, disconnect, quit) delete or rotate only
  ClaudeUI's rows: `cred_claudeui_*` plus sign-ins started from ClaudeUI. User rows, including ones opencode imported
  from `auth.json`, are never touched, except an explicit Remove (below). ClaudeUI's record
  (`~/.claude/ui/opencode-credential-slots.json`, ids and flags only, mode 0600) lists each slot it may hold, written
  before the POST, with the non-ClaudeUI row it displaced (`previousActive`). A corrupt record is moved aside and
  rebuilt from the live `cred_claudeui_*` rows and never blocks a vend.
- **Active slot.** While a ChatGPT account is connected, ClaudeUI's row is the active `openai` credential. opencode's
  delete-of-active promotes the newest remaining row, so on removal and graceful quit ClaudeUI re-activates the
  remembered previous row first (only when ClaudeUI held the slot; a user sign-in that took it later stays active and is
  logged, not fought).
- **Proven copies are deleted.** A non-ClaudeUI row proven to be a copy of ClaudeUI's sign-in (its refresh token is the
  vault's or in the 1.x fed-token history) is deleted on every new server (`installCopyCleanupHook`, first contact) and
  by the first store operation of each process; unproven rows are never touched; each deletion is logged by id and
  reason. No removal ever promotes such a copy (a ClaudeUI row stays active when the row opencode would activate is a
  copy). **Fail closed:** a server whose cleanup failed or timed out serves only credential-route leases
  (`acquire({credentialRoutesOnly})`); every other acquire retries the cleanup with back-off and then throws
  `OpencodeCredentialCleanupError`; a credential `create` is refused until the cleanup succeeded, because on 2.2.x a
  create boots a location, which can make opencode resolve and refresh the active OAuth credential. Residual: a 2.x
  process that is not ClaudeUI's can still do that before ClaudeUI first connects.
- **Sign-ins started from ClaudeUI are ClaudeUI's.** An OAuth sign-in from the opencode provider screen runs on
  opencode's connect flow with a one-off label `claudeui:signin:<16 hex>`; the row carrying that label, and only it, is
  recorded by its opencode-chosen id and relabelled `ClaudeUI sign-in · <hex>`. Every generated label is kept in a
  sibling ledger before the flow starts (a late row is adopted by exact label; a pending label expires after 1 h); a
  quarantined record is rebuilt from that ledger, never from a label alone, and with the ledger gone such rows fail safe
  as the user's. API keys stay `cred_claudeui_*` rows (no connect flow).
- **An explicit user Remove deletes every credential row of the provider** (2026-10-21). `removeIntegration` deletes
  ClaudeUI's rows, ClaudeUI-started sign-ins, the user's own keys and sign-ins and external-credential markers (the
  external login itself is untouched), inactive rows first and the active one last, so opencode promotes nothing and
  emits one `credential.switched` to null. Only the two explicit user surfaces reach it (`removeVendorAuth`: the provider
  sheet's Remove, `session:remove-opencode-provider`, and the models dialog's "Remove key", `vendor-auth:remove`), both
  two-click confirmed. A shared-provider route removal (`removeVendorKey`, no fallback to the wide verb), ChatGPT
  disconnect, quit, syncs and route toggles still delete only ClaudeUI's rows. The sheet says that the user's own
  opencode loses the rows too (§6). Each deleted row is logged at `warn` by integration, id, kind, owner and caller,
  never by value or label. A provider whose catalog id differs from its integration's (`google-vertex-anthropic` on
  `google-vertex`) is not offered Remove. Remove is offered when the live credential table holds any row for the
  provider (`integrationsWithRows()`), not from ClaudeUI's record. Every removal kind is refused, before any delete or
  write, when an enabled shared-provider route claims the provider (`shared-providers/opencode-claims.ts`, applied by the
  desktop and the remote catalog handlers alike). Partial failure keeps the rows already deleted deleted.
- **Quit.** On a graceful quit the host's shutdown path runs `CredentialSync.prepareQuit` before teardown, under a
  time bound (4 s on the desktop): it stops the timers and gives the slot back
  (activate the user's row, delete inactive generations, the active one last; a cut leaves a state the next start
  finishes). After quit the shared DB holds no ChatGPT credential for the user's own opencode (the token is only fresh
  while ClaudeUI refreshes it): accepted. ClaudeUI's API-key rows stay active after quit and the user's own key rows for
  those providers stay inactive (keys do not expire, the values match): accepted.
- **Auth provider and discovery.** `OpencodeAuthProvider` reads `/api/integration`, `/api/provider` and the credential
  snapshot (types, ownership and identities of each integration's active row, never a value); OAuth sign-ins run on
  `integration.oauth.*`. ADR-074 adoption reads opencode's active key rows in one credential list per pass.
  Discovery (`model-discovery.ts`) probes on ClaudeUI's own global server so a project's config never reaches the global
  catalog; a cold empty `/api/model` is re-read until `modelListIsAuthoritative` and never negative-cached (a warm
  authoritative empty answer is kept 30 s); free means the zen gateway with every cost tier zero (ChatGPT's `cost:[]` is
  not free). Errors on credential paths are logged redacted.

### §6 Data dir (shared with the user's own opencode)

- ClaudeUI spawns 2.x on the user's default data dir: shared DB and sessions, and the user's config stays theirs. A
  1.x-created DB is migrated in place by 2.x. Concurrent writers (the user's TUI or `--service` server) are allowed (WAL,
  `busy_timeout=5000`, no cross-process lock). Bus events are per process: a credential rotation reaches another running
  opencode only through its per-request DB read.
- Because the dir is shared, a throwaway session (side question, agent generation) is deleted, awaited, before its lease
  ends, and ClaudeUI's own `xeng-dispatch`, `side-question` and `agent-generate` sessions are filtered out of the user's
  session list.
- **Session list.** One paged `GET /api/session?parentID=null` with no directory (2.x's list is global); archived
  sessions are left out; the cwd is `location.directory`; there is no direct SQLite read. The sidebar never waits for a
  server: it serves the last listing at once and refreshes in the background (one in flight, at most every 20 s, one
  `session:directories-changed` when it lands). **Spawn policy `onInteraction`:** a refresh may start a server only for
  the first listing of the process, then only on an interaction (sidebar opening, app focus via the renderer's
  `session:list-opencode` nudge) when the listing is older than 5 min; every other refresh only rides any running server
  (`acquireIfRunning(…, {anyConfig: true})`). Failed starts or reads back off exponentially (40 s, capped at 30 min). The
  usage reconciler never starts a server. Not installed → no sessions and no server.
- The first `/api/model` after a boot can be empty (cold location); discovery must not negative-cache it (ADR-092).
- opencode config on 2.x keys is in the config section below.

### §7 Wire layer

- Types are generated from the spec the pinned binary serves (`GET /openapi.json` of `serve --stdio`) by
  `scripts/generate-opencode-protocol.mjs` (no new dependency, no `@opencode/client`), committed with provenance, and CI
  fails on drift (`bun run check-opencode-protocol`, which needs the binary in the managed store). The generator runs the
  binary only after its SHA-256 matches the manifest's reviewed digest and `--version` matches `tested`, under an
  isolated home with every proxy refused. The committed upstream `openapi.json` is not used: it stopped tracking the
  binary at 2.0.25. The SSE events ClaudeUI consumes are a hand-curated closure (`protocol-v2/events.ts`, with
  `events.reviewed.json` hashing the upstream sources it was transcribed from); unknown event types are ignored.
- `OpencodeClient` is typed over the generated `OPERATIONS`: Basic auth and a URI-encoded `x-opencode-directory` on every
  request (a request without it is answered for the server's cwd), a permission reject without a message does not
  compile, a blank one throws before sending. `session.create` ignores the directory header, so the client always sends
  `location`. A directory's catalogs answer empty until its plugins load, so the client awaits `integration.list` once per
  directory before the first catalog read. The feed has no replay: a new subscription yields `connected` with
  `reconnected:true` and the consumer re-reads state (`reconcileAfterReconnect`: active, messages, permissions, forms,
  inbox, applied idempotently by id).
- The event mapper (`event-mapper.ts`, one per chat) maps the feed to the engine-neutral stream; cold history
  (`history.ts`) shares its content helpers and is held equal to what streamed live. Rules that bind: a user stop is
  `stopped/user` with no banner (ADR-090); a messageless reject or form cancel ends `stopped/denied` or
  `stopped/form-cancelled`; every card of an ended execution is retracted (an interrupt drops pending asks without
  publishing `permission.replied`); each subagent call gets exactly one terminal notification; a child's steps attribute
  to the call that started them. Usage follows Claude's status line: the session's and its children's steps, each
  compaction's request, and the session's remainder against its cumulative (`overhead-usage`); only own steps move the
  context meter. 2.x pushes no shell output: `ShellOutputPoller` pages `/api/shell/{id}/output`.

### §8 Conditions on supporting 2.x

**§8.1.** Every pin bump runs the contract integration suite `src/integration/opencode/*` (fixture provider, deny with
message, steer/queue/cancel, interrupt, subagent, form, MCP identity, credential CRUD, cold history, the ruleset and
`external-directory` canaries) together with `bun run check-opencode-protocol`; a run that only skipped has not passed.
Procedure: `.claude/skills/bump-harness/`, detail in `docs/protocol-opencode/README.md`.

**§8.2.** A Windows run of the lifecycle and shell slices passes before release.

The §5 vault rules ship with tests (lead-time rotation, the resume and pre-turn gate, `provider.auth` → auth-required
plus rotate, boot cleanup, active-slot restore), and a real-token smoke check against chatgpt.com passes before release,
otherwise opencode ChatGPT vending ships disabled.

### §9 Queue: opencode's native inbox

- opencode's inbox replaces ADR-053's host-held queue for opencode sessions (other engines keep ADR-053). Every prompt
  carries a ClaudeUI-chosen id `msg_claudeui_<32 hex>` (idempotent `POST …/prompt {id, delivery}`). Dequeue is `DELETE
…/inbox/:id`, steer to queue is `PATCH …/inbox/:id {delivery}`; the queue UI renders from `session.inbox.*` events.
- A prompt typed while a turn runs stays ADR-053's queue item (card, ArrowUp take-back) but is posted at once with
  `delivery:'steer'` (the next step boundary; `queue` would hold it until the turn ends, which ADR-053 rejected).
  `delivered` consumes the item, `cancelled` recalls it. Take-back is `DELETE` after the item's own POST settled;
  opencode answers 204 even for a delivered item, so the stored row (`GET …/message/:id`) decides. Posts are serialized
  so a queued item never overtakes its turn's prompt. Stop is `interrupt {resume:true}` (queued steers still run).
- **Teardown.** Every end of a lease on a live server (`cancel()` and a feed that gave up alike) first interrupts the
  own session and every child whose call is still open, cancels ClaudeUI's undelivered inbox items, and waits until
  `GET /api/session/active` lists none of them (the interrupt route answers before its cleanup settles; bounded 5 s);
  only then is the lease released. A shutdown keeps a running execution's claim, so a teardown that skipped this would
  leave opencode to resume it headless. After a give-up the mapper forgets its open requests with the cards.
- **Approvals.** The ladder is the host pre-check, session allows, the judge pipeline, then holds; children inherit the
  rules, so there is no parent rung. Replies go to the asking session. Forms reply `{<key>: value}` with the option
  value. 2.x publishes `tool.called` before it runs the tool, so asks carry the real input.
- **Side question and agent generation** run `generate` (240 s) on the chat's own session when it exists (never switching
  a running turn's model), else on a throwaway created with `THROWAWAY_RULESET`; a throwaway is deleted (awaited) before
  the lease ends. Synthetic items (plan reminders, notices) are neither rendered live nor cold.

## opencode config is written in place, leaf by leaf, to the user's own files (ADR-028, ADR-029, ADR-031)

Config is classified by ownership, not by engine. **Engine-native config** (model, small model, providers, the provider
veto, agent overrides) is written to opencode's own global config file, in place, so a standalone `opencode` sees it.
**Neutral or dynamic config** (permissions and autonomy, compiled per session; the hosted-MCP `mcp.claudeui` block with
its per-spawn port and token; bridged MCP; the plugin) is ClaudeUI-owned, applied at runtime through the session API and
`OPENCODE_CONFIG_CONTENT`, and never persisted into the user's files. `modelAllowlist` (a picker filter opencode does not
understand) and `autoMode` stay ClaudeUI-private in `~/.claude/ui/engines/opencode.json`. Skills are bridged, not
mirrored (ADR-115, `shared-catalogs.md`). The injected content holds only the 2.x keys `mcp.servers`, `plugins` and the
`agents.<name>.permissions` overlay (`plan` denies `general`); nothing else.

- **Target file.** opencode's global config dir resolved as opencode does (`OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME`,
  then `~/.config`, plus `/opencode`). Write the highest-precedence file that exists (`opencode.jsonc`, else
  `opencode.json`, else create `opencode.json`). Edits are comment-safe (`jsonc-parser`); every write is temp file plus
  rename (mode kept, symlinks followed). ClaudeUI's global file is lower precedence than a project `opencode.json`, which
  wins: the intended user-defaults semantic. A one-time non-clobbering migration moved the old private fields into the
  file only where the native key was absent.
- **Writes are diff-driven leaf merges, never subtree replacements.** ClaudeUI touches only keys it models and that
  changed, and never deletes a key it does not model: the projection the UI edits is lossy (a hand-added model
  `attachment`, `modalities`, provider `npm`, `options.apiKey`, an agent's `prompt`) and a subtree rewrite silently
  destroyed those. A no-op save produces zero edits and no rewrite. A removed provider or agent is user intent and its
  whole subtree is deleted; a kept one gets per-leaf edits. A provider declared only in the other global file is
  invisible to the diff and never deleted. Everything else (`theme`, `keybinds`, user `mcp.*`, comments) is user-owned
  and never written.
- **Conflict-aware.** A pane sends the snapshot it edited (`saveOpencodeSettings(settings, base)`); only its changes
  relative to that snapshot land on the file as it is now (`rebaseFields`), so a provider or veto added meanwhile
  survives. Shared modules never read `process`; the platform is passed in.
- **Write 2.x keys only, read both shapes.** 2.x normalizes a 1.x file in memory and keeps a 2.x map entry whole over a 1.x
  entry of the same id, dropping the 1.x fields. So an entry ClaudeUI edits moves whole to its 2.x key in the form 2.x
  reads it (`src/shared/opencode-config-v1.ts`, a port of upstream's `ConfigMigrateV1`, exact: a move changes nothing 2.x
  runs on); untouched 1.x entries stay and are shown as 2.x reads them; a 1.x `mode.<name>` replaces `agent.<name>`; a
  set of a path the generated schema lacks is refused. Key mapping highlights: `small_model` → `agents.title.model`;
  `disabled_providers`/`enabled_providers` → `experimental.policies` `provider.use` rules (last match wins;
  `enabled_providers: []` means deny all); `provider.<id>` → `providers.<id>`; agent `permission`/`tools` →
  `permissions` rules; built-in tool switches → top-level `{action,*,deny}` in `permissions`, where "off" is the last rule
  matching the action being a `*` deny and ON removes only the rule ClaudeUI's switch wrote (recorded in
  `engines/opencode.json`), never a user rule and never adding an allow. Not expressible on 2.x (shown, not offered):
  per-model temperature flag, `reasoning: true`, `compaction.prune`/`tail_turns`, `logLevel`, `experimental.batch_tool`.
  The raw editor validates against `src/shared/opencode-config-schema.json`, generated from the pinned
  `Config.InfoEncoded`.
- **Automatic syncs write only what the definition changed.** Every boot re-applies the shared-provider definitions; a
  capability leaf is written only when the definition changed it since the last apply (and the file still holds
  ClaudeUI's last value) or the model declares no capability at all, so an unchanged 1.x entry is neither moved nor given a
  `variants: []`. Agents and the Tools switch are user actions only; MCP is injected, never written.
- **Custom agents (ADR-029).** An agent is a markdown file in opencode's own dirs (global `agents/<name>.md` or project
  `.opencode/agents/<name>.md`, scope chosen per agent), written in 2.x front matter, body = system prompt; CRUD is the
  file. Built-ins (`build`, `plan`, `general`, `explore`, hidden `title`/`summary`/`compaction`) are editable by a
  same-named override (a built-in override with no prompt is written as `agents.<name>` in the scope's config file),
  "Reset to default" deletes it, "Disable" writes `disabled`. **Permissions are opt-in:** with no `permissions` block the
  agent inherits the session's mode and judge (and a subagent its parent's rules); a "Restrict this agent's tools" grid
  writes a restrictive floor only. **The grid never reorders rules** (2.x is last-match-wins): an action's last
  `{action,"*"}` rule is edited in place, a new ask or deny is inserted right after the last catch-all already deciding
  the action, `allow` with no rule adds none, and a save with no change leaves the list byte-identical. A rename or scope
  move carries one file and deletes only that one. Reasoning effort is the model variant (`model: p/m#effort`). Values
  2.x would silently drop the whole agent for (non-`p/m` model, non-hex colour, steps ≤ 0) are refused. "Generate with
  AI" runs the agent-architect meta-prompt on a throwaway session (`agent-generate`) and fails soft to manual authoring.
- **Reload** is the lifecycle rule in §2 of the first section.

## Disable and Remove are different operations over one provider list (ADR-044)

opencode keeps no list of installed providers; it re-derives them from config declarations, env vars, stored
credentials, plugin loaders gated on a credential, and credential-free autoloads, and `disabled_providers` (on 2.x the
`provider.use` deny policy the writer emits for `disabledProviders`) is the only veto that beats every source.

- **Disable** writes only the native veto. It is reversible, destroys nothing and is always available.
- **Remove** destroys what ClaudeUI may delete: every credential row of the provider (anyone's, ADR-097 §5) and/or the
  declaration in the one global file ClaudeUI writes; the dialog names exactly what will be destroyed and is confirmed.
  Availability is one pure function (`provider-actions.ts`, `resolveProviderActions`) carried on each catalog entry:
  credential and declaration → `both`; a credential row → `credential`; a declaration in our file → `declaration`; a
  non-free provider whose only remaining configuration is its veto, with no credential and no declaration in either
  global file → `settings` (clears the veto and ClaudeUI curation, deletes nothing else). Otherwise it is blocked: a
  declaration in the other global file, a project or managed config, an env var, a free credential-free gateway. A
  blocked Remove is rendered disabled with its reason inline (touch and web have no hover), never hidden, and every
  reason points at Disable.
- **The decision never comes from opencode's `source` or env.** Inputs are cheap local reads (the live credential table,
  the two global files); `source` and env names only word the reason, so a schema change cannot silently alter which
  actions are offered. A probe cannot work because a running server does not re-read config and the provider state is
  invalidated only on instance dispose.
- **Remove clears its own veto** (`removeOpencodeProvider`): it drops the id from `disabled_providers` and from
  `modelAllowlist` unconditionally (a veto outliving its target caused ChatGPT's "0 models"; a stale empty allowlist would
  do the same on re-add). The declaration delete and the veto cleanup share one config read-modify-write. A failed
  credential delete aborts before any config write. A `settings` removal re-reads everything at the write boundary and
  refuses a row that gained a credential or declaration or became enabled. An enabled shared-provider route that claims
  the provider refuses every removal kind (a stale sheet). Env and project sources are never deleted; clearing the veto
  can let such a source supply the provider again.
- **One list.** Catalog and declared providers share one list, including disabled ones as first-class rows (discovery
  re-synthesizes them because `GET /api/provider` omits disabled ids). The two verbs stay two controls:
  `ProviderSheet.engineToggle[data-id=opencode]` (`session:set-opencode-provider-disabled`) and `ProviderSheet.remove`
  (`session:remove-opencode-provider`). A shared-provider-managed declaration renders read-only (the compiler owns it,
  ADR-037 in `providers-and-models.md`); the claim is decorated at the IPC boundary because discovery importing
  `shared-providers` would be a cycle.
- **An enabled-but-empty route explains itself.** `SharedProviderStatus.routes[route].diagnosis` is set only for an
  enabled, un-errored route with zero models: `provider-disabled` (reported first), `models-restricted`,
  `no-models-discovered`. It is deliberately not folded into `error` (a diagnosis is a healthy route with a configuration
  reason). pi can only report `no-models-discovered`.
- Both verbs reach the remote surface (ADR-039 parity).

## opencode interaction and tool parity come from the wire, no fork (ADR-024, ADR-032)

Parity with the Claude engine means mapping opencode's native mechanism onto the engine-neutral contract, not copying
cli.js internals. Everything is done on the ClaudeUI side; no opencode fork exists (a fork adds a build pipeline and a
rebase per release for no capability the wire does not already offer).

- **Slash commands.** `GET /api/command` lists them; a `/known-command` prompt goes to the command route (opencode does
  not interpret a leading `/` in a normal prompt), else to the prompt route with a fallback to a prompt when the command
  route rejects it. Skills are model-invoked and listed by the skill route; the shared Claude skill catalog is served by
  ClaudeUI's plugin under Claude's names and a typed `/name` is expanded host-side (ADR-115).
- **Eager connect.** `run(null)` connects at session creation to discover commands and skills before the first prompt.
  The acquire is memoized (`ensureConnected`) so a racing prompt cannot double-acquire (a lease leak), and it re-arms
  after an idle timeout.
- **`/btw` is a throwaway, history-free session** with a deny-all ruleset (`THROWAWAY_RULESET`), so the synchronous turn is
  tool-less and cannot hang on an unanswerable ask. A native `question` form (the model asking the user) is shown through
  the existing AskUserQuestion block and **always goes to the human, never the auto-mode judge** (the judge decides tool
  permissions, not questions); answers map in question order and a dismissal carries a message (§3).
- **Subagent children render through the neutral contract.** The mapper routes own, known-child and ignored sessions; a
  child's idle can never end the parent turn (the branches are mutually exclusive by session id); child usage is metered
  under the child's own model. Lifecycle, judge context and Stop are ADR-111 below.
- **Diffs** are typed and shape-gated, not tool-name-gated: `FileDiff { path, patch, additions?, deletions?, changeType? }`
  extracted from result metadata (`files[]` for `apply_patch`, `filediff` for `edit`), carried as `fileDiffs` on the
  `tool_result` block through live, history and store paths, rendered with the existing diff viewer. No size caps (parity
  with Claude). Not an untyped metadata passthrough. `write` carries no diff upstream; the shape gate picks it up if that
  changes.
- **Live bash output** reaches `session:bash-output` through a dedup and trailing-edge throttle gate
  (`bash-stream-gate.ts`, about 100 ms per tool call) fed by the shell output poller (§7); own-session only, cancelled on
  completion and teardown.
- **Denials are reasoned and non-fatal.** The judge's block sends `Auto mode blocked: <reason>` (cli.js wording parity);
  a human deny sends the user's feedback or a default text. The model sees the message as the tool result and the turn
  continues, deliberately unlike opencode's own TUI where a reject stops the turn. A tool error's own text is shown in
  the card. The judge's denial caps (3 consecutive, 20 total, then the human) are unchanged (ADR-023,
  `auto-mode-judge.md`).
- Capability flags are honest (ADR-030): `OPENCODE_ENGINE_CAPABILITIES` in `src/shared/model-capabilities.ts` is the
  source (fork and fork-from-message are false because the path is unwired).

## Native subagents are judged in their own context, tracked, stoppable and allowlisted (ADR-111)

opencode subagents are native: the `subagent` tool creates a child session on the shared server and ClaudeUI follows it
through the feed (pi's are host-run, ADR-089, the reference). Native subagents are not run from the host: that would
lose opencode's job recovery across a restart and its tuned tool prompts. Gaps are closed with the plugin hook, the API
and the feed.

### §1 A child is judged in its own context

`OpencodeSession` keeps judge state per child session (trajectory, outcomes, denial tracker), keyed by the child's
opencode session id (a resumed child runs under several calls and a grandchild's owner is a call made inside the child,
so the call id is the wrong key; `child-judge-state.ts`). A child's ask is judged on this session's transcript, its
still-queued user turns and that child's own assistant trajectory in time order (each bounded at 200 messages), with the
child's own outcomes and caps, so one child's denial streak never escalates the parent or a sibling. A grandchild's judge
does not see the intermediate agent's trajectory (ADR-088 D1). A reopened chat seeds it from child transcripts. A child's
approval card names its agent.

### §2 Auto mode judges spawns, web searches and skill loads

`autoModeGates()` asks for `subagent`, `websearch` and `skill` (other modes unchanged; plan mode's `subagent general` deny
still wins). A spawn's input is a delegation payload and gets the full review. Allow rules follow Claude Code (ADR-085):
a `Task`/`Agent` allow never skips the judge on a spawn; a bare `WebSearch` and a `Skill(name)` allow do. "Allow for
session" does not exempt a spawn in auto mode. Dispatch targets inherit the asks.

### §3 Task lifecycle

The mapper sends `task-started` per run, `task-progress` per child step and a terminal `task-notification` with the run's
usage, run index, summary and background flag. A run is one call: `toolUseId` is the per-run call (a resume is a new
`subagent {sessionID}` call with its own card and roster row), `taskId` (the child session) ties runs together and
`runIndex` is the call's position. Usage is the sum of input, output and reasoning over the child's own steps in that
run (grandchildren count in their own runs). `wakesParent` is true on every run. A call that steers a still-running child
first settles the earlier call ("continued by a later call"). Cold history carries the same figures and seeding
remembers each child's calls, so a resume continues the count. A live background child holds the idle timer, which re-arms
when it ends.

### §4 Stop per subagent; no Send to background

`OpencodeSession.stopTask` interrupts the card's child and its live descendants, never siblings or the parent. The run ends
`stopped` unless it completed first; a stopped child that a background grandchild's completion wakes again is
interrupted again until a new call links it. The model is told the user stopped that agent so it does not re-spawn the
work: one host instruction per Stop to the root session ("Sent by ClaudeUI for you"), sent before the interrupt, as
user-role text (a non-user agent message would taint the session's origin and count against its agent-turn budget). It
carries nothing the model authored: the agent's type (a safe identifier, else `subagent`) and the call id, never the
description or prompt; the call id is quoted only when it matches `[A-Za-z0-9_.:-]{1,128}` (else "started by one of your
calls") and is worded "started by call <id>", since a nested call was made by the child. Teardown and parent interrupts
send no note. A Stop whose child interrupt cannot be sent is rolled back for the sessions not reached. `backgroundTasks`
is true; `backgroundTask` is not implemented, and a foreground run omits `isBackgrounded` so cards never offer "Send to
background": opencode's background route would move every blocked job of the turn, not the one card.

### §5 ClaudeUI's model allowlist holds for subagents

The plugin gates `subagent` in `execute.before`. It resolves the model the tool would run on (the call's `model`, then a
resumed same-agent child's own model, then the target agent's model, then a switched-to agent's missing model falls back
to the child's own stored one; a call with none of these inherits the already gated parent's model and passes). An off-list model throws a message naming the
allowed models and pointing at `claudeui_list_models`, which ClaudeUI hosts (the allowlisted models with their `#variant`
options; its description keeps opencode's rule: pass a model only when the user asks).

- **Stateless delivery.** The allowlist arrives as the plugin entry's options and joins the server's config identity;
  opencode evicts an idle location after an hour and re-runs `setup`, so a pushed copy would be lost. A change gives new
  leases a new server; an open session keeps its list until it reconnects.
- **Fail closed.** Missing options refuse a model-bearing call. The guard also reports `allowlistLoaded`; a false value
  logs a warning and does not refuse (the gate already fails closed per call).
- **One validation.** `loadOpencodeModelAllowlist` validates the shape once and every consumer trusts it: a present key
  always restricts (a lone string is a one-model list, an array keeps its string ids, any other value allows none of that
  provider) and each malformed entry logs a warning.
- Known gap: commands with `subtask: true` and a command's own model switch do not go through the `subagent` tool, so the
  model gate does not see them (they are started by the user).

### §6 Claude agent files: `effort` maps, `permissionMode` and `background` do not

The shim turns a file's top-level `effort` into `#<effort>` on `harness.opencode.model` when that model has no variant of
its own. It is not validated at injection (the shim's output keys the server, so it must be a pure function of the files
and the allowlist); the agent type catalog checks it against discovery (cached, else waits at most 2 s) and warns in
Settings, since an unknown variant fails every run of that agent. opencode agents have no `permissionMode` or default
`background` field, so neither is mapped. `experimental.subagent_depth` keeps opencode's default of 1.

## Retired

- ADR-019 — opencode engine backend: shared HTTP/SSE server, legacy API, tool maps — superseded by ADR-097 (2.x server lifecycle, §2; the 1.x per-cwd server and legacy API are gone).
- ADR-047 — Recycle pooled opencode servers on user-initiated credential changes — superseded by ADR-097 §5 (2.x hot-reloads credentials; no recycle).
