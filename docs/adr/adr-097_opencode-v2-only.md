# ADR-097: opencode moves to 2.x only

**Status:** Accepted (2026-10-06, owner; arc started with S0; S0–S9 built on the arc branch by
2026-10-07; S10a — the 1.x removal — built 2026-10-07; S10 real-app verification and the Windows
pass remain). It comes from the spike in
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
- [ADR-028](adr-028_opencode-native-config-in-place.md) (as built in S8: 2.x keys).
- [ADR-047](adr-047_opencode-server-recycle-on-auth-change.md) — superseded for opencode 2.x (no
  recycle on an auth change, §5).

Wire reference (as built): [`docs/protocol-opencode/`](../protocol-opencode/README.md).

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
- A `resource:"*"` + `deny` rule hides the tool from the model. The 1.x "whole-category deny goes
  last" transform must be re-verified against that rule (as built: `wireOrder`, S6).

**As built (S6, 2026-10-06).** `permission-keys.ts` is the key table (Claude tool → 2.x action →
how 2.x spells the resource); `permission-v2.ts` compiles and composes; `subagent-permissions.ts`
gains the child ruleset. Facts at 2.0.24 that drove it: `PATCH {permissions}` REPLACES (1.x
appended); a child copies the parent's WHOLE session ruleset, after its own agent's rules; a deny
answers with `permission.rejected` "Permission denied: <action>" and no rule dump; the deny check
runs before the project's SAVED "always" allows are appended, so a saved allow outranks any
session `ask` but never a `deny`; Code Mode's `execute` runtime has an ungated `fetch`.

- The session ruleset only tightens: mode gates (catch-all asks) → the user's compiled rules (auto:
  no allows except the `additionalDirectories` `external_directory` allows, which are the user's
  configured workspace; plan: no edit/shell/subagent allows) → plan enforcement → `{execute,*,deny}` →
  `claudeui_dispatch_agent` ask, whole-category denies moved last. No `{*: allow}` baseline (each
  agent has one natively), so a subagent's own narrowing holds for every action the session does not
  name. Consequences: `external_directory` keeps 2.x's default `ask` (opencode's own data/tmp/config
  dirs allowed; `additionalDirectories` compile to `<dir>/*` allows), and the user's own opencode
  config applies to the categories ClaudeUI does not gate.
- Wholly-denied decisions: a user deny on a whole tool → hidden (Claude Code parity); a narrow user
  deny → a server-side deny per call, tool visible (no longer an ask: no dump to avoid, and only a
  deny resists the saved table); mode gates never hide; plan mode hides `edit`/`write`/`patch` and
  denies the `general` subagent server-side (shell stays an ask for the host's read-only check);
  `execute` hidden in every mode; throwaway sessions `{*,*,deny}`.
- Paths (`permission-paths.ts`; review fix 2026-10-06): 2.x asks with the path relative to the
  session dir for any file in the session dir OR its git worktree (`../secrets/k` from a sub-dir
  session), absolute otherwise. Deny and ask rules therefore compile CONSERVATIVELY to every form
  the resolver can produce: the absolute form; `../`-relative forms against the session dir and each
  ancestor whose subtree the rule's literal prefix lies in (the worktree root is one of them; a form
  above the worktree only matches the same file); the glob part alone when the session dir lies
  inside the rule's glob (`//**/prod.yaml`); every `**/` also as zero directories (`**/x` → `x`);
  and a settings-relative `/x` resolved against the session dir and the worktree root (the merged
  rule set no longer knows its settings file; pi's loader also leaves `/x` unresolved, so there was
  nothing shared to reuse). Allows stay precise (absolute, plus relative only literally under the
  session dir; `/x` verbatim): an allow that misses costs an ask, never a grant. `~/`, `//abs`,
  `C:\x` and `./x` are normalized as before. Contract: a session in `<repo>/pkg` with
  `deny Edit(//<repo>/secrets/**)` cannot edit `../secrets/x`.
- Children: `childSessionRuleset(parentRules, agent.permissions)` = the parent's rules, then the
  child agent's own deny rules that still hold at the end of its ruleset (narrow ones included —
  `shell "git push*": deny` survives the parent's `shell` ask and a user allow; a deny the agent's
  own later allows carve is left out), then a whole-category deny for each action the parent opens
  and the agent wholly denies. The host PATCHes it on `session.created{parentID}`, on every parent
  re-apply (the child's copy is a snapshot) and on `session.agent.selected` (a resumed child can
  switch agent); `evaluateChildCall(agentRules, action, resource)` is the host's backstop for an
  ask that comes before the PATCH or that the agent carves itself. Live: the first request is built before the PATCH lands, the call after it (blocked).
  Static spawn asks and the `subagent:<name>` backstop are not needed in 2.x.
