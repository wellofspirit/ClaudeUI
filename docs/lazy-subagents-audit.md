# Audit: consumers of `subagentMessages` / subagent transcripts (ClaudeUI, read-only)

Snapshot of branch pre-release at e8ef6c1d (2026-10-19). Paths below are relative to the repo root.
Labels: FACT = quoted from source. LEAD = needs a probe (probe named).

## 0. How I searched

- `grep -rnE "subagentMessages|subagentMsgs" src` (non-test: 107 hits in 40 files; none under `src/web`, `src/server`, `src/preload`, `src/main` except `src/main/services/plugin-manager.ts:108`). Also grepped `buckets?`, `loadSubagentHistory`, `buildSubagentFileMap`, `agentIdToToolUseId`, `readNestedAgentOrigins`, `watchSubagent`, `'subagents'` path literals, `useAgentRoster|scanAgentTree|findTaskBlocks|findAskingBucket`, `session:subagent-*` emit sites, `seedColdSession|seedSession|seedWatchedSession|loadSessionHistory(`, and search/export/copy/gallery/files-widget terms.
- Read in full: `session-history-load.ts`, `useAgentRoster.ts`, relevant ranges of `reducer.ts`, `state.ts`, `sync-core.ts`, `replica.ts`, `session-store.ts`, `session-history.ts`, `agent-identity.ts`, TaskCard/TaskEntry/TaskDetailPanel/BashBackgroundEntry/MobileTaskView/FloatingApproval/SubagentMessages/ImageGalleryProvider.

---

## 1. Readers of the bucket in renderer / shared / core (non-test)

### 1.1 Roster tree: `useAgentRoster` / `scanAgentTree` (both historical and live)

- `src/renderer/src/hooks/useAgentRoster.ts:277-297` `scanAgentTree`: FACT
  ```
  const bucket = subagentMessages[entry.toolUseId]
  if (bucket?.length) {
    walk(scanTranscriptCached(bucket, engineId), depth + 1, entry.toolUseId)
  ```
  Depth-0 rows come from the main transcript (`walk(scanTranscriptCached(messages, engineId), 0)` :295); every deeper row can only be found by scanning a bucket.
- `useAgentRoster.ts:13-16`: FACT "A nested agent's spawn call lives in its parent's bucket (`subagentMessages[<parent origin id>]`), so the scan walks the main transcript and then, depth-first, the bucket of every agent it finds."
- Row fields taken from the scanned list (`scanTranscript` :202-269): `hasResult: !!result`, `resultIsError`, `name`, `description`, `isBackground`. For a nested agent these come from the PARENT's bucket (tool_use + tool_result in that bucket). For depth-0 from main `messages`.
- Hook wiring `useAgentRoster.ts:526-557`: FACT `const subagentMessages = useActiveSession((s) => s.subagentMessages)`; `scanAgentTree(messages, subagentMessages ?? NO_BUCKETS, engineId ?? 'claude')`. No `isHistorical` guard on the tree (applies to both).
- Row state is NOT from the bucket: `toRow` :379-436 uses `latestNotification(opts.notifications, ...)`, `opts.activeTasks`, `opts.progress`, `entry.hasResult`. `usage` from `progress?.usage || notification?.usage` (:426-432).
- `settleOrphans` :452-472: FACT "a nested row that no lifecycle event describes ... cannot outlive its parent" - operates on tree rows that exist only if their parent bucket was scanned.
- Shells `listShells` :313-377: FACT `if (opts.isHistorical) return []` (:321) -> historical sessions list no shells. Live: `findTaskBlocks(opts.messages, toolUseId, opts.subagentMessages)` (:346-350, :359-363); `if (!taskBlock) continue` (:351) / `if (taskBlock?.toolName !== 'Bash') continue` (:364).
- Downstream of the hook (all read `roster`, not the bucket): `components/agents/AgentPill.tsx:28-31` `if (!enabled || (runningCount === 0 && totalCount === 0)) return null`; `AgentTab.tsx:36-37` `const visible = enabled && runningCount > 0`; `AgentRosterList.tsx:149` `roster.totalCount > 0 &&` ("Show all N"); `roster-summary.ts:30` `total: roster.totalCount > 0 ? count(...)`; `TaskDetailPanel.tsx:25` `const roster = useAgentRoster()`.

### 1.2 `findTaskBlocks` (shared by panel entries, shells, mobile title)

- `src/renderer/src/components/TaskDetailPanel/utils.ts:52-65`: FACT
  ```
  const top = scan(messages, toolUseId)
  if (top.taskBlock || !subagentMessages) return { ...top, ownerToolUseId: null }
  for (const [owner, bucket] of Object.entries(subagentMessages)) {
  ```
  Flat iteration over ALL buckets (not recursive); first bucket holding the call wins. If none holds it: `return { ...top, ownerToolUseId: null }` (taskBlock null).
- Callers: `TaskDetailPanel.tsx:30-34`, `TaskEntry.tsx:70-74`, `BashBackgroundEntry.tsx:44`, `MobileTaskView.tsx:25`, `useAgentRoster.ts:346,359`.

### 1.3 TaskCard (inline chat card) - both

- `src/renderer/src/components/chat/TaskCard.tsx:384` `const subagentMsgs = useActiveSession((s) => s.subagentMessages)`
- `:408-413` FACT
  ```
  const msgs = useMemo(
    () => overlayItemStreams(subagentMsgs[toolUseId] || [], itemStreams, toolUseId),
  ...
  const hasSubagentOutput = msgs.length > 0
  ```
- `:514` `const failureSummary = isError && hasSubagentOutput && result?.isError ? resultBody : ''`
- `:785-796` (expanded only): `{hasSubagentOutput ? (<SubagentOutputBody msgs={msgs} .../>) : resultBody && !isBackground ? (<MarkdownRenderer content={resultBody} />) : isRunning ? (... 'Running...') : null}`
- Status/border/footer do NOT use `msgs`: `deriveTaskState({isHistorical, hasActiveTask, isBackground, hasResult, notification: bgNotification, resultIsError})` (:~455), usage from `bgNotification?.usage` else `parseUsage(result?.toolResult)` (:~478-486). `expanded` is local `useState(false)` (:393); the bucket is read whether or not expanded (selector at render), the body only renders when `expanded` (:765).

