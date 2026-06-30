# Follow-up — opencode session persistence + resume (don't lose opencode sessions on relaunch)

> Kickoff spec. Agent: **Sonnet, `general-purpose`**. Main model (Opus) reviews + owns correctness. Do
> **not** commit, `git add`, branch, or `bun install`. Leave the tree for review; report deltas, exact
> verify-gate output, deviations. **If you create throwaway probe scripts, put them in a temp dir / `.cache`
> and `rm` them — never leave files in `scripts/`.** Confirm `git status --porcelain | grep scripts/` is empty.

## 0. The bug + the chosen approach

opencode-engine sessions vanish from the sidebar on app relaunch (Claude sessions persist). Root cause:
the sidebar list (`session-history.ts listDirectories`) is built **only** from Claude JSONL transcripts
(`~/.claude/projects/**/*.jsonl`); opencode produces none, and ClaudeUI never enumerates opencode's own
sessions. opencode itself **does** persist sessions on disk (a global SQLite DB, `~/.local/share/opencode/
opencode.db` — verified) and exposes them over its HTTP API.

**Chosen design = B (opencode HTTP API as the source of truth)**, full resume with history. opencode's
`GET /session` list query is unfiltered-by-default (`core/src/session.ts:260-294`: a directory condition
is added only when supplied), the DB is global, and **each session row carries its own `directory` (cwd),
`title`, and timestamps** — so a single `GET /session` (global scope) returns every opencode session
across all cwds. No ClaudeUI metadata copy, no DB migration; periodically refreshable. History on resume =
one `GET /session/{id}/message` per opened session.

## 1. De-risk FIRST (mandatory step 1 — probe the real binary)