- Overlay (`agents.<name>.permissions`, the manager's default provider): `plan` denies `general`,
  which keeps it out of plan mode's subagent list.
- **Saved "always" allows are ignored (owner decision 2026-10-06).** The `claudeui-xeng` plugin's
  `permission.evaluate` hook (it runs after opencode's deny check, with the effect opencode computed
  from configured rules plus saved rows; its `effect` wins) re-reads the session (`ctx.session.get`)
  and its agent (`ctx.agent.get`; else the session's, else the default agent) by the hook's session
  id, evaluates `agent ++ session` rules with opencode's matcher, and keeps the STRICTER effect. It
  only tightens (allow → ask/deny; never back), leaves a deny untouched, and answers `ask` when it
  cannot read the rules. Saved rows therefore cannot answer a default-mode gate, the auto-mode judge's
  asks or plan-mode shell. Only the opencode process ClaudeUI spawns loads the plugin: the user's
  own opencode keeps honouring its saved rows, and ClaudeUI never deletes them.
- **The user's own MCP servers are direct (owner decision 2026-10-06).** A config overlay cannot set
  `codemode:false` on them: a later config document REPLACES the whole `mcp.servers.<name>` entry
  (`config/plugin/mcp.ts`), so the overlay would have to copy the entry, secrets included. The plugin
  instead registers an `mcp.transform` (the mechanism of opencode's own `mcp-codemode-defaults`)
  that sets `codemode:false` on every resolved server, in place, reading no names, headers or env.
  Their tools are offered as `<server>_<tool>` and go through ClaudeUI's approvals and `mcp__` rules;
  `execute` stays hidden. The transform runs after opencode's config transform (registration order),
  verified live with a server defined only in the user's global config.
- **The plugin is required (fail closed; review fix).** The plugin answers a `guard` RPC
  (`POST /api/rpc/claudeui-xeng/guard` → `{permissionHook, mcpDirect}`, set once both hooks are
  registered). Every turn-running `acquire` probes it per (server, directory) alongside tool
  readiness and throws `OpencodePermissionGuardError` (lease released, a server with no other lease
  ended) when the plugin is missing from the build or does not confirm both hooks within 10 s — a
  clear error, never a silent downgrade. Only an `active` answer is cached. The `mcp-status` fallback
  still gates TOOL readiness but never stands in for the guard. Turn-less acquires (session lists,
  auth, usage reads) skip it; throwaway sessions run `{*,*,deny}`, which saved rows cannot
  answer.
- **MCP allows never land on a built-in (review fix).** A tool-level MCP allow whose action is a 2.x
  built-in (`mcp__external__directory` → `external_directory`) is refused like a server-level one;
  its deny/ask is kept (they only tighten). Sanitizer collisions between servers (`a.b` / `a_b`)
  share an action, as in 2.x itself.
- **Auto mode gates every MCP tool (review fix).** 2.x names an MCP tool's action
  `<server>_<tool>` (`tool/mcp.ts`), so auto mode carries a catch-all `{*_*, *, ask}`: a server
  unknown when the rules were sent (a late connect, or the user's own config made direct by the
  plugin) is judged too. After it: `claudeui_*` allowed (hosted tools; the dispatch ask comes later),
  `external_directory` ask, and the agent's allows for opencode's own data/tmp/config directories,
  which the host passes in (`opencodeOwnDirAllows(Agent_Info.permissions)`) — without them those
  reads ask the judge. The `opencode_*` built-ins with `_` are Code Mode tools, unreachable while
  `execute` is hidden. Residual: under `explore` the catch-all overlaps its own `external_directory`
  ask, so an MCP call there asks (judged) instead of being hidden.

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

**As built (S9, 2026-10-07): opencode as a dispatch target and source.**

- **Targets on the 2.x stack.** The dispatcher's `DispatchTargetClient` is a structural `Pick` of
  `OpencodeClient`; `serverManager` is `{acquire, releaseIfCurrent, subscribeExit}` and
  `makeClient(conn)`. Each target takes its OWN turn-running lease (the plugin guard is required)
  and releases it EXACTLY; the event feed is shared PER SERVER (`serverKey` = URL + password), so a
  config change while a target lives can no longer pair one server's client with another's lease
  (the S2 finding). A record outlives targets still being created on it, and a server exit or a lost
  feed fails the turn in flight and drops that server's targets (after a best-effort interrupt);
  their sessions are deleted through the next target's server when theirs is gone. A creation that
  outlives its feed, or its dispatching chat (`disposeFor` meanwhile), fails and rolls back (session
  deleted, lease released).
- **A target** is created with its ruleset, agent and model in the body, titled `xeng-dispatch`.
  The ruleset is the session's `buildSessionRuleset` over the user's deny/ask rules only (ADR-085
  §3; never allows or additional directories), then `{claudeui_dispatch_agent,*,deny}` (ADR-033 §4)
  and `{question,*,deny}` (a headless target has nobody to answer; a form that still arrives is
  cancelled WITH a message). Every turn re-applies the LIVE mode's ruleset (PATCH replaces, so the
  1.x "creation-time snapshot" residual is gone) and switches the agent (`plan`), fail closed; and a
  mode switch DURING a turn re-applies at once (polled every 250 ms while busy, as a chat PATCHes on
  `setPermissionMode`; the plugin re-reads the session's rules on every ask — a re-apply that fails
  ends the turn). It runs the ChatGPT pre-turn gate (§5 rule 2), then posts an inbox prompt
  (`steer`, a ClaudeUI id) — never once a Stop or the caller's abort has fired.
- **The turn** is followed through the target's own S4 mapper on the shared feed (reconnects re-read
  through `reconcileAfterReconnect`). It has STARTED when its own inbox item is delivered
  (`session.inbox.delivered`, or its user row on a re-read — opencode publishes `InboxDelivered` for
  every promoted user item, `core/src/session/inbox.ts`), whether it opened an execution or was
  steered into one already running (a parent woken by a background subagent's completion, a give-up
  still winding down — no `execution.started` of its own; review S9 #2). Only a terminal output
  after that settles it (closing the 1.x "a stale idle settles the next turn" residual). Its text is
  the last own step that said something; its usage is every step's, children's included (one ledger
  row, priced per step by `opencodeMessageCosts`); a step OUTSIDE any dispatch turn (a woken
  execution, a step after a give-up) is metered too, as a row of its own against the cap and the
  breakdown. `provider.auth` calls the vault's `authFailed`.
- **Give-ups** (Stop, timeout, the caller's abort, a refused prompt; review S9 #1): the target
  DRAINS — the turn's prompt POST, when one is in flight, is awaited (bounded), then the session and
  followed children are interrupted and that prompt's inbox item cancelled (`stopOpencodeSessions`,
  which also re-interrupts a session still active while it waits); an execution that starts while
  draining is interrupted again; the next turn waits for it all to settle. Dispose also deletes the
  session (shared data dir) before the lease goes. A stop or cancel records a ledger row only when
  the turn already spent something; a timeout always does.
- **Asks** — refused WITH a message whenever no dispatch turn is running (idle, or draining): nobody
  is waiting, so never judged or carded. Otherwise the same ladder as a chat, minus session allows:
  a child's ask its own agent denies is
  refused (`child-rulesets.ts`, extracted from `OpencodeSession` and shared — the S6 child PATCHes
  run for targets too); then `hostPrecheck` (the user's deny rules, plan mode, the user's ask rules
  → the human in every mode); then ClaudeUI's judge under a judged auto parent (ADR-088), else a card
  on the dispatching chat. Replies go to the asking session, never `always`, every reject with a
  message. A target's child streams nothing onto the card (as in 1.x).
- **Source identity.** Unchanged precedence (`_meta` first). New: a subagent CHILD calling
  `dispatch_agent` is named by `_meta` as the child; the hosted tool walks `parentID` (up to 8
  levels, `GET /api/session/{id}`) to the ClaudeUI chat it descends from, and the dispatch belongs to
  that chat (`fromRoutingId`). No ClaudeUI ancestor (a target's own child, a foreign session) → the
  call is refused. Contract: `[subdispatch]` in the manager suite.
- **A subagent caller's own restriction (owner decision 2026-10-07, option a).** When the caller is a
  subagent child, the target runs under the chat's mode and rules PLUS the calling agent's own deny
  and ask rules (every child agent on the way up, for a grandchild): `caller-restriction.ts` reads
  each agent's ruleset (`GET /api/agent` in the child's directory; unreadable → the call is refused,
  fail closed) and maps it, with the plugin's child-agent floor semantics (the agent's rules alone,
  last match wins, no match = ask), to Claude-form rules — the vocabulary every target engine already
  compiles the user's deny/ask tiers from (Claude `--settings`, pi/Codex permission engine, opencode
  `compileClaudeRulesV2`). Only ever tighter: deny and ask only; a deny with no exact equivalent is
  the whole category (a shell glob program, a URL host glob, glob/grep/subagent/skill resources,
  `external_directory` → every file and shell tool); an MCP rule restricts the whole server (the
  `<server>_<tool>` split is ambiguous); `external_directory` asks are not mapped (targets get no
  additional directories). Code Mode's `execute` is not mapped: every ClaudeUI session denies it, so
  an agent's own `execute` rule never decides what a child does. The restriction rides
  `DispatchContext.callerRestriction`, is merged into the target's user rules on every engine, is
  named in the judge's subagent header ("dispatched by the … subagent, which may not: …") on top of
  being in its permission-rule context, and sticks to the target: a continuation from a caller the
  target's restriction does not cover is refused (start a fresh dispatch). opencode → opencode
  dispatch stays refused (same engine), so the contract proves the two halves: a real `general`
  child (configured `edit: deny`) carries the restriction, and an opencode target given it has no
  edit tool and leaves the file untouched.