### 1.4 TaskEntry (right-panel entry) - both (panel is "live surface", passes `isHistorical: false`)

- `src/renderer/src/components/TaskDetailPanel/TaskEntry.tsx:52` `const subagentMsgs = useActiveSession((s) => s.subagentMessages)`; `:70-74` `findTaskBlocks(messages, toolUseId, subagentMsgs)`; `:77-80` `overlayItemStreams(subagentMsgs[toolUseId] || [], itemStreams, toolUseId)`; `:93` `const hasSubagentOutput = msgs.length > 0`; `:265-275` `{hasSubagentOutput ? <SubagentOutputBody msgs={msgs} .../> : isBash && bashOutput ? ... : isBash && hasResult && resultText ? ... : hasResult && resultText && !isBackground ? <MarkdownRenderer content={resultText}/> : isRunning ? 'Running...' : null}`.
- `:~89` `if (!taskBlock) return null` (nested agent whose parent bucket is absent -> `findTaskBlocks` yields null taskBlock -> renders nothing).
- `:121-130` FACT `deriveTaskState({ isHistorical: false, ...` with comment ":the panel is a live surface, so isHistorical is false here by construction".

### 1.5 TaskDetailPanel / BashBackgroundEntry / MobileTaskView

- `TaskDetailPanel.tsx:19` selector; `:30-35` FACT `const { taskBlock, resultBlock, ownerToolUseId } = findTaskBlocks(messages, toolUseId, subagentMessages)` / `if (!taskBlock) return { toolUseId, kind: 'missing' as const }`; `TaskDetailPanel/View.tsx:52` FACT `if (entry.kind === 'missing') return null`. `:36-58` shell-vs-task classification (Bash `run_in_background` / `bashMovedToBackground`) and `ownerLabel` via `roster.agents.find((a) => a.toolUseId === ownerToolUseId)`.
- `BashBackgroundEntry.tsx:24,44` `findTaskBlocks(messages, toolUseId, subagentMessages)`; `:77` `if (!taskBlock) return null`; `:219-233` "launched by" link only `ownerToolUseId &&`.
- `MobileTaskView.tsx:20,25` FACT `findTaskBlocks(messages, openedTaskToolUseIds[0], subagentMessages)`; title = `description || 'Task'` (title falls back to `'Task'` when `taskBlock` null). Mobile reuses `TaskDetailPanel` (`:~75`).

### 1.6 Approval routing - live only in practice (pendingApprovals is live state)

- `FloatingApproval.tsx:350-376` `findAskingBucket` FACT:
  ```
  const marked = approval.subagent?.parentToolUseId
  if (marked) return { ownerToolUseId: marked, call: callIn(subagentMessages?.[marked]) }
  for (const [ownerToolUseId, messages] of Object.entries(subagentMessages ?? {})) {
  ```
  `:429` selector, `:495` `const asking = findAskingBucket(approval, subagentMessages)`; `:496` `roster.agents.find(...)`. Bucket absent -> `undefined` (no owner label, no call) or `{ownerToolUseId, call: undefined}` when opencode marks it.
- `FloatingApproval.tsx:384-387` FACT: "Nested transcripts (`subagentMessages`) are deliberately NOT consulted [by useUnmatchedApprovals] ... an approval raised inside a subagent renders on BOTH surfaces".
- `SubagentMessages.tsx:119` `const pendingApprovals = useActiveSession((s) => s.pendingApprovals)`; approvalMap built from its OWN `messages` prop (`:~121-130`). Does not read the store bucket; renders only what TaskCard/TaskEntry hand it (`SubagentOutputBody.tsx:46` `{msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" />}`).
- `reducer.ts:161-186` `attachToToolUse` (live `session:tool-review` / `session:permission-denial`): FACT `for (const [owner, bucket] of Object.entries(session.subagentMessages)) { const next = appendToCall(...)`; falls to `return state` (drop) when no bucket holds the call (comment :141-143 "DROP rather than park when no message holds the call").
- `CodexSession.ts:3617-3623` FACT comment: "the child's blocks live in `subagentMessages`), so `useUnmatchedApprovals` finds no match and the card floats".

### 1.7 Image gallery / diagram gallery

- `SubagentMessages.tsx:141-148` FACT comment: "A subagent's tool results live in `subagentMessages`, outside the chat providers' message list, so without these [its OWN providers] the image thumbnails ... would render as clickable-but-dead"; `:149-150` `<ImageGalleryProvider messages={messages}><DiagramGalleryProvider messages={messages}>` (messages = the prop).
- `ImageGalleryProvider.tsx:50-53` FACT: "A no-op when the id isn't in the gallery - e.g. a SUBAGENT tool card, whose results live in `subagentMessages` and are outside this provider's message list".
- `ChatPanel.tsx:314-315` main providers get `messages={messages}` (main transcript only). Gallery for subagent images exists only while a SubagentMessages list is mounted.

### 1.8 Todos / Files (SentFiles) widget / derived state - main transcript only

- `src/shared/derive-session.ts:25` `buildTodosFromMessages(messages: ChatMessage[])`, `:104` `buildSentFilesFromMessages(messages: ChatMessage[])` - take only the main `messages` array; no bucket parameter.
- `reducer.ts:258` `buildTodosFromMessages(s.messages)`, `:264` `buildSentFilesFromMessages(s.messages)`, `:1520,:1529` (`checkDerivedFields`) same; `commitMessage` :339-343 returns early for `ownerToolUseId` before the `rederiveTodos/rederiveSentFiles` calls at :347-350: FACT
  ```
  if (ownerToolUseId) {
    return { ...session, subagentMessages: { ...session.subagentMessages, [ownerToolUseId]: messages } }
  }
  let next = { ...session, messages }
  if (content.some(... TODO_TRIGGER_TOOLS ...)) next = { ...next, ...rederiveTodos(next) }
  ```