Before building anything, **prove a single `GET /session` call can return sessions across multiple
directories**. Write a throwaway probe (in `.cache/`, delete after) that:
1. `opencodeServerManager.acquire(<tempCwdA>)`, create a session, send a trivial prompt (so it persists).
2. Repeat in a different `<tempCwdB>`.
3. From a server (either A's, or one at `PERSISTED_SESSIONS_DIR`), call `GET /session` trying the candidate
   global params (no `directory`; `scope` omitted; `scope=project`; `roots=true`; etc. — see
   `opencode-src/.../httpapi/handlers/session.ts` ListQuery + `core/src/session.ts:260` list service).
4. Confirm the response includes BOTH sessions, each with its own `directory` field.
**Record the exact query that yields the global list.** If NO single global call works, fall back to
per-known-cwd enumeration (acquire a server per cwd ClaudeUI already knows from its project list) and note
it in the report. Everything below assumes the global call works; adjust if the probe says otherwise.

## 2. Verified facts (don't re-discover)
- `OpencodeClient` (`src/main/opencode/OpencodeClient.ts`) already has `listSessions()` (`GET /session`,
  no params → server-cwd default, :119), `getSession(id)` (:129), `listMessages(id)` (`GET /session/{id}/
  message`, :139 — but typed `Array<{info?}>`, **drops `parts`** which history replay needs), `createSession`,
  `deleteSession`. Base URL + auth header on construction.
- opencode session shape (`Session` in `src/main/opencode/protocol/types.ts` — confirm fields): `id`,
  `title`, `directory`, `time.{created,updated}`, and likely `version`/`projectID`. Each session knows its cwd.
- opencode stored message shape: `GET /session/{id}/message` → `Array<{ info: { id, role, time, providerID?,
  modelID?, ... }, parts: [{ type:'text'|'reasoning'|'tool'|'step-start'|..., ... }] }>` (mirror the SSE
  `message.part.updated` shapes the event-mapper already handles). The event-mapper's `buildChatMessage`
  (`event-mapper.ts:672`) converts an SSE accumulator → `ChatMessage`; the persisted REST shape is similar
  (info.role + parts) but needs its own converter.
- Sidebar list: `session:list-directories` IPC (`session.ipc.ts:~1052`) → `listDirectories()`
  (`session-history.ts:179-311`) → returns `DirectoryGroup[]` of `SessionInfo{ sessionId, cwd, projectKey,
  title, timestamp, lastActivityAt, aiTitle, engineId }` (engineId hardcoded `'claude'` :281). The renderer
  Sidebar groups by cwd.
- Resume flow (Claude template): sidebar click → `session:create(routingId, cwd, effort?, resumeSessionId,
  permissionMode?, model?, …, engineId)` (`session.ipc.ts:755`) → `SessionManager.create` → engine session.
  `ClaudeSession` stores `resumeSessionId` and passes `{resume}` to cli.js. **`OpencodeSession` accepts
  `_resumeSessionId` but IGNORES it** (`OpencodeSession.ts:186-209`) and always `createSession` fresh
  (`:306-311`).
- `OpencodeServerManager.acquire(cwd)` is ref-counted per-cwd; spawns lazily. `discoverOpencodeModels`
  already acquires a shared server at `PERSISTED_SESSIONS_DIR`.

## 3. The work

### 3a. OpencodeClient — global list + typed messages
- `listSessions(opts?: { global?: boolean })` → pass the verified global query param(s) from step 1 when
  `global` is set; default behavior unchanged.
- Fix `listMessages` to return `Array<{ info: …; parts: unknown[] }>` (expose `parts`) — the reconciler
  (current sole caller) only reads `info`, so widen the type without breaking it.

### 3b. opencode session-list service + IPC + sidebar merge
- New main service (e.g. `src/main/services/opencode-session-list.ts`): acquire the shared opencode server
  (reuse `PERSISTED_SESSIONS_DIR` if the global call works from there; else per-cwd), `listSessions({global})`,
  map each → `SessionInfo{ sessionId: s.id, cwd: s.directory, projectKey: <derive from cwd like Claude>,
  title: s.title || 'Untitled', timestamp: s.time.updated, lastActivityAt: s.time.updated, aiTitle: null,
  engineId: 'opencode' }`. Release the server. Gate on opencode-installed (empty list if not). Best-effort:
  swallow errors (don't break the Claude list).
- Surface to the renderer: simplest is a **new IPC `session:list-opencode`** returning `SessionInfo[]`; the
  renderer merges them into the sidebar groups by cwd alongside the Claude `listDirectories` result. (Keeping
  it a separate handler avoids entangling the Claude JSONL path + lets it run/refresh independently.) Wire
  the merge in the Sidebar's session-list assembly (trace `Sidebar.tsx` `listDirectories` consumption).
- **Periodic refresh** (the user wants ad-hoc updates): poll `session:list-opencode` on an interval
  (e.g. 30–60s) and on window focus / when an opencode turn ends; merge into the store. Keep it cheap (one
  HTTP call). Reuse the existing usage-poll cadence pattern if one exists.

### 3c. Resume with history (OpencodeSession)
- Store `resumeSessionId` (drop the underscore). In the session-open path (`run()` / wherever
  `createSession` is called, `:306`): if `resumeSessionId` is set, **reuse it** as `openSessionId` (skip
  `createSession`); else create fresh as today.
- On resume, **load + replay history**: `client.listMessages(openSessionId)` → for each stored message,
  convert `{info, parts}` → `ChatMessage` (a new `convertStoredMessage` — mirror `buildChatMessage`: map
  `parts` text→text block, reasoning→thinking, tool→tool_use (+ the completed tool output → a tool_result),
  skip step-start/step-finish; role from `info.role`). Emit them to the renderer as `session:message` (and
  `session:tool-result` for tool outputs) in order, BEFORE the first new prompt, so the transcript repaints.
  Populate `this.messageHistory` too. Reuse `extractToolResult`/the event-mapper part shapes for parity.
- Model on resume: default to the session's own model if `getSession`/messages expose it, else the passed
  `model` / engine default. Don't block resume on model.
- The renderer click→resume must pass `engineId:'opencode'` + `cwd` + `resumeSessionId`. Trace the Sidebar
  open-session action; ensure an opencode `SessionInfo` routes `session:create` with its `engineId` and
  `cwd` (the cwd is mandatory — the per-cwd server). If the renderer already threads `engineId` from
  `SessionInfo` (Claude sets it), confirm opencode flows the same.

### 3d. Out of scope
- DB `session_meta` migration / cwd/title columns (NOT needed under approach B — opencode is the source).
  `session_meta` keeps its current role (engine/model routing).
- Reading opencode's SQLite file directly (rejected — schema coupling).
- Sessions created via the opencode CLI outside ClaudeUI are naturally included under B (bonus), no extra work.
- Fork/branch of opencode sessions; opencode session deletion from the sidebar (separate).

## 4. Tests
- `OpencodeClient.listSessions({global})` issues the verified global query; `listMessages` returns parts.
- `convertStoredMessage`: stored `{info, parts}` → `ChatMessage` for text / reasoning(thinking) / tool
  (tool_use + tool_result) / mixed; user vs assistant role; empty/unknown parts ignored. (Unit, pure.)
- opencode-session-list service: maps `Session[]` → `SessionInfo[]` with `engineId:'opencode'`, cwd from
  `directory`, title fallback; tolerates opencode-not-installed (empty) + API error (empty, no throw).
- OpencodeSession: with `resumeSessionId` set, reuses it (no `createSession`) and replays history
  (assert `session:message` emitted per stored message before the new turn); without it, creates fresh
  (regression).
- A gated integration (real binary) if feasible: create → relaunch-equivalent (new server) → list returns
  it → resume replays the prior message. (Mirror `src/integration/opencode/` patterns.)

## 5. Verify gates
`bun run typecheck && bun run test && bun run lint && bun run build` — 0 lint errors (3 pre-existing
warnings OK). Leave tree dirty; list changed files + rationale. Do NOT app-shot — main model drives the app.

## 6. Gotchas
- **Probe first** (step 1) — the whole design hinges on the single global `GET /session`. If it can't go
  global, switch to per-known-cwd enumeration and SAY SO; don't silently scope to one cwd.
- History replay must be **ordered** and emitted before the resumed turn's new content, or the transcript
  interleaves. Reuse the event-mapper's part→block mapping for parity with live turns (don't invent a second
  divergent renderer path).
- `listMessages` widening must not break the usage reconciler (its only current caller reads `info` only).
- Best-effort everywhere on the opencode side — a failed/absent opencode server must NOT break the Claude
  sidebar list (swallow + log).
- Per-cwd server: resume needs the session's `directory` as the cwd to `acquire()` the right server — it
  comes from the session row, not ClaudeUI state.
- Don't spawn a server per cwd for the LIST if the global call works (step 1) — one shared server.
- No `scripts/` debris.

## 7. Suggested commit (main model writes it after review)
```
feat(v2/opencode): persist + resume opencode sessions across relaunch (sidebar list + history replay)

opencode sessions vanished on relaunch because the sidebar is built only from Claude JSONL transcripts and
ClaudeUI never enumerated opencode's own (disk-persisted) sessions. Source the opencode session list from
opencode's HTTP API — a single global GET /session returns every session across all cwds (each carrying its
directory/title/time) — surfaced via session:list-opencode and merged into the sidebar, polled for updates.
Resume now reuses the prior opencode session id and replays its stored history (GET /session/{id}/message →
ChatMessages) before continuing, instead of always starting fresh. No DB migration — opencode's own storage
is the source of truth.
```