- **Shared pieces** (S5 code, not duplicated): `child-rulesets.ts` (`ChildRulesetKeeper`) and
  `session-support.ts` (`stopOpencodeSessions`, `locationWorktree`); `OpencodeSession` uses them too.

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

**As built (S7, 2026-10-07).**

- **One owner of ClaudeUI's rows.** `OpencodeCredentialStore` (`core/opencode/credential-store.ts`,
  singleton in `opencode-credentials.ts` on the pooled server for ClaudeUI's own directory, a lease
  per operation, operations serialized) is the only writer. A slot is (integration, value type):
  keys `cred_claudeui_<integration>_v<n>` (label `claudeui:key`), ChatGPT
  `cred_claudeui_<account>_v<n>` (label `claudeui:chatgpt`, stems lowercased to `[a-z0-9-]`). A vend
  lists, re-activates a matching row or POSTs the next generation `activate:true`, THEN deletes
  every other generation of the slot — so any vend (boot included) also prunes what a crash between
  POST and DELETE left. Nothing else is ever deleted, rotated or relabelled.
- **ClaudeUI's record** (`~/.claude/ui/opencode-credential-slots.json`, ids and flags only, 0600,
  wired at the boot seam; memory in tests): each slot ClaudeUI may hold, written before the POST,
  with the non-ClaudeUI row it displaced (`previousActive`). Removal re-activates that row FIRST
  (opencode's delete-of-active promotes the newest row), but only when ClaudeUI held the slot (a
  user sign-in that took it later stays active); a later user sign-in is logged and re-taken by
  the next vend, which then remembers it. A removal of a slot never recorded starts no server
  (the boot sweeps); an explicit disconnect looks anyway (`force`). With opencode not installed a
  removal is recorded (`pendingRemoval`) and runs before the next store operation once it is —
  ADR-082 S7d's "at once" as far as opencode allows; there is no file to edit any more. A corrupt
  record file is moved aside (`.corrupt-<ms>`), logged, and rebuilt from the live
  `cred_claudeui_*` rows; it never blocks a vend. Whether ClaudeUI holds a removable key is
  answered from this record (no server). A ChatGPT vend older than the slot's row of the same
  account (a gate's re-vend queued behind a refresh) is skipped.
- **The imported copy of ClaudeUI's 1.x sign-in.** A non-ClaudeUI OAuth row whose refresh token
  is the vault's or one ClaudeUI fed the 1.x `auth.json` (the fed-token history, now only READ for
  opencode). Recognition lives IN the store (`isClaudeuiToken`, wired at the boot seam), so every
  vend and removal — keys included — applies it: such a row is never remembered or restored, and
  NO removal promotes it (review H1): when the row opencode would activate after the DELETE is a
  copy, ClaudeUI's padded, never-refreshed row stays active and recorded instead — on quit, at
  start, on a disabled route, on an arrival, for a pending removal. Only emptying the vault
  (disconnect, last account removed) deletes it anyway and logs the fallback; the contract shows
  opencode then tries to refresh the copy at once.