- `SentFilesWidget.tsx:62` `useActiveSession((s) => s.sentFiles)`. `remote-server.ts:2380` `/sent-file` allowlist = canonical `sentFiles` (from main transcript).

### 1.9 Search / export / copy / rename / fork / cost

- Find-in-chat: `components/chat/ChatSearch/chat-search.ts:1-5` FACT "Pure DOM-walking search engine ... Walks the given root with a TreeWalker"; `search-scope.ts` `TOOL_OUTPUT_SCOPE`. It searches whatever is in the DOM. `TaskCard` renders subagent output only when `expanded` (:765) inside `<div {...TOOL_OUTPUT_SCOPE}>` (:783). Does not read the store.
- Export / copy-whole-transcript / share: grep for export/copy/share/download of session/conversation/transcript found nothing in `src/renderer` (only `src/core/opencode/protocol-v2/openapi.ts:2362` generated doc "Export session"). NONE found.
- Auto-rename `Sidebar.tsx:198-231`: FACT `if ((await ensureTranscriptLoaded(sessionId)) !== 'resident')` then iterates `session.messages` text blocks only (:~221-229). Does not read bucket.
- Fork: `session-store.ts:1391-1440` `loadForkSeed` returns `Pick<PerSessionState, 'messages' | 'taskNotifications'> & { statusLine?: StatusLineData }`; Claude path: `window.api.loadSessionHistory(sourceSessionId, projectKey, anchorUuid)` and returns `{messages, taskNotifications, statusLine}`; non-Claude/fallback: `src.messages.slice(0, idx + 1)` + `forkTaskNotifications`. No `subagentMessages` in the fork seed (today, even with eager load). `patchLocalSession(newRoutingId, { cwd, ...seed, ...})` :~2730.
- Cost/usage: not renderer-derived from buckets (see 3.2).
- Sidebar status dot: `SessionItem.tsx:~72` `runningSubagents: sess ? countAutoContinuingTasks(sess.activeTasks) : 0` (activeTasks, not buckets).
- `src/main/services/plugin-manager.ts:104-110` (live `session:item-seal` compat): FACT `session?.subagentMessages[ownerToolUseId]?.find((message) => message.id === data.message.id)`; `if (!session || !canonical) return`. Live only.

### 1.10 Store / replica plumbing (the bucket itself)

- Declaration `session-store.ts:1068` `subagentMessages: Record<string, ChatMessage[]>`; empty default `:1179`.
- Sealed: `stores/sealed-fields.ts:66` (`'subagentMessages'` in SEALED_SESSION_FIELDS), `:102` (`subagentMessages: 'subagentMessages'` in SEALED_SESSION_FIELD_SOURCE). Doc `:30-33` FACT: "**Lint** (`eslint.config.mjs`, `no-restricted-syntax`): a `set(...)` call in the renderer whose object literal names a sealed key is an error outside `stores/replica.ts`." `eslint.config.mjs:197,206` regexes include `subagentMessages` (for `updateSession(...)` and `Property[key.name='sessions']`).
- Projection `replica.ts:848` `subagentMessages: c.subagentMessages,` (inside `projectSession`).

---

## 2. Core / sync side

### 2.1 How the cold-history seed carries subagent messages

- Renderer cold open: `session-history-load.ts:283-291` -> `store().loadHistoricalSession(routingId, messages, info.cwd, taskNotifications, subagentMessages, statusLine, warnings)`.
- `session-store.ts:2542` param `subagentMessages?`; `:2614-2627` FACT
  ```
  seedColdSession(routingId, {
    cwd, messages,
    taskNotifications: taskNotifications ?? base.taskNotifications,
    subagentMessages: subagentMessages ?? base.subagentMessages,
    statusLine: statusLine ?? base.statusLine ?? null,
    todos: buildTodosFromMessages(messages) ?? [],
    sentFiles: buildSentFilesFromMessages(messages) ?? []
  })
  ```
  (`base` = `prior` if `prior?.evicted`, else `createEmptySession`; `:2574-2577`.) todos/sentFiles are derived from `messages` ONLY (not buckets).