- **Proven copies are deleted (owner decision 2026-10-07, option a).** Every non-ClaudeUI row
  PROVEN to be a copy of ClaudeUI's sign-in (its refresh token is the vault's or in the 1.x
  fed-token history — the store's recogniser) is deleted: on every new server, through the
  server manager's first-contact hook (`installCopyCleanupHook` → `setServerStartedHook`, wired
  unconditionally at import of `opencode-credentials.ts`); and by the first store operation of
  each ClaudeUI process, before it vends (marked done only when it succeeded). Unproven rows are
  never touched. Each deletion is logged by id and reason; the slot file records the last run
  that deleted something (`copyCleanup: {at, count, ids}`; empty runs do not overwrite it). The
  H1/M1 guard stays for a copy that appears later. Probed on 2.0.24 (recording proxy): opencode
  resolves — and so may refresh — the active OAuth credential only when a LOCATION activates its
  plugins (the openai plugin's `load()`, `integration.ts` `connection.resolve`), never at server
  boot and never on a `/api/credential` route, even one carrying `x-opencode-directory`. The hook
  uses only those routes. **Fail closed (review s7b):** a server whose cleanup failed or timed
  out (5 s per run) is "uncleaned" and serves only leases that ask for credential routes
  (`acquire({credentialRoutesOnly})`, the credential store's); every other acquire (turns,
  discovery, auth reads, a config reload, a detached server) first retries the cleanup with
  back-off (0.5 s, 1.5 s; a stuck run is replaced) and, if it still fails, throws
  `OpencodeCredentialCleanupError` (a later acquire retries). The hook refuses to run without the
  recogniser, so a server never counts as clean before the vault is wired. So no ClaudeUI server
  makes a location request before the cleanup succeeded. Residual: a 2.x process that is not
  ClaudeUI's (the user's own opencode, the 2026-10-06 leak) can still resolve and refresh an
  expired active copy before ClaudeUI first connects.
- **Sign-ins started from ClaudeUI are ClaudeUI's (owner decision 2026-10-07).** An OAuth sign-in
  the user starts from ClaudeUI's opencode provider screen runs on opencode's connect flow with a
  one-off label (`claudeui:signin:<16 hex>`); opencode stores an attempt's label on the row it
  creates (`integration.ts` `createCredential`), so the row with that label — and only it — is
  recorded by its opencode-chosen id (slot kind `signin`, with the row active before it) and
  relabelled `ClaudeUI sign-in · <hex>` (it keeps the attempt's id). Race-free against the
  user's own concurrent opencode (a before/after diff of the list is not: their sign-in could land
  in the same window, as the contract shows). Every generated label is kept in a sibling ledger
  (`opencode-credential-slots.signins.json`, ids only) from BEFORE the flow starts: a row a
  flow creates after its hold expired is adopted by its exact label on a later store operation;
  a pending label expires after 1 h. A quarantined slot file is rebuilt from that ledger (by the
  remembered id, or the exact label carrying a remembered hex) — never from a label alone; with
  the ledger gone too, such rows fail safe as the user's. Such rows are owned like
  `cred_claudeui_*` for removal and active-slot remember/restore, and never taken for a copy; the
  provider screen's Remove takes them (`removeVendorAuth`), a shared provider's route removal does
  not (`removeVendorKey`). API keys stay ClaudeUI's own `cred_claudeui_*` rows (no connect flow).
- **ChatGPT.** `refresh:""`, `methodID:"chatgpt-browser"`, `metadata.accountID` (JWT claim when
  the vault has none; refused without one), `expires` = JWT `exp` + 24 h. The process keeps the
  token's REAL expiry (`vendedChatgpt`). CredentialSync: opencode is no longer watched, read at
  start or adopted from, and records no fed tokens; `start` vends the active account (no
  credential → removes ClaudeUI's rows); an expired token is never vended (the refresh that
  follows vends). One expiry drives every opencode decision: the earlier of the JWT `exp` and the
  vault's (`tokenExpiry`). `opencodeTurnGate` (wired through `opencode-auth-hooks.ts`, called
  inside the session's establishing window so a queued item cannot overtake the turn) passes
  with more than 15 min left, else refreshes (≤15 min left) or re-vends; a needs-sign-in account is not
  refreshed; a token still expired after a failed refresh marks needs-sign-in; otherwise the turn
  is held with `session:auth-required` and the reason, and nothing is posted, queued items
  included. `provider.auth` on an `openai` turn → `opencodeAuthFailed` → immediate refresh +
  rotate (60 s cooldown; not while in back-off or needing a sign-in). `powerMonitor`
  resume/unlock → re-schedule healthy accounts from the wall clock (back-off and needs-sign-in
  kept) + the gate. Graceful quit → `QuitCoordinator.prepareQuit` (bounded 4 s, before teardown;
  a second quit meanwhile is vetoed): timers stop and nothing re-vends, then the slot is given
  back (activate the user's row, delete inactive generations, the active one last — a cut leaves
  a consistent state the next start finishes). Errors on every credential path are logged
  redacted (`redact-secrets.ts`: bearers, JWTs, keys, secret JSON fields, long opaque runs;
  capped).
  Contract: an expired bearer that chatgpt.com rejects (401) surfaces as
  `session.execution.failed {type:"provider.auth"}`, and a rotation recovers without a restart;
  with padding off, a token inside opencode's 5-min window makes opencode CONNECT
  auth.openai.com (refused) and the turn fail — with padding, zero attempts.
- **OpencodeAuthProvider** reads `/api/integration` + `/api/provider` + the credential snapshot
  (types, ownership and ADR-071 identities of each integration's ACTIVE row, never a value);
  `listVendorCredentialIds` = active row types; Remove (provider manager, shared-provider removals)
  deletes ClaudeUI's key rows only; OAuth sign-ins run on opencode's integration flows
  (`integration.oauth.connect`, `.complete`, `.status`, `.cancel`), held on the server the
  attempt lives in; the row it creates is recorded as ClaudeUI's (above). No `auth.json` read
  or write (`auth-store.ts` deleted), no `recycleAll()` caller. ADR-074 §6 adoption reads opencode's ACTIVE
  key rows in ONE credential list per pass (`batchedApiKeyReader`, 5 s memo dropped on any
  ClaudeUI change; `NativeApiKeyReader` may answer asynchronously). Read-only leases (credential,
  catalog, auth reads) leave the pooled server idle for `READ_LINGER_MS` (60 s) after the last
  one, so a burst of reads starts one server.
- **Discovery** (`model-discovery.ts`): one probe of `/api/integration` + `/api/provider` +
  `/api/model`, always on ClaudeUI's own (global) server — eager connect too, so a project's
  config never reaches the global catalog (with the same config it is the session's own server
  anyway, one per config); an empty model list is re-read every 300 ms until
  `modelListIsAuthoritative` (contract: a location the barrier did not warm answers 0 first), and
  a warm, authoritative empty answer is kept 30 s (`EMPTY_CATALOG_TTL_MS`), never a cold one. Variants are the reasoning variants; free =
  zen gateway with every cost tier zero (ChatGPT mode's `cost:[]` is not free); vision from
  `capabilities.input`. The "add provider" catalog is the integration list; model counts exist for
  usable providers only. The judge route accepts 2.x's
  `@opencode/ai/providers/openai-compatible`.

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

  **As built (S9).** One paged `GET /api/session?parentID=null` with NO directory: 2.x's list is
  global, so a single request covers every cwd (`directory` narrows it — `readOpencodeSessions`
  takes one, the contract proves both). Archived sessions are left out; the cwd is
  `location.directory`; dispatch targets and ClaudeUI's throwaways (`xeng-dispatch`,
  `side-question`, `agent-generate`) are not listed. The sidebar never waits for a server:
  `listOpencodeSessionsGlobal` serves the last listing at once — measured 0.001 ms median / 0.008 ms
  p95 for 2 000 cached rows with a refresh hanging, plus ~1 ms to clone the payload — and kicks a
  background refresh: one in flight at a time (concurrent triggers share it), at most every 20 s,
  all server I/O asynchronous in main, ONE `session:directories-changed` when it lands
  (`onOpencodeSessionListChanged` → `refreshCanonicalDirectories`).
  **Spawn policy `onInteraction` (owner decision 2026-10-07):** a refresh may START a server only for
  the first listing of the process, and afterwards only on an interaction — the sidebar opening or
  the app coming to the front (the renderer's `session:list-opencode` nudge, never awaited) — when the
  listing is older than 5 min. Every other refresh only RIDES a running server, and any live one
  does (`acquireIfRunning(…, {anyConfig: true})`: the routes are global, so a project with its own
  MCP config never costs a second server); history and delete ride one too and start one only when
  none runs. A failed start or read backs off exponentially (40 s, 80 s, … capped at 30 min). The
  usage reconciler never starts a server: it rides one or skips the round. Not installed → [] and
  no server. The direct reader (`db.ts readOpencodeSessionRows`) is deleted. Residual: sessions the
  user's own opencode creates while ClaudeUI runs no server show at the next interaction on a stale
  listing.

- The first `/api/model` after a server boot can be empty (cold location; full at +1.5 s), so
  discovery must not negative-cache it (ADR-092).

**As built (S8, 2026-10-07): config on 2.x keys** (amends ADR-028/029/031; the user's file stays
theirs, ClaudeUI still writes only through its editors).

- **Write 2.x keys only; read both shapes.** 2.x normalizes a 1.x file in memory
  (`config/normalize.ts`), and keeps a 2.x map entry WHOLE over a 1.x entry of the same id
  (`conflict` diagnostic, the 1.x fields dropped). So an entry ClaudeUI edits moves WHOLE to its 2.x
  key in the form 2.x reads it (`shared/opencode-config-v1.ts`, a port of upstream's
  `ConfigMigrateV1`, EXACT: a move changes nothing 2.x runs on; review F4); entries nobody edits
  stay 1.x and are SHOWN as 2.x reads them; the moved entry's comments are gathered above it; an
  emptied 1.x map stays `{}`. A 1.x `mode.<name>` replaces `agent.<name>` as in 2.x. Same for a markdown agent (any non-2.x front-matter key makes 2.x
  decode the WHOLE file as 1.x and send unknown keys to the request body), `attachment` → `media`,
  `snapshot` → `snapshots`, 1.x `compaction`/`experimental.mcp_timeout`/`plugin`/`skills{}` leaves.
  A SET of a path the generated 2.x schema lacks is refused; deleting a 1.x leaf is allowed. Proven
  live: the moved file logs no normalization diagnostic.
- **Key mapping.** `small_model` → `agents.title.model`; `disabled_providers`/`enabled_providers` →
  `experimental.policies` `provider.use` rules (last match wins; a re-enabled id a wildcard still
  denies gets a literal allow; `enabled_providers: []` = deny all, shown as an empty allowlist); `provider.<id>` → `providers.<id>` (`npm` → `package: aisdk:<npm>`,
  `options` → `settings`/`headers`/`body`, `api` → `settings.baseURL`); model `tool_call`/`modalities`
  → `capabilities.tools/input/output`; the inert 1.x `attachment`/`reasoning`/`temperature` are
  dropped on a move (as 2.x drops them) and written as `capabilities.input` / `variants: []` only when
  the user edits that field (`reasoning:false` never overwrites a non-empty `variants`); `interleaved` →
  `compatibility`, `cost` → list with tiers, `status: deprecated` → `disabled`; agent `prompt` →
  `system`/body, `temperature`/`top_p`/`options`/unknown → `request.body`, `permission`/`tools` →
  `permissions` rules (bash→shell, task→subagent, write/patch→edit), `disable` → `disabled`,
  `maxSteps` → `steps`; built-in tool switches → top-level `{action,*,deny}` in `permissions`
  (own writer). "Off" is upstream's `whollyDisabled` (the last rule matching the action is a `*`
  deny); ON removes only the rule ClaudeUI's switch wrote (recorded in `engines/opencode.json`),
  never a user rule, and never adds an allow. Top-level rules precede a config agent's own rules,
  so the pane names the agents whose own rules still offer the tool.
- **Agents (ADR-029).** Markdown files stay the storage, written in 2.x front matter. The grid NEVER
  reorders rules (2.x is last-match-wins; review F1): an action's last `{action,"*"}` rule is edited
  in place; a new ask/deny is inserted right after the last catch-all already deciding that action
  (so narrower rules after it still win); `allow` with no rule adds none; a save with no change
  leaves the list byte-identical (property-tested; proven live on the 1.x "allow all but bash"
  shape). Unmodelled fields (`request.headers`, other body keys) carry over; a rename/scope move
  carries ONE file and deletes only that one. A built-in override with no prompt is written as
  `agents.<name>` in the scope's config file, since a markdown agent always sets `system` to its
  (empty) body. Reasoning effort = model variant (`model: p/m#effort`, needs a model). Invalid
  values 2.x would silently drop the whole agent for (non-`p/m` model, non-hex colour, steps ≤ 0)
  are refused.
- **Not expressible any more (shown in the UI, not offered):** the per-model temperature flag, a
  `reasoning: true` flag (a reasoning model is one with no `variants`), `compaction.prune`/
  `tail_turns`, `logLevel`, `experimental.batch_tool`, `continue_loop_on_deny`; theme-name agent
  colours.
- **Raw editor.** `src/shared/opencode-config-schema.json` is generated from the pinned
  `Config.InfoEncoded` by `generate-opencode-protocol.mjs` (provenance + `check-opencode-protocol`
  cover drift); validation covers the touched top-level keys only. An `mcp.timeout` edit moves the
  1.x `experimental.mcp_timeout` into whichever of catalog/execution is unset.
- **Writes are conflict-aware and atomic.** A settings pane sends the snapshot it edited
  (`saveOpencodeSettings(settings, base)`): only its changes relative to that snapshot land on the
  file as it is now (`rebaseFields`), so a provider or veto added meanwhile survives. Every write is
  temp file + rename (mode kept, symlinks followed). Shared modules never read `process` (they run
  in the renderer and the web client); the platform is passed in.
- **Reload.** Every ClaudeUI write notifies `onOpencodeConfigWritten`; the boot seam debounces
  `OpencodeServerManager.reloadConfig()`: per pooled server, `POST /api/location/reload` then
  hosted-tools readiness per held directory (guard memo dropped), model cache invalidated, sessions
  drop their agent list. **A server with a running execution is NOT reloaded** — a reload cancels
  pending asks/forms ("Interaction cancelled because the location shut down"; proven live) —
  opencode's own config watcher applies config documents and agent files there (~0.5 s, proven
  live). Residual: an execution starting inside the check→reload window can lose an ask.