- "SyncCore 4c" comment `session-history-load.ts:293-295` FACT: "todos + the Files widget are derived from the transcript INSIDE the cold-history seed now (SyncCore 4c): they are sealed, and deriving them here would have been a client computing state the reducer already computes."
- `replica.ts:523-544` `seedColdSession` FACT:
  ```
  if (existing && existing.messages.length > 0 && (seed.messages?.length ?? 0) > 0) { ... seeded: true ...; return false }
  const base = existing ?? emptySession(routingId, seed.cwd ?? '')
  commit({ ...canonical, sessions: { ...canonical.sessions, [routingId]: { ...base, ...seed, routingId, seeded: true } } })
  ```
  It writes the RENDERER-local replica `canonical` (not the host's SyncCore); `{...base, ...seed}` replaces `subagentMessages` wholesale when the seed names it. Fill-only: refuses when messages already held.
- Host canonical cold/resume seed carries NO subagent buckets:
  - `src/core/ipc/seed-canonical-transcript.ts:42-57` FACT:
    ```
    const { messages, taskNotifications, statusLine } = await loadSessionHistory(...)
    syncCore.seedSession(routingId, { cwd, messages, taskNotifications, ...(statusLine ? { statusLine } : {}),
      todos: buildTodosFromMessages(messages) ?? [], sentFiles: buildSentFilesFromMessages(messages) ?? [] })
    ```
  - `session-history-load.ts:515-530` (`loadResumedTranscript`, live-resume fill) FACT: destructures `{ messages, taskNotifications, customTitle, statusLine, warnings }` and `seedColdSession(routingId, { cwd, messages, taskNotifications, ...(statusLine ? { statusLine } : {}) })` - no `agentIdToToolUseId`, no `loadSubagentHistory` call.
  - `useClaudeEvents.ts:184-189` + `session-watcher.ts:74,99` (watched sessions): FACT `const { messages, taskNotifications, statusLine } = await window.api.loadSessionHistory(...)` / `seedWatchedSession(routingId, { messages, taskNotifications, statusLine })`; `reducer.ts:397-401` `WatchedContent { messages; taskNotifications?; statusLine? }`; `applyWatchedContent` :412-426 replaces `messages`/`taskNotifications`, leaves `subagentMessages` untouched.
  - `sync-core.ts:546-563` `seedSession`: `{ ...base, ...seed, routingId, seeded: true }`, fill only if `existing.messages.length === 0`.
- Canonical state stores buckets: `core/shared/sync/state.ts:58` `subagentMessages: Record<string, ChatMessage[]>`; `emptySession` `:155` `subagentMessages: {}`; `fromSnapshot` `:232` `subagentMessages: s.subagentMessages`; `toSnapshot` `:299` same. Wire type `shared/remote-protocol.ts:1041` `subagentMessages: Record<string, ChatMessage[]>`; `:1078-1084` FACT "`false` means this entry does NOT carry its transcript - `messages` and `subagentMessages` are empty because the host dropped them (ADR-087 §2) ... With `sdkActive` false, read it from disk".
- Eviction (host): `sync-core.ts:487-511` `evictTranscript` FACT sets `messages: [], subagentMessages: {}, itemStreams: {}, itemStreamRevision: 0, seeded: false`; early return only `if (existing.messages.length === 0 && Object.keys(existing.subagentMessages).length === 0)` (:494). Triggered `sync-core.ts:399` `evictOnExit` on `session:status` -> `disconnected`, and `session-watcher.ts:136,162`.
- Eviction (client): `replica.ts:624-639` `evictLocalSessions` FACT `messages: [], itemStreams: {}, itemStreamRevision: 0, subagentMessages: {}, seeded: false`; called from `session-store.ts:2250` (`switchSession`, `coldSessionIds` :1479-1505; condition includes `sess.messages.length > 0`) and `session-history-load.ts:109` (`stripForReplace`).
- Replace-reload: `session-history-load.ts:106-111` `stripForReplace` -> `markViewEvicted` + `evictLocalSessions([routingId])` (strips buckets too) before `loadHistoricalSession` refills; used by `reloadActiveTranscript` (`replace: true` :454) after hydrate, and by `replaceOnClick`.
- Resync keep: `replica.ts:419-424` FACT `sessions[keptLocalId] = { ...restored.sessions[keptLocalId], messages: held.messages, subagentMessages: held.subagentMessages }`.
- Reducer reads of derived state: none read buckets (see 1.8). `checkDerivedFields` :1517-1535 uses `s.messages` only.

### 2.2 Reducer cases that READ/WRITE buckets (all live, keyed by owner tool_use id)

(`src/core/shared/sync/reducer.ts`)

- `commitMessage` :277-345 (via `session:item-open`/`session:item-seal` :532-548 with `ownerToolUseId`): `const current = ownerToolUseId ? (session.subagentMessages[ownerToolUseId] ?? []) : session.messages` (:282-284) -> creates the bucket if absent.
- `session:tool-uses-retracted` :781-826: `const messages = owner ? session.subagentMessages[owner] : session.messages` ... `if (!messages || index < 0) return state` (no-op if bucket absent).
- `session:tool-result` :829-834 and `session:subagent-message` :928-934, `session:subagent-message-batch` :936-941 -> `upsertSubagentMessages` :1462-1490: `const current = [...(session.subagentMessages[toolUseId] || [])]`, upsert by `message.id`, creates bucket.
- `session:subagent-tool-result` :943-985: `const msgs = [...(session.subagentMessages[data.toolUseId] || [])]`; appends tool_result to the latest assistant msg holding the call (no-op on content if not found, but still writes `[toolUseId]: msgs`).
- `session:tool-review` / `session:permission-denial` -> `attachToToolUse` :161-186 (scans all buckets; drops when none).
- `session:messages-retracted` :761-777 only filters `itemStreams` targets by `ownerToolUseId`; filters `s.messages` only.
- `core/shared/sync/item-stream.ts:121-122` `messagesOf(s, owner)` = `owner ? (s.subagentMessages[owner] ?? []) : s.messages`; `:158` `upsert` writes `subagentMessages[owner]`; `hasTarget` :125-132.
- `session:conversation-cleared` :679-705 uses `emptySession(...)` (clears buckets); `session:created` :550-612 spreads `...base` (keeps).
- Channel classification `channels.ts:246` FACT `why: 'subagentMessages map, upsert-by-id; clears the streaming buffers for that subagent.'`

---

## 3. Main-process side

### 3.1 Subagent JSONL readers

- `src/core/services/session-history.ts:1540-1555` `loadSubagentHistory(sessionId, projectKey, agentId)`: `path.join(CLAUDE_PROJECTS_DIR, projectKey, sessionId, 'subagents', \`agent-${agentId}.jsonl\`)`; `if (!fs.existsSync(filePath)) return []`; `return parseJsonlFile(filePath)`. Exposed: `core/ipc/session.ipc.ts:1032-1037` (`session:load-subagent-history`, capability `fs-read`), `core/ipc/remote-handlers.ts:810-815`(same, remote),`preload/index.ts:169`, `web/api-adapter.ts:168`.
- `buildSubagentFileMap` `session-history.ts:1564-1616`; IPC `session:build-subagent-file-map` (`session.ipc.ts:1055`, `remote-handlers.ts:834`, `preload/index.ts:172`, `web/api-adapter.ts:178`). **No renderer caller**: `grep buildSubagentFileMap src` outside core/ipc, preload, web adapter, types, tests returns nothing.
- `src/core/services/subagent-watcher.ts:255` `watchSubagent(...)` (emits `session:subagent-message-batch`, prompt-matched file): **no non-test caller** (`grep -rn "watchSubagent\b" src` -> only its own file). `unwatchAllSubagents` is imported by `claude-session.ts:47`.
- `src/core/services/block-usage.ts:1413` doc "`~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-*.jsonl`" - `collectJsonlFiles` scans subagent files for usage DB (`deriveSessionIdFromPath` :222-232); independent of the renderer.
- `src/core/services/agent-identity.ts:215-250` `readAgentSidecar` reads `agent-<id>.meta.json` (`toolUseId`, `parentAgentId`, `spawnDepth`); `:273-285` `readNestedAgentOrigins`.

### 3.2 Cost / usage reconstruction (main process reads subagent files itself)

- `session-history.ts:287-318` `foldSubagentCosts(filePath, modelTokens, seenMessageIds, onlyAgentIds?)` FACT reads `path.join(path.dirname(filePath), path.basename(filePath, '.jsonl'), 'subagents')`, folds every `agent-*.jsonl`. Called from `computeTokenMetrics` :466-473: `await foldSubagentCosts(filePath, modelTokens, seenMessageIds, anchorFound ? keptAgentIds : undefined)`.
- `computeTokenMetrics` doc :322-330 FACT: "Subagent spend is then limited to the agents the kept lines spawned ... agents spawned from inside a subagent are not attributable to a side of the anchor from the main file, so a truncated read leaves them out."
- Output `statusLine` (`:490-503`): `totalCostUsd, totalDurationMs, totalApiDurationMs, totalInputTokens, totalOutputTokens, cachedTokens, totalTokens, contextWindow, usedPercentage, remainingPercentage, modelCosts`. Returned to the renderer as `statusLine` by `loadSessionHistory` (:1491, :1518) - no dependence on renderer buckets.
- Header/session cost in the UI therefore comes from `statusLine`, which is read by the main process regardless of whether the renderer loads buckets.

### 3.3 What the main transcript alone provides per agent (`loadSessionHistory`, session-history.ts:1014-1530)

- Result type `:804-830`: `agentIdToToolUseId: Record<string, string>` ("Maps agentId -> toolUseId for subagent JSONL lookup"), `subagentMessages?` (doc :813-820 FACT "Claude leaves this undefined: its subagent transcripts are separate JSONL files the Sidebar fetches per `agentIdToToolUseId` entry").
- Built at :1229-1236 FACT `const agentId = agentIdOf(resultText); if (agentId) { agentIdToToolUseId[agentId] = block.tool_use_id }` (top-level agents whose tool_result text matches `/(?:agentId|agent_id):\s*(\S+)/`, agent-identity.ts:29).
- `taskNotifications` entries (:1038-1048 + type `shared/types.ts:1375-1396`): `taskId, toolUseId (agentIdToToolUseId[notif.taskId] || null), status ('completed'|'failed'|'stopped'|'unfinished'), outputFile, summary, usage?: { totalTokens, toolUses, durationMs }, runIndex?`. `unfinished` entries pushed at :1478-1487 for agents whose last run never closed.
- `statusLine` incl. `modelCosts` (3.2).
- The main-transcript `tool_result` for the Task/Agent call (text, may contain `<usage>`; TaskCard `parseUsage(result?.toolResult)` TaskCard.tsx:~478) - shown as `resultBody` when no bucket (TaskCard.tsx:~802).

### 3.4 Other main-process consumers of `loadSessionHistory` (none read subagent output)

- `automation-manager.ts:921` `const { messages } = await loadSessionHistory(...)`; `session-manager.ts:174-176` `result.messages`; `session-watcher.ts:74`; `seed-canonical-transcript.ts:42`; `engine-history.ts` (`readSessionHistory`).
- `engine-history.ts:30-51` `bare()` FACT:
  ```
  subagentMessages?: SessionHistoryResult['subagentMessages']   // "pi's host-run subagent transcripts (ADR-089), passed through inline like Codex's"
  agentIdToToolUseId: {},
  ...(load.subagentMessages ? { subagentMessages: load.subagentMessages } : {})
  ```
  (readers map `engine-history.ts:~53-80`: claude `read: (...args) => loadClaudeHistory(...args)`, pi `bare(await loadPiSessionHistory(id))`, opencode `bare(await loadOpencodeSessionHistory(id))`.) The same `bare()` serves pi and opencode, so both pass `subagentMessages` through when their loader returned it.
- Fork anchor: `resolveForkAnchor` (called `session-store.ts:~2690`) uses main transcript; `computeTokenMetrics` filters subagent cost by `keptAgentIds` (:383-400).
- Blob store: `blob:get` (session.ipc.ts:~1045) serves BlobRefs; no subagent-file reader found. LEAD (probe: `grep -rn "BlobRef\|putBlob" src/core` to see whether subagent tool_result images are blob-ref'd on snapshot; not checked).

---

## 4. Nested agents

- Discovery in UI: `useAgentRoster.ts:277-297` (quoted in 1.1). A nested agent's spawn tool_use/tool_result sit in the parent agent's bucket, so the nested row exists only if the parent's bucket is non-empty (`bucket?.length`).
- Other flat walks across all buckets: `findTaskBlocks` utils.ts:59 (`Object.entries(subagentMessages)`), `findAskingBucket` FloatingApproval.tsx:370, `attachToToolUse` reducer.ts:177. Only `scanAgentTree` is recursive/depth-first.
- Does the main transcript's `agentIdToToolUseId` include nested agents? Two sources in `loadSessionHistory`:
  1. :1229-1236 from main-transcript tool results (top-level only; a nested agent's spawn result lives in its parent's transcript).
  2. `session-history.ts:1451-1462` FACT comment ":Nested agents (ADR-073 §7): their spawn results live in the parent agent's transcript, so the loop above never mapped them. Their sidecars name each one's origin; the Sidebar then loads their transcripts like any other." then
     ```
     for (const [agentId, toolUseId] of Object.entries(readNestedAgentOrigins(filePath))) {
       if (agentIdToToolUseId[agentId]) continue
       agentIdToToolUseId[agentId] = toolUseId
     ```
  `agent-identity.ts:262-285`: only sidecars that name a `parentAgentId`; "A missing directory, or an agent with no sidecar (older CLIs), yields nothing: never a throw." So nested ids ARE included in `agentIdToToolUseId` (the eager loader fetches them at `session-history-load.ts:259-277`) when sidecars exist; absent for older CLIs w/o sidecars.
  Test pin: `src/main/services/__tests__/session-history-nested-agents.test.ts:127-128` `expect(agentIdToToolUseId).toEqual({ [AGENT_A]: ORIGIN_A, [AGENT_B]: ORIGIN_B })` (B has `parentAgentId: AGENT_A`).
- Bucket key is the agent's ORIGIN tool_use id for both depths (`session-history-load.ts:275-276` `subagentMessages[toolUseId] = msgs`). Dependency chain for a lazy design: row for nested agent B needs bucket[A] (to discover B's spawn call) while bucket[B] is B's own transcript. (Observation, not a conclusion.)
- Codex cold reader is depth one (`core/codex/history.ts:569-571` FACT "DEPTH ONE, deliberately: a grandchild's messages belong to ITS parent's card ..."; `CHILD_READ_LIMIT = 16` :308). pi follows depth <= 3 (`pi-session-list.ts:507` `MAX_SUBAGENT_HISTORY_DEPTH = 3`). opencode: "grandchildren under the child's own call" (`core/opencode/history.ts:21-22`).

---

## 5. Non-Claude engines (how `subagentMessages` is populated on disk open)

- Renderer, opencode + pi: `session-history-load.ts:148-192`. FACT :169-172
  ```
  // Host-run pi subagent transcripts (ADR-089) come back inline, keyed by the
  // parent `agent` call id — the Codex precedent below. opencode returns none.
  const subagentMessages = loaded && 'subagentMessages' in loaded ? loaded.subagentMessages : undefined
  ```
  then `loadHistoricalSession(routingId, messages, info.cwd, taskNotifications, subagentMessages, statusLine)` (:182-189). Note the comment says "opencode returns none" but the main reader does return them (below).
- Renderer, Codex: :194-227 FACT :221-224 "Codex's reader returns the child threads' transcripts inline (they are native THREADS on the same connection, not JSONL sidecars), so there is no second fetch to make here as there is for Claude." `history.subagentMessages` passed.
- Main readers:
  - Codex `core/codex/history.ts:553` `subagentMessages: await readCodexChildren(service, childCards),` (depth one, limit 16).
  - pi `core/services/pi-session-list.ts:466,480` `const { messages: subagentMessages, childEntries } = loadSubagentMessages(active)` ... `...(Object.keys(subagentMessages).length > 0 ? { subagentMessages } : {})`; `taskNotifications` via `collectPiTaskNotifications`.
  - opencode `core/services/opencode-session-list.ts:336-338` `...(Object.keys(history.subagentMessages).length > 0 ? { subagentMessages: history.subagentMessages } : {})` from `convertOpencodeHistory` (`core/opencode/history.ts:49,138,221,238`: `const sink = owner === null ? history.messages : (history.subagentMessages[owner] ??= [])`; `if (owner !== null && sink.length === 0) delete history.subagentMessages[owner]`). So opencode DOES return them inline (contradicting the renderer comment at :170 - LEAD; probe: `window.api.loadOpencodeHistory` return type in `src/shared/types.ts:4147` is `subagentMessages?: Record<string, ChatMessage[]>` on the shared `EngineHistoryLoad`).
  - Types: `shared/types.ts:1689` (loadSessionHistory return, `subagentMessages?`), `:4147` (`EngineHistoryLoad.subagentMessages?`).
- Live-resume replays (non-disk-open): `PiSession.ts:1275-1301` replays `loadPiSessionHistory` and `this.send('session:subagent-message-batch', { toolUseId, messages: childMessages })` for each bucket; `OpencodeSession.ts:850-860` replays only `history.messages` (not `history.subagentMessages`).

---

## 6. Live path writers (so lazy load only touches disk opens)

Reducer cases that write buckets: `session:item-open`/`session:item-seal` (owner via `commitMessage`), `session:subagent-message`, `session:subagent-message-batch`, `session:subagent-tool-result`, `session:tool-result` (via `upsertSubagentMessages`), `session:tool-uses-retracted` (owner), `session:tool-review`/`session:permission-denial` (`attachToToolUse`), `session:conversation-cleared` (reset). (reducer.ts line refs in 2.2.)
Emit sites: Claude `claude-session.ts:266` (`publish` for item lane), `:1451` (`session:subagent-message` with `parentToolUseId`), `:3182` (`session:subagent-tool-result`); Codex `CodexSession.ts:2598,2603`; pi `pi-child-runner.ts:803,806,814`, `PiSession.ts:1301` (batch replay); opencode `OpencodeSession.ts:1071,1231`; dispatcher `cross-engine-dispatcher.ts:3463,3469,4300,4316,4401,6186,6202,6462`; `subagent-watcher.ts:288,302` (batch; unreferenced, 3.1).
Live-vs-bucket interaction (FACTs): events create the bucket when absent (`upsertSubagentMessages` `session.subagentMessages[toolUseId] || []`), so on a live session whose earlier agents were never loaded, a resumed agent's events produce a bucket holding only the new messages. Also a live session resumed via `loadResumedTranscript`/`seedCanonicalTranscript` already has no buckets for pre-resume agents (2.1).

---

## 7. Tests that assert on the bucket / subagent loading (listed separately)

- Reducer/sync: `src/core/shared/sync/__tests__/reducer.unit.test.ts` (6 hits), `item-stream.unit.test.ts` (3), `src/core/sync/__tests__/sync-core-eviction.unit.test.ts:68,81,247` (e.g. `:68` `expect(s.subagentMessages).toEqual({})`), `snapshot-invariant.unit.test.ts:34,288` (masks `subagentMessages` after eviction), `snapshot-blob-size.unit.test.ts:125` (`canonical.subagentMessages['sub-1']`).
- Renderer store: `stores/__tests__/session-store-actions.component.test.ts:371-386` (`'loads subagentMessages when provided'`; `'sets empty arrays when optional params omitted'` -> `subagentMessages` toEqual `{}`), `:1489-1584` (live appends), `session-store-remote-resync.unit.test.ts:61`, `session-store-reasoning-variant.unit.test.ts`, `replica-uncarried.unit.test.ts:104` (mocks `loadSubagentHistory: vi.fn(async () => [])`), `lib/__tests__/session-history-load.unit.test.ts:51,81` (same mock).
- Hooks/components: `hooks/__tests__/useClaudeEvents-extended.component.test.ts:190-344`, `hooks/__tests__/useAgentRoster.component.test.tsx` (13), `components/agents/__tests__/AgentSurfaces.component.test.tsx`, `AgentLayout.browser.test.tsx`, `TaskDetailPanel/__tests__/{TaskDetailPanel,TaskEntry,BashBackgroundEntry}.component.test.*`, `chat/__tests__/{SubagentMessages.component,SubagentMessages.approval.component,FloatingApproval.component,MessageBubble.unit}.test.tsx`, `chat/tool-registry/__tests__/renderToolBlock.test.tsx`.
- Core readers: `main/services/__tests__/{session-history-attachments (loadSubagentHistory 253-407), session-history-nested-agents (agentIdToToolUseId 127-149), pi-session-list, opencode-session-list, cross-engine-dispatcher.component}.test.ts`, `core/codex/__tests__/{engine-history,codex-discovery-history}.test.ts`, `core/opencode/__tests__/history.test.ts`, `core/pi/__tests__/PiSession.test.ts`, `core/services/__tests__/claude-permission-decision-attach.test.ts`, `main/services/__tests__/session-watcher.test.ts:43,275` (`agentIdToToolUseId: {}` stubs), `main/ipc/__tests__/{session.ipc,remote-handlers.ipc,spawn-rewiring,create-session-seed-gate,create-session-relocated-seed}.test.ts`.
- E2E/integration: `src/e2e/flows/subagent-streaming.e2e.test.ts:94-107` (`subagentMessages['sub-X']`), `windowless-boot.e2e.test.ts:133`, `src/integration/codex/codex-app-server.integration.test.ts`, `src/integration/opencode/mapper.contract.integration.test.ts`.
- Test helpers/factories: `src/test/factories/nested-agents.ts`, `src/test/helpers/{replica-seed,opencode-v2-transcript,boot-test-app}.ts`.
- Not found: any test asserting `loadSessionIntoStore` calls `loadSubagentHistory` with a non-empty `agentIdToToolUseId` (all stubs in Sidebar/InputBox/ChatPanel/useClaudeEvents tests use `agentIdToToolUseId: {}`). LEAD (probe: `grep -rn "loadSubagentHistory" src --include=*.test.*` returned only mocks returning `[]` and the main-side attachments test).

---

## 8. Flat table

| consumer                                     | file:line                                                                               | reads bucket for                                                      | hist/live/both                             | when bucket absent/empty, code literally does                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scanAgentTree` (roster tree)                | hooks/useAgentRoster.ts:289-291                                                         | discovering depth>=1 agents, their name/desc/hasResult                | both                                       | `if (bucket?.length)` false -> no children walked; nested rows absent; depth-0 rows unaffected                                                                       |
| `useAgentRoster` totals                      | hooks/useAgentRoster.ts:538-584                                                         | `tree` -> `totalCount`/`runningCount`                                 | both                                       | counts exclude agents only discoverable via buckets                                                                                                                  |
| AgentPill / AgentTab / AgentRosterList       | agents/AgentPill.tsx:31; AgentTab.tsx:37; AgentRosterList.tsx:149                       | roster counts                                                         | both                                       | `runningCount === 0 && totalCount === 0` -> `return null` (pill hidden); "Show all N" hidden when `totalCount` 0                                                     |
| `listShells`                                 | hooks/useAgentRoster.ts:313-377                                                         | locating a Bash tool_use inside a subagent (`findTaskBlocks`)         | live (`if (opts.isHistorical) return []`)  | `if (!taskBlock) continue` -> shell row skipped                                                                                                                      |
| `settleOrphans`                              | hooks/useAgentRoster.ts:452-472                                                         | parent running state of nested rows                                   | both                                       | nested rows absent, nothing to settle                                                                                                                                |
| `findTaskBlocks`                             | TaskDetailPanel/utils.ts:52-65                                                          | locate nested spawn / subagent Bash + its result                      | both                                       | returns `{taskBlock:null, resultBlock:null, ownerToolUseId:null}` for calls not in main transcript                                                                   |
| TaskCard `msgs`/`hasSubagentOutput`          | chat/TaskCard.tsx:408-413,514,785                                                       | expanded body, `failureSummary`                                       | both                                       | `msgs.length > 0` false -> body falls to `resultBody` Markdown (if `resultBody && !isBackground`) else "Running..." if `isRunning` else nothing; `failureSummary` '' |
| TaskCard status/usage/border                 | chat/TaskCard.tsx:~455-500                                                              | does NOT read bucket (notification/result/progress)                   | both                                       | unaffected                                                                                                                                                           |
| TaskEntry `msgs`/`hasSubagentOutput`         | TaskDetailPanel/TaskEntry.tsx:77-93,265                                                 | panel body                                                            | both (`isHistorical:false` hardcoded :124) | falls to bash output / `resultText` Markdown / "Running..." / null                                                                                                   |
| TaskEntry `findTaskBlocks`                   | TaskDetailPanel/TaskEntry.tsx:70-74,~89                                                 | nested agent's own spawn block                                        | both                                       | `if (!taskBlock) return null` for a nested agent whose parent bucket is absent                                                                                       |
| TaskDetailPanel descriptors                  | TaskDetailPanel/TaskDetailPanel.tsx:30-35; View.tsx:52                                  | classify entry (task / bash-background / missing)                     | both                                       | `kind:'missing'` -> `PanelEntry` returns null                                                                                                                        |
| BashBackgroundEntry                          | TaskDetailPanel/BashBackgroundEntry.tsx:44,77,219                                       | subagent's background Bash block + owner link                         | live                                       | `if (!taskBlock) return null`; owner link `ownerToolUseId &&` hidden                                                                                                 |
| MobileTaskView title                         | components/MobileTaskView.tsx:25-28                                                     | task description for header                                           | both                                       | title `'Task'` (`description                                                                                                                                         |     | 'Task'`)                                                                  |
| `findAskingBucket` / ApprovalCard            | chat/FloatingApproval.tsx:350-376,495                                                   | attribute an ask to a subagent + read its call                        | live                                       | returns `undefined` (or `{ownerToolUseId, call: undefined}` when opencode marks it) -> no `row`, no call-derived tool view/label                                     |
| `useUnmatchedApprovals`                      | chat/FloatingApproval.tsx:393-420                                                       | does NOT read buckets (deliberate)                                    | live                                       | unaffected                                                                                                                                                           |
| SubagentMessages                             | chat/SubagentMessages.tsx:72,119                                                        | none from store (props); own galleries                                | both                                       | not mounted (`msgs.length > 0 &&`)                                                                                                                                   |
| Image/Diagram gallery for subagent images    | SubagentMessages.tsx:149-150; ImageGalleryProvider.tsx:50-53                            | subagent tool_result images                                           | both                                       | no list mounted -> no subagent gallery; main gallery never included them                                                                                             |
| todos / sentFiles derivation                 | shared/derive-session.ts:25,104; reducer.ts:258,264,347-350; session-store.ts:2625-2626 | main `messages` only                                                  | both                                       | n/a (never reads buckets)                                                                                                                                            |
| find-in-chat                                 | chat/ChatSearch/chat-search.ts (DOM TreeWalker)                                         | rendered DOM only                                                     | both                                       | collapsed card has no subagent DOM, so nothing to match                                                                                                              |
| export/copy transcript, session share        | -                                                                                       | none found                                                            | -                                          | n/a                                                                                                                                                                  |
| auto-rename                                  | Sidebar/Sidebar.tsx:198-231                                                             | `session.messages` text only                                          | both                                       | n/a                                                                                                                                                                  |
| fork seed                                    | stores/session-store.ts:1391-1440                                                       | none (messages/taskNotifications/statusLine only)                     | n/a                                        | n/a (fork never carried buckets)                                                                                                                                     |
| cost / usage (statusLine)                    | core/services/session-history.ts:287-318,466-473                                        | main process reads `subagents/agent-*.jsonl` files directly           | both                                       | n/a (independent of renderer buckets)                                                                                                                                |
| row usage/runIndex/status                    | hooks/useAgentRoster.ts:394-435                                                         | `taskNotifications` / `taskProgressMap` / `activeTasks` (not buckets) | both                                       | unaffected                                                                                                                                                           |
| sidebar dot `runningSubagents`               | Sidebar/SessionItem.tsx:~72                                                             | `activeTasks` (not buckets)                                           | live                                       | unaffected                                                                                                                                                           |
| eager disk load                              | lib/session-history-load.ts:257-278                                                     | writes buckets from `agentIdToToolUseId`                              | historical (Claude)                        | `if (msgs.length > 0) subagentMessages[toolUseId] = msgs` (empty files get no key); `catch` -> `[]`                                                                  |
| `loadHistoricalSession` -> `seedColdSession` | stores/session-store.ts:2618; stores/replica.ts:523-544                                 | stores buckets in renderer replica (sealed)                           | historical                                 | `subagentMessages ?? base.subagentMessages` -> `{}` (or the evicted prior's)                                                                                         |
| replica eviction / replace-reload            | stores/replica.ts:624-639; lib/session-history-load.ts:106-111                          | wipes buckets with transcript                                         | historical                                 | `subagentMessages: {}`                                                                                                                                               |
| resync keep                                  | stores/replica.ts:419-424                                                               | copies `held.subagentMessages`                                        | both                                       | kept as held                                                                                                                                                         |
| host canonical eviction                      | core/sync/sync-core.ts:487-511                                                          | wipes buckets on engine exit                                          | live->exited                               | `subagentMessages: {}`, `seeded:false`                                                                                                                               |
| live reducer upserts                         | core/shared/sync/reducer.ts:282-283,1470,957                                            | append/merge                                                          | live                                       | bucket created with only new messages (`                                                                                                                             |     | []`)                                                                      |
| live reducer retract / review / denial       | reducer.ts:795-797; 177-184                                                             | locate message/call in a bucket                                       | live                                       | `if (!messages                                                                                                                                                       |     | index < 0) return state`; review/denial dropped when no bucket holds call |
| plugin compat event                          | main/services/plugin-manager.ts:104-112                                                 | find sealed subagent msg in canonical                                 | live                                       | `if (!session                                                                                                                                                        |     | !canonical) return` (event not fired)                                     |
| Claude resume seeds (host + client)          | core/ipc/seed-canonical-transcript.ts:42-57; lib/session-history-load.ts:515-530        | do not carry buckets                                                  | live-resume                                | n/a (no buckets today)                                                                                                                                               |
| watched-session refetch                      | hooks/useClaudeEvents.ts:184-189; reducer.ts:412-426                                    | does not carry buckets                                                | watched                                    | n/a                                                                                                                                                                  |
| Codex/pi/opencode inline readers             | codex/history.ts:553; pi-session-list.ts:466-480; opencode-session-list.ts:336-338      | return buckets inline with the history load                           | historical                                 | `subagentMessages` key omitted when empty (pi/opencode); Codex always present (possibly `{}`)                                                                        |