### 7. Wire layer

- Types are generated from the pinned `packages/protocol/openapi.json` by a repo script
  (`scripts/generate-opencode-protocol.mjs`, no new dependency; the spike prototype passes
  `tsc --strict`).
- The generated file is committed with provenance (tag and spec SHA). CI fails on drift.
- No `@opencode/client` dependency.

**As built (S3, 2026-10-06).** `OpencodeClient` is a typed client over the generated
`OPERATIONS`: Basic auth and a URI-encoded `x-opencode-directory` on every request, typed
`OpencodeApiError` per operation, 60 s control-plane timeout, and `generate` at 240 s (under
undici's 300 s `headersTimeout`). A permission reject without a message does not compile, and a
blank one throws before sending. Findings: `session.create` ignores the directory header (the
client always sends `location`); a directory's catalogs (agents, commands, skills, models,
providers) answer empty for about 100-250 ms until its plugins load, so the client awaits
`integration.list` once per directory before the first catalog read; re-posting a prompt id is
idempotent within a session. The event feed has no replay: it yields `connected` with
`reconnected:true` before any event of a new subscription, and the consumer re-reads messages,
permissions, forms, inbox and active sessions. The server's 15 s heartbeat keeps the 45 s stall
watchdog quiet on idle sessions. The 1.x client survived as `OpencodeV1Client` until S10a deleted
it.

**As built (S4, 2026-10-06).** Each chat gets one `OpencodeEventMapper` (`event-mapper.ts`),
which maps the feed to the engine-neutral stream. Cold history (`history.ts`) shares its content
helpers, and recorded 2.0.24 sequences plus contract cases hold it equal to what streamed live.

- **Content.** One assistant message per step. Blocks come in started order, and an empty text or
  thinking block is never placed. Text and thinking stream as item open/delta/seal.
- **Tool results.** Each call gets one result, with diffs and images.
- **Children.** A child links by `tool.progress.metadata.sessionID`; events it sends before that
  are held and replayed. Each step is attributed to the call that started it, so a child resumed
  by a later call keeps its earlier runs under the earlier call. Cold history splits the child's
  rows by call start the same way.
- **Notifications.** Each subagent call gets exactly one terminal notification, in either order of
  child end and background return.
- **Turn ends (ADR-090).**
  - A user stop is `stopped/user`.
  - A messageless reject is `stopped/denied` and a messageless form cancel is
    `stopped/form-cancelled`. In both, the declined call fails `aborted` and then
    `interrupted{shutdown}` follows. A reject or cancel that carries a message does not change how
    the turn ends.
  - Every card of an ended execution is retracted, because an interrupt drops pending asks without
    publishing `permission.replied`.
  - Because `shutdown` keeps the execution claim, opencode resumes such a turn on its next start.
    Every reject and form cancel therefore carries a message.
- **Usage.** The rule matches Claude's status line, which folds in subagent usage. It counts the
  session's and its children's steps, each compaction's request, and the session's remainder
  against its cumulative (title generation). The live path reports the remainder as
  `overhead-usage`; the cold path computes it from `GET /api/session/:id`.
- **Shell output.** 2.x pushes no shell output. `tool.progress` carries only the `shellID`.
  `ShellOutputPoller` pages `/api/shell/{id}/output` from the tail, sleeping between reads. It
  re-reads the bytes of a character cut at a page end, because the server decodes each page on
  its own. It stops when the shell exits.
- **Reconnect.** `reconcileAfterReconnect` reads `active` first, then messages, permissions, forms
  and the inbox for every followed session. It applies them idempotently by message, call,
  request, inbox and idle-row id.
- **Todo panel.** It has no 2.x source and stays hidden.

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

**As built (S5, 2026-10-07).** `OpencodeSession` runs on the 2.x client, feed and mapper; the 1.x
session survived verbatim as `OpencodeV1Session` (with its tests) until S10a deleted it.

- **Lifecycle.** A turn-running `acquire` (so a missing `claudeui-xeng` guard fails the turn with
  `OpencodePermissionGuardError`'s text), one `OpencodeClient` for the chat's directory, one
  `OpencodeEventMapper` per chat and one feed. A new session is created with its ruleset, agent and
  model in the body. A resumed one is read once (cold history → the judge's transcript and the
  replayed rows, `opencodeHistorySeed` with the session totals, `mapper.seed`), and its feed's
  first `connected` runs `reconcileAfterReconnect` exactly like a gap, which also surfaces asks
  left pending. A prompt that arrives while an eager resume still replays waits for it (the
  mapper is seeded before the feed starts). Every mapper output goes to the existing channels;
  `stopped/user` is a turn end with no banner (ADR-090), `shutdown`/`superseded`/`inactivity`
  ends add a `session:warning`.
- **Queue on the inbox.** Every prompt carries a ClaudeUI id (`msg_claudeui_<32 hex>`). A prompt
  typed while a turn runs stays ADR-053's queue item (card, ArrowUp take-back), but it is posted
  at once with `delivery:'steer'`: ADR-053 §1's timing (the next step boundary; `queue` would hold
  it until the turn ends, which ADR-053 rejected). `delivered` consumes the item, `cancelled`
  recalls it. Take-back is `DELETE …/inbox/:id` after the item's own POST settled; opencode
  answers 204 even for a delivered item, so the stored row (`GET …/message/:id`) decides. Posts
  are serialized, so a queued item never overtakes its turn's prompt. `setQueuedItemDelivery`
  (PATCH, steer↔queue) and `dequeueItem` exist engine-side; the renderer still has recall-all
  only. Stop is `interrupt {resume:true}` (queued steers still run, as 1.x flushed them).
- **Teardown (review fix).** Every end of a lease on a live server — `cancel()` and a feed that
  gave up alike — first interrupts the own session and every child whose call is still open,
  running or not (an idle interrupt is a no-op upstream; a background child or a turn ClaudeUI
  has not seen still holds a claim), cancels ClaudeUI's undelivered inbox items, and waits until
  `GET /api/session/active` lists none of them (the interrupt route answers before its cleanup
  settles), bounded at 5 s; only then is the lease released. A last-lease release ends the server,
  and a shutdown keeps a running execution's claim (opencode would resume it headless). After a
  give-up the mapper also forgets its open requests with the cards, so the next connect's re-read
  raises an ask the server still holds again. After a teardown or a resume, ClaudeUI items
  nothing stands behind are cancelled on the next connect.
- **Approvals.** The 1.x ladder unchanged (host pre-check on `asHostPrecheckRules`, session allows,
  the judge pipeline, holds); the 1.x parent rung is not used (children inherit the rules).
  Replies go to the asking session. Every reject carries a message (default "The user denied this
  tool call"), every form cancel too, and `OpencodeClient.cancelForm` now refuses a blank one like
  `replyPermission`. 2.x publishes `tool.called` before it runs the tool, so asks carry the real
  input and the 1.x input wait is gone. Forms reply `{<key>: value}` with the option VALUE.
- **Children.** Two layers.
  - **The plugin holds the agent's own rules (review fix).** A child is created with the parent's
    whole ruleset after its agent's rules, and its first prompt goes out in the same effect, so a
    parent allow outranks the agent's deny until ClaudeUI's PATCH lands. A deny the agent carves
    itself (`git *` deny, then `git status*` allow) cannot be restored by any child ruleset.
    `claudeui-xeng`'s `permission.evaluate` therefore also evaluates a child's (`parentID`)
    agent rules ALONE on every call, allows included: their `deny` is a deny, their `ask` turns
    an allow into an ask; tighten-only, unreadable rules → `ask`. Contract: with ClaudeUI's child
    PATCH held, the child's first call (a read its agent denies) is blocked.
  - **ClaudeUI PATCHes `childSessionRuleset(parent, agent)`** on `session.created{parentID}`,
    on the child's `session.agent.selected`, and on every parent apply for every known child
    computed from another parent ruleset (settled ones too: a later call can resume them by
    `sessionID`). A resumed chat lists its stored children (`GET /api/session?parentID=`) and
    brings them along. The children loop runs before `switchAgent`, so a failed switch neither
    skips it nor stops a later apply from retrying. PATCHes are serialized per child and read the
    parent's rules after every await. A PATCH that fails twice fails closed: the child is
    interrupted and its asks are refused. `evaluateChildCall` also refuses a child ask its own
    agent denies. Permission applies are serialized too (a mode switch racing a turn's establish).
- **Usage.** Each `step-usage` (own and child) is a ledger row and counts in the headline, as do
  compaction requests and `overhead-usage`; only own steps move the context meter.
- **Side question / agent generation.** `generate` (240 s): on the chat's own session when it
  exists (never switching a running turn's model), else on a throwaway created with
  `THROWAWAY_RULESET`; agent generation creates its throwaway with the ruleset and model in the
  body and sends the meta-prompt in the prompt text. A throwaway is deleted (awaited) before the
  lease ends: the data dir is shared with the user's own opencode.
- **Synthetic items** (plan reminders, notices) are neither rendered live nor cold.

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

**As built (S10a, 2026-10-07): the 1.x code paths are gone.** Deleted, with their tests: the 1.x
client and session (`OpencodeV1Client`, `OpencodeV1Session`), the 1.x event mapper and its
stored-message converter, the 1.x wire types (`core/opencode/protocol/`, with the 1.18.9 doc
snapshot), the 1.x ruleset builders (`permission-ruleset.ts`: `buildRuleset`,
`buildAutoModeRuleset`, `opencodeWireRuleset`), the 1.x compiler half of `permission-compiler.ts`
(`compileClaudeRulesToOpencode`, `withoutAllowRules`, `withoutMutatingAllowRules`, the 1.x
built-in key list), the spawn-time subagent asks and the `task:<name>` backstop
(`subagent-permissions.ts` 1.x half, `opencode-config-permissions.ts` and its raw front-matter
scan), the host pre-check's parent rung (`parentRuleset` / `childGatedCategories`, the
`parent-allow` verdict, `evaluateOpencodeAsk`), the 1.x status-line seed over stored messages,
`OpencodeServerManager.recycleAll` / `acquireDetached` / cwd-only `release(cwd)` (no caller left;
`releaseIfCurrent` is the one release), the dead 1.x tool-kind map, the 1.x integration suite
(`OPENCODE_INTEGRATION_TESTS`; every case it held has a 2.x contract: server smoke → `client`,
MCP connect → `mcp-identity` / `server-manager`, recycle and detached discovery → obsolete) and
`scripts/probe-opencode-caps.mjs` (1.x `/config/providers`).

- Ported rather than dropped: the history status-line tests (to 2.x rows), the host pre-check
  tests (to `compileClaudeRulesV2` rules and 2.x tool ids), and the cross-engine permission
  conformance matrix (`src/main/__tests__/permission-conformance.test.ts`, now the 2.x session
  ruleset under the agents' default rules, evaluated by a port of 2.x `Permission.evaluate`).
- Renamed where the 1.x sibling is gone: `v2-event-mapper.ts` → `event-mapper.ts`, `v2-history.ts`
  → `history.ts`, `v2-content.ts` → `content.ts`, `v2-reconnect.ts` → `reconnect.ts` (+ tests),
  the `opencodeV2History*` seed functions → `opencodeHistory*`, and `src/integration/opencode-v2/`
  → `src/integration/opencode/`. Kept: `protocol-v2/` (generator output path, ~50 importers),
  `permission-v2.ts` and its `…V2` symbols, the `OPENCODE_V2_*` contract-suite variables and the
  `fixtures/opencode-v2/` recordings. `CLAUDEUI_MCP_SERVER` moved to `permission-v2.ts`.
- `opencode-pricing.ts` stays on models.dev, not 2.x `GET /api/model`: it had no 1.x route left
  (ADR-071 §5 moved it off `/config/providers`), and `/api/model` zeroes every model a ChatGPT
  plan covers (`cost: []`) and lists usable providers only.
- Still read on purpose (2.x behaviour, not 1.x paths): 1.x-shaped config files (S8), 1.x tool
  names in a migrated session's history (S4), and the opencode entries of the fed-token history,
  which recognise the copy of ClaudeUI's 1.x sign-in 2.x imported from `auth.json` (S7).
- The protocol generator finds its checkout at `vendor/opencode-src` first and the pre-S10
  `vendor/opencode-v2-src` second (the first holding the pinned tag); code comments cite
  `vendor/opencode-src/…` (the 2.x tree once the checkout is renamed).

## Rollback

- Until S10 merges, `main` keeps 1.18.x and the arc lives on a branch.
- After the merge, rollback means reverting the arc's merge commit. That restores the 1.x manifest,
  adapter and `auth.json` writer. Reverting S10a's commit alone does NOT give a working 1.x: the
  files it restores sit beside a 2.x manifest, server manager and credential store, so the 1.x
  adapter last ran against a 1.x binary before S1 moved the manifest to 2.x.
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
