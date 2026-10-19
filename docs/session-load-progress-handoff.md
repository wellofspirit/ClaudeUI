# Session-load progress — handoff + kickoff spec

Worktree: `.claude/worktrees/session-load-progress`, branch `feat/session-load-progress`, based on local
`pre-release` HEAD `e8ef6c1d` (pre-release is 41 commits ahead of origin/main — do NOT rebase onto main).

## RESUME HERE

- [x] Diagnosis + measurements (below, "Verified facts").
- [x] Audit of `subagentMessages` consumers — `docs/lazy-subagents-audit.md` (summarised in
      §"Audit for lazy subagents" below). Lazy subagent loading is a SEPARATE later arc.
- [x] Evidence for this design — collected by a reader pass (key facts copied into "Verified facts").
- [x] Design review (`orch-design-reviewer`) — ALL findings accepted;
      see "Design review resolutions" below — they OVERRIDE the sections they touch.
- [ ] Slice A: invoke progress plumbing (wire + desktop + remote + registry) + Claude byte progress.
- [ ] Slice B: navigate-first click, progress view, empty-evicted cleanup fix.
- [ ] ADR-102, gates, real-app verification, commits.

## Goal

1. A sidebar click on a session that is not resident **navigates immediately** and shows the
   loading view, instead of awaiting the whole load before `switchSession`. Today a 2–4 s (warm) /
   10 s+ (cold cache, remote) load gives no feedback at all, and a re-click restarts it.
2. The loading view shows an **accurate, monotonic progress bar** with phase, MB and an ETA, on the
   desktop renderer AND the remote web client (same renderer code).
3. Fix: an evicted, empty, locally-created session is dropped by `cleanupEmptySession` when the user
   navigates away from it, and `forgetDroppedSession` then scrubs its recents / pins / hidden /
   customTitles rows (`scrubSessionRegistry`, session-store.ts:770-779). Matches the reported
   "a recent session disappeared". It also must not happen to the new loading placeholder.

### Acceptance criteria

- Clicking an un-loaded Claude session switches the chat view to it within one frame and renders
  `TranscriptLoading` with `TranscriptLoading.progress` (role=progressbar) and
  `TranscriptLoading.detail` text; the bar advances monotonically to 100% and the transcript paints.
- Remote web client: same view and progress; a long load no longer fails at the fixed 30 s invoke
  timeout while progress frames keep arriving.
- Engines without byte progress (codex, opencode, pi) show the same view with an indeterminate bar.
- A load that fails (rejects, or ends `skipped` while still the current selection) shows
  `TranscriptLoadFailed` + Retry instead of silently not navigating.
- A superseded load (user clicked elsewhere) commits nothing, navigates nowhere, and leaves no
  progress state behind.
- An evicted (transcript-on-disk) session that is empty in memory is never dropped by
  `cleanupEmptySession`; it stays in recents / pins / hidden / customTitles.
- Claude behaviour otherwise unchanged; old web bundles against a new server and new bundles against
  an old server both still work (no progress → indeterminate).

## Verified facts (measured 2026-10-19, real Electron 41 main/renderer, warm page cache)

| stage                                                                   | 5bece358 (73 agents) | 1ae1d292 (42 agents) |
| ----------------------------------------------------------------------- | -------------------- | -------------------- |
| main parse main transcript (pass 1 + metrics pass + subagent cost fold) | ~760 ms              | ~1210 ms             |
| main parse all subagent files (renderer's per-agent invokes)            | ~940 ms              | ~1940 ms             |
| structured clone main→renderer                                          | 10–50 ms             | 10–50 ms             |
| store commit + paint                                                    | ~100 ms              | ~100 ms              |
| click → painted                                                         | 1.95 s               | 3.7 s                |

- Payload: main transcript result ≈ 1.4 MB; subagent buckets 29–40 MB (95%).
- Main parse time is ~linear in bytes read → byte progress is an accurate proxy (cold cache too).
- Desktop invokes ride `ipcRenderer.invoke` (preload/index.ts:167-170), NOT the sync MessagePort
  (sync-port.ts:105-117 ignores non-`sync` frames). Handlers never see `IpcMainInvokeEvent`
  (main/ipc/desktop-transport.ts). `hostConnection()` is one process-wide id.
- Remote: `invoke {id,channel,args}` → `handleInvoke` (remote-server.ts:3766-3792) →
  `dispatcher.handle(msg, connection)` → `commandRegistry.dispatch(channel,'remote',args,conn)`;
  the frame id never reaches the handler. Response is one JSON frame, AES-GCM + base64 when E2E.
  `sendTo(ws,msg)` is the per-connection send (also used by terminal sinks).
- Web client: `INVOKE_TIMEOUT_MS = 30_000` fixed timer per invoke (connection.ts:219, 641-662), no
  reset. `handleMessage` switch has no `default` → an unknown server frame type is silently ignored
  (connection.ts:1197). Server ignores unknown client frames (remote-server.ts:3705).
- Desktop + remote register the same channel separately (session.ipc.ts:1022-1038,
  remote-handlers.ts:800-816), same capability `fs-read`, `kind: 'query'`.
- `loadSessionHistory` (session-history.ts:1014): pass 1 `createReadStream(filePath,{encoding})`
  - readline (:1079-1088); on close → `readNestedAgentOrigins` → `computeTokenMetrics` (second full
    read of the main file, :385) → `foldSubagentCosts` (reads every `subagents/agent-*.jsonl`,
    :287-319) → `dispatchedCostsByRouting` (DB). `stream.bytesRead` is the byte counter. Read errors
    resolve empty, never reject.
- Click path: Sidebar.tsx:323-352 (quoted in evidence); `loadSessionIntoStore` result semantics
  session-history-load.ts:27-37; `opensResident`/`replaceOnClick` :321-344; `stripForReplace`
  :106-111; `reloadActiveTranscript` :427-468 sets `transcriptLoadFailed` on failure.
- ChatPanel.tsx:222-295: `loadingTranscript = !hasContent && evicted` renders
  `TranscriptLoading` (`LoadingState`, pulsing dots) or `TranscriptLoadFailed` + Retry.
- `loadHistoricalSession` (session-store.ts:2537-2630) uses an evicted prior entry as base, creates
  the entry via `patchLocalSession(..., {create:true})` (→ locallyCreated), seeds via
  `seedColdSession` (refuses only when both existing and seed have messages), then sets
  `isHistorical:true, evicted:false, transcriptLoadFailed:false`.
- `cleanupEmptySession` (session-store.ts:985-1007) drops the previously-active session iff
  locallyCreated && 0 messages && !sdkActive && !draftText — it does NOT look at `evicted`.
- Existing progress precedent: harness installer / voice pack throttle to 4/s (250 ms) and ride
  replicated broadcast events. `ProgressBar({percent: number|null, className, testid, dataId})`
  in SettingsDialog/HarnessesInstalled.tsx:99-126 (`null` = indeterminate pulse).

## Chosen design (forks decided by Daniel 2026-10-19: steps 1+2 now; lazy subagents later; sidebar

count "5 vs 3" NOT changed)

### Wire: `invoke-progress` (ADR-102, additive)

```ts
// src/shared/remote-protocol.ts
export interface InvokeProgress {
  /** Units done so far (bytes for the Claude history read). Monotonic per call. */
  done: number
  /** Units in total, or null when unknown (indeterminate). */
  total: number | null
  /** Handler-defined phase label; the generic 'sending' is added by the transport. */
  phase: string
  /** Optional handler-specific planning hints, e.g. { subagentBytes } for a Claude history read. */
  parts?: Record<string, number>
}
export interface WsInvokeProgress extends InvokeProgress {
  type: 'invoke-progress'
  id: string
}
```

Add to `WsServerMessage`. No version bump: additive frame, old clients ignore it, old servers never
send it.

### Registry: `withProgress`

- `CommandRegistration.withProgress?: boolean` — prepend a `ProgressReporter`
  (`(p: InvokeProgress) => void`) to the handler args, AFTER the connection when both are set
  (`handler(connection?, progress, ...wireArgs)`). Leading position for the same reason as
  `withConnection`. Declared channel-global (must agree across transports, like capability/kind).
- `dispatch(channel, transport, args, connection, progress?: ProgressReporter)`: when the entry is
  `withProgress`, pass `progress ?? noop`. A reporter given for a non-progress entry is ignored.
- The reporter the transport supplies is **throttled** in one shared helper
  (`createProgressThrottle(send, 250)`: first report immediate, then ≤ 4/s, the latest value always
  flushed; `done === total` flushed immediately). Handlers report freely.

### Desktop transport

- One extra ipcMain channel bound once in `installDesktopTransport`:
  `invoke:with-progress` → `(event, callId: string, channel: string, ...args)` →
  `dispatchDesktop(channel, args, reporter)` where the reporter does
  `event.sender.send('invoke:progress', callId, p)` (guard `!event.sender.isDestroyed()`).
  Capability check and audit are the same `commandRegistry.dispatch` choke point.
- Preload: an internal `invokeWithProgress(channel, args, onProgress)` — random callId,
  one shared `ipcRenderer.on('invoke:progress')` router map, cleaned up in `finally`.
- `invoke:progress` is a host-local IPC message, not a sync channel (do not add it to channels.ts).

### Remote transport

- Server `handleInvoke`: build a throttled reporter that `sendTo(ws, {type:'invoke-progress',
id: msg.id, ...p})` and pass it to `dispatcher.handle(msg, connection, reporter)`. For an entry
  with `withProgress`, send one `{phase:'sending', done:0, total:null}` progress frame right before
  the `invoke-response` (so the client can say "Receiving…" while a large frame transfers).
- Web `RemoteConnection`: `invoke(channel, ...args)` unchanged; add
  `invokeWithProgress(channel, args, onProgress)`. `PendingInvoke` gains `onProgress?`; on an
  `invoke-progress` frame for a pending id: call it and **re-arm the timeout** (sliding 30 s from the
  last frame). The step-up retry (`invokeGate`, fresh id) must carry `onProgress` through.

### API surface

- `ClaudeAPI.loadSessionHistory(sessionId, projectKey, resumeSessionAt?, onProgress?)` — preload and
  `web/api-adapter.ts` use the progress path only when `onProgress` is given. (contextBridge proxies
  the callback.) Other `ClaudeAPI` methods untouched.
- Main: `readSessionHistory(sessionId, projectKey, anchor?, engineId?, onProgress?)` (engine-history.ts)
  passes it to the Claude reader only. `loadSessionHistory(sessionId, projectKey, resumeSessionAt?,
onProgress?)`. Other callers (seed-canonical-transcript, session-manager, session-watcher,
  automation-manager) pass nothing.
- Claude result gains `subagentFileBytes: Record<string /*agentId*/, number>` (sizes of
  `subagents/agent-<id>.jsonl` that exist) so the renderer can weight its per-agent fetches.

### Main: Claude byte progress (session-history.ts)

- Up front (sync `statSync`, cheap): `mainBytes`, and `subagentBytes` = sum of sizes of
  `<sessionId>/subagents/agent-*.jsonl` (the same set `foldSubagentCosts` reads). Total =
  `2 * mainBytes + subagentBytes` (pass 1 + metrics pass + cost fold). Report
  `{done:0,total,phase:'transcript',parts:{subagentBytes}}` immediately.
- Pass 1: report `stream.bytesRead` (phase `transcript`). Metrics pass: `mainBytes + bytesRead`
  (phase `costs`). Cost fold: add each subagent file's bytes as it is read (phase `costs`). Final
  `done = total` before resolving. Clamp `done ≤ total` (a live file can grow).
- Thread an optional `onBytes(n)` callback through `computeTokenMetrics` / `foldSubagentCosts` /
  `foldSubagentFile` rather than duplicating loops. Keep every existing behaviour and return value.
- Fork-anchored reads (`resumeSessionAt`) may stop early / skip agents: on resolve, emit `done=total`.

### Renderer: aggregation + navigate-first

- `loadSessionIntoStore(info, { ..., onProgress?: (p: TranscriptLoadProgress) => void })`.
  `TranscriptLoadProgress = { fraction: number | null; phase: 'reading' | 'subagents' | 'receiving'
| 'rendering'; doneBytes: number; totalBytes: number | null; etaMs: number | null }`.
  Claude: overall total = historyTotal + parts.subagentBytes (known from the first frame → monotonic).
  During the history call: done = frame.done. `phase:'sending'` → 'receiving' (fraction keeps its
  last value). Subagent phase: done = historyTotal + Σ `subagentFileBytes[agentId]` of completed
  fetches. Before commit: phase 'rendering', fraction 1. ETA: `elapsed * (1-f)/f` once f ≥ 0.05 and
  elapsed ≥ 300 ms, else null. Non-Claude engines: one `{fraction:null, phase:'reading'}`.
  No progress frames at all (old server) → fraction null.
- Store (view-only, per session, NOT replicated/sealed): `transcriptLoadProgress:
TranscriptLoadProgress | null` in `PerSessionState` (default null) + action
  `setTranscriptLoadProgress(routingId, p | null)` (no-op for unknown ids). Cleared by
  `loadHistoricalSession`'s final set and by every exit path of the click/reload.
- New store action `beginTranscriptLoad(routingId, cwd)`: if no entry exists, create one exactly as
  `loadHistoricalSession` would (`patchLocalSession(..., {create:true})`) and apply
  `evictedViewPatch` (evicted:true, isHistorical:true) so ChatPanel renders `TranscriptLoading`; if an
  entry exists (evicted+idle), only mark evicted. Never touch a live entry.
- `handleClickSession` (Sidebar.tsx): if `opensResident` → unchanged. Else: `beginTranscriptLoad`,
  `switchSession(routingId)`, close the mobile drawer, then `loadSessionIntoStore(..., {onProgress:
p => setTranscriptLoadProgress(routingId, p)})`. Afterwards (always, `finally`): clear progress.
  Result `skipped` or a throw while `isCurrent()` → `setTranscriptLoadFailed(routingId, true)`;
  superseded → nothing. `declined` → nothing more (already navigated). Wrap in try/catch: the click
  must never reject unhandled.
- `reloadActiveTranscript` gets the same `onProgress` wiring (it already shows TranscriptLoading).
- `cleanupEmptySession`: additionally keep the entry when `session.evicted` (an evicted entry is a
  transcript on disk, never an abandoned scratch session). Document why next to the existing doc.

### UI (ChatPanel.tsx TranscriptLoading)

- Keep `LoadingState label="Loading conversation..."`; below it, when `transcriptLoadProgress` is
  set: `<ProgressBar percent={fraction===null?null:round(fraction*100)} testid=
"TranscriptLoading.progress" className="w-56 mt-3" />` and a `data-testid="TranscriptLoading.detail"`
  line, `text-[12px] text-text-muted tabular-nums`: e.g. "Reading transcript · 12.3 of 40.1 MB ·
  ~3 s left", "Loading 73 subagents · …", "Receiving…", "Rendering…". Bytes via the existing
  `formatBytes` helper. Width transition `transition-[width] duration-200`.
- Move `ProgressBar` to `src/renderer/src/components/shared/ProgressBar.tsx` and update its importers
  (HarnessesInstalled.tsx, HarnessInstallBanner.tsx, HarnessUpdateButton.tsx) — no behaviour change.

## Design review resolutions (2026-10-19) — these OVERRIDE the design sections above

- **R1 identity.** `beginTranscriptLoad(info: SessionInfo)` (not `(routingId, cwd)`) must apply the
  same identity block `loadHistoricalSession` applies (session-store.ts:~2555-2605: persisted engine,
  `bootstrapPermissionMode`, model, `status.engineId`/capabilities). Extract that block into ONE
  helper used by both. For opencode/pi call `seedHistoricalEngine(routingId, engineId, null)` before
  the read (idempotent; the post-read call still fills `lastModel`). With that, `loadHistoricalSession`'s
  `base = prior` (evicted) branch is correct for the placeholder.
- **R2 in-flight registry.** Rename `reloadsInFlight` → `loadsInFlight` (keyed by routingId) and
  register the CLICK load there too, so `awaitReloadBeforeSpawn` (InputBox send) waits for it.
  `handleClickSession`: if a load for that routingId is already in flight → treat as resident
  (`switchSession` + drawer only; no second load). This removes the double-click restart.
  Keep `awaitTranscriptReload`'s contract (resolves on every outcome).
- **R3.** `withProgress` joins the channel-global `Declaration`/`CommandEntry` and the existing
  cross-transport conflict assert (command-registry.ts:~643-661); both `session:load-history`
  registrations (session.ipc.ts and remote-handlers.ts) declare it.
- **C1 no `parts`.** Drop `parts` from `InvokeProgress`. The Claude history handler plans the whole
  job: first frame `total = 2*mainBytes + 2*subagentBytes` (pass 1 + metrics pass + cost fold + the
  client's subagent fetches); its own last report is `done = 2*mainBytes + subagentBytes` (NOT
  `total`). The renderer continues from that `done`, adding `subagentFileBytes[agentId]` per completed
  fetch, reaching `total`. Renderer must clamp to `total` and handle an old server (no frames).
  Document this in the `loadSessionHistory` JSDoc + ADR-102 (the second `subagentBytes` is removed by
  the later lazy-subagent arc).
- **C2 bounded fan-out.** Subagent fetches in `loadSessionIntoStore`: at most 4 in flight, largest
  `subagentFileBytes` first (agents without a size last). Same result shape.
- **C3 reporter lifecycle.** Transport sequence for a `withProgress` call: handler resolves → flush the
  throttle's pending value → send `{phase:'sending', done:<last done>, total:<last total>}` (remote
  only) → send the response → close the reporter (later calls no-op, pending timer cleared). Desktop:
  flush → close before the invoke resolves.
- **C4.** `cleanupEmptySession` keeps entries with `evicted || isHistorical` (a Claude read error
  resolves EMPTY, so a failed load can land `evicted:false, isHistorical:true, 0 messages`).
  Test both flags.
- **C5.** Web `RemoteConnection.onclose` rejects every pending invoke (clear timers) — a response can
  never arrive on a closed socket. Check `whenCredentialsChanged` / reconnect paths still behave.
- **C6.** Progress writes and the final clear are guarded by `isCurrent()` (with R2 there is only one
  load per id, but keep the guard).
- **C7 (accepted, documented).** A full (non-resync) hydrate replaces `sessions` and can drop the
  placeholder / move selection; the in-flight load then commits without navigation. Rare; note in
  code comment, no handling.
- **C8 (documented).** New bundle vs old server: no progress frames, fixed 30 s timeout as today.
- **N1** Claude phases typed as a shared union `'transcript' | 'costs' | 'sending'`; renderer maps
  unknown → 'reading'. **N2** drop the 'rendering' phase (set fraction 1 before commit, no label).
  **N3** `invoke:with-progress`: `removeHandler` first, `typeof channel === 'string'` assert, and
  `invokeWithProgress` is NOT exposed on contextBridge (only the named wrapper). **N4** add
  `transcriptLoadProgress: null` to `EMPTY_SESSION_STATE`, pin it in the test that pins
  `transcriptLoadFailed`. **N5** ChatPanel selects `transcriptLoadProgress` with a field selector.

Revised renderer phases: `'reading' | 'subagents' | 'receiving'`.

## Out of scope

- Lazy subagent loading (next arc; audit below). Sidebar "5 vs 3" count. Chunked responses / byte
  progress of the WS transfer itself. Sync-full / hydrate progress (measure the host snapshot first).
  Moving the parse off the main thread. Cancelling superseded loads. pi/codex/opencode byte progress.

## Edge cases

- Double click on the same row while loading: second click bumps selectionSeq → first load becomes
  superseded, second runs; the entry is evicted+idle so `opensResident` is false → re-load. Acceptable
  (same as today) but the view must not flash failed.
- User clicks A then B before A finishes: A commits nothing, its progress cleared, A's placeholder
  stays evicted (re-clicking reloads); B behaves normally; A NOT dropped from recents (fix 3).
- Click while the session goes live mid-load (a prompt): existing `isLive` commit-time checks keep
  working; the placeholder must not block `InputBox`'s lazy spawn (`awaitReloadBeforeSpawn`).
- Web: E2E on and off; step-up retry; a connection drop mid-load rejects the pending invoke → failed
  state + Retry.
- Mobile layout: the progress block fits 412 px wide at uiFontScale 1.5.
- `event.sender` destroyed (window reload) mid-load: reporter no-ops.

## Tests that must exist (and what they must catch)

1. registry: `withProgress` prepends the reporter in the right position (with and without
   `withConnection`); noop when the transport supplied none; ignored for a non-progress entry.
2. throttle helper: first immediate, ≤ 1 per interval, last value flushed, completion flushed.
3. session-history: progress reports are monotonic, start at 0 with the right total and
   `parts.subagentBytes`, end at `done === total`; `subagentFileBytes` matches fixture file sizes;
   result otherwise identical to the no-progress call (deep-equal).
4. remote-server: an invoke on a `withProgress` channel emits `invoke-progress` frames with the
   request id and a `sending` frame before the response; a non-progress channel emits none.
5. web connection: progress frames call `onProgress` and re-arm the timeout (fake timers: a call
   with a frame every 20 s survives 60 s; without frames it still times out at 30 s); unknown id
   ignored; step-up retry keeps `onProgress`.
6. session-history-load: aggregation is monotonic across history + subagent phases, ETA null early,
   `receiving` on `sending`, non-Claude → indeterminate.
7. Sidebar click (component): navigates before the load resolves; progress shown; failure → failed
   state; superseded → no navigation back, no failed flag.
8. session-store: evicted+empty+locallyCreated active session survives `switchSession` and stays in
   recents/pins (MUST fail on pre-fix code).
9. ChatPanel: renders progress bar + detail from `transcriptLoadProgress`; indeterminate when null
   fraction; existing TranscriptLoading/Failed tests still pass.

## Developer test

`bun run typecheck && bun run lint && bun run test` (report exact summary lines; pre-existing
failures: see memory "Known pre-existing test failures" — vscode-web-service probeCli on darwin,
remote-*.test.ts flakes under parallel load; rerun those in isolation). Also run the touched
remote/web test files in isolation.

## Gotchas

- `src/core/ipc/command-registry.ts` contains non-ASCII bytes — use `grep -a`.
- `subagentMessages` and other sealed fields may only be written in `stores/replica.ts` (eslint rule).
  `transcriptLoadProgress` is a store-only view field — do NOT add it to sealed-fields or the replica.
- Never `bun install`/`add`. Never commit / `git add` / branch. Format only touched files.
- `vendor/` in this worktree is an untracked symlink dir — never stage it.
- The Electron app for verification: `bun run build` then `scripts/app-shot.mjs` with an isolated
  `HOME` holding cloned copies (`cp -cR`) of `~/.claude/projects/<key>` + `~/.claude/ui/{sessions,
settings,directory-cache}.json`. Never point a second instance at the real `~/.claude`.

## Audit for lazy subagents (next arc — evidence only, summarised)

Full report: `docs/lazy-subagents-audit.md`..

- Depth-0 agents (TaskCards, roster rows, status/usage/runIndex) come from the main transcript +
  `taskNotifications` — unaffected by an absent bucket.
- Bucket-dependent when absent: nested-agent discovery + their name/desc/hasResult
  (`scanAgentTree`, useAgentRoster.ts:289-291) and roster totals; TaskCard expanded body and
  `failureSummary` (`hasSubagentOutput`, TaskCard.tsx:408-413,514,785); TaskEntry body / nested
  lookup; `findTaskBlocks` (TaskDetailPanel `kind:'missing'`); MobileTaskView title.
- Live-only bucket readers (approvals `findAskingBucket`, reducer `attachToToolUse`, retract,
  `listShells`, plugin-manager) — live buckets are stream-filled; unaffected by a lazy DISK load.
- Not readers: todos/sentFiles (main messages only), find-in-chat (DOM), auto-rename, fork seed,
  cost (`statusLine` is folded in main from the files), image galleries (per-bucket provider via
  prop). No export/copy feature exists.
- `agentIdToToolUseId` already includes nested agents via sidecars (`readNestedAgentOrigins`,
  session-history.ts:1451-1462) — but not their parent or spawn name/description, which the roster
  needs. A lazy design needs a small per-agent index (agentId, origin toolUseId, parent, name,
  description, hasOutput) from main, or must load parents on demand.
- Non-Claude engines return buckets inline (Codex, pi, and opencode — the renderer comment
  "opencode returns none" contradicts `opencode-session-list.ts:336-338`; probe before relying on it).

## Slice A implementer report (2026-10-19, not self-certified)

Landed (wire + transports + registry + Claude byte progress + web connection fixes; no renderer/Slice B work):

- Wire: `InvokeProgress` (no `parts`), `WsInvokeProgress`, `ProgressReporter`, `SessionHistoryPhase = 'transcript' | 'costs' | 'sending'`
  in `src/shared/remote-protocol.ts`; `WsInvokeProgress` is in `WsServerMessage`.
- `src/shared/progress-throttle.ts`: `createProgressThrottle(send, 250)` -> `{report, flush, close, last}` (first immediate,
  <= 1 per 250 ms, latest flushed, `done >= total` immediate), `noopProgress`, and the two host-local desktop IPC names.
- Registry (`command-registry.ts`): `withProgress` on `CommandRegistration`/`Declaration`/`CommandEntry`, part of the
  cross-transport conflict assert; `dispatch(..., progress?)`; arg order `handler(connection?, progress, ...wireArgs)`; no-op reporter
  when none supplied; reporter ignored for non-progress entries. `RemoteDispatcher.handle(msg, conn, progress?)` + `reportsProgress(channel)`.
- Desktop: `invoke:with-progress` in `src/main/ipc/desktop-transport.ts` (removeHandler first, typeof assert, sender-destroyed guard,
  flush -> close before resolve; a failing call drops its tail); `dispatchDesktop(channel, args, progress?)`; preload internal
  `invokeWithProgress` + `invoke:progress` router (not on contextBridge); `loadSessionHistory(..., onProgress?)` uses it only with a callback.
- Remote server `handleInvoke`: per-call throttled reporter bound to the requesting ws; C3 order flush -> `sending` -> response -> close for
  `withProgress` channels; none for others; error path closes without a tail.
- Web: `RemoteConnection.invokeWithProgress`; `invoke-progress` frames call `onProgress({done,total,phase})` and re-arm the 30 s timer
  (sliding, for every pending call incl. plain `invoke`); unknown id ignored; step-up retry keeps `onProgress`; `onclose` rejects every pending
  invoke with `Connection lost: <channel>` and clears timers; `api-adapter.loadSessionHistory` passes `onProgress` through.
- Main: `readSessionHistory(..., onProgress?)` (Claude reader only); `loadSessionHistory(sessionId, projectKey, resumeSessionAt?, onProgress?)`
  with the C1 byte plan (JSDoc'd): total = 2*M + 2*S, first report `done: 0`, own last report `done = 2*M + S`, per-pass clamps, raw
  `stream.bytesRead`; optional `onBytes` threaded through `computeTokenMetrics` / `foldSubagentCosts` / `foldSubagentFile`;
  `subagentFileBytes: Record<agentId, number>` on the result and in the `ClaudeAPI.loadSessionHistory` return type (optional field).
- Both `session:load-history` registrations declare `withProgress: true` and take the reporter first.

Deviations / judgement calls:

- `onclose` rejection uses the message `Connection lost: <channel>` and `isInvokeTimeout` (renderer util) now also matches it, so the
  harness/voice-pack callers that treat "Timeout:" as "the host may have finished" keep doing so when the socket drops. Touches
  `src/renderer/src/utils/ipc-error.ts` (+ test).
- Close 4008 defers the pending-invoke rejection by one macrotask (`setTimeout 0`): `authcfgSetPassword` races `invoke` against
  `whenCredentialsChanged` and the close is the success signal there; a synchronous rejection could win that race (guard test included).
- `subagentFileBytes` is optional in the TypeScript types (non-Claude engines never produce it); Claude's success result always sets it
  (also without a progress callback). Error/empty resolutions omit it.
- The existing `engine-history.test.ts` assertion for the legacy-Claude call gained the trailing `undefined` 4th arg.
- A fork-anchored read that errors/returns empty (`rl` error) does not emit a final report (renderer must clamp / tolerate).
- `discardSocket()` (connect() over a live socket) does not reject pending invokes (only `onclose` does, per C5); noted, not changed.

Tests (new unless noted): `src/main/ipc/__tests__/command-registry.test.ts` (+6 `withProgress`), `src/shared/__tests__/progress-throttle.test.ts`,
`src/main/services/__tests__/session-history-progress.test.ts`, `src/main/services/__tests__/remote-server.test.ts` (+4 invoke progress),
`src/web/__tests__/connection.test.ts` (+7), `src/web/__tests__/api-adapter.test.ts` (+2), `src/main/ipc/__tests__/desktop-transport.test.ts`,
`src/preload/__tests__/preload-invoke-progress.test.ts`, `src/main/ipc/__tests__/remote-handlers.ipc.test.ts` (+1),
`src/core/codex/__tests__/engine-history.test.ts` (+1), `src/renderer/src/utils/__tests__/ipc-error.unit.test.ts` (+1).
Each was checked red against a targeted mutation of the fix (scratchpad `red.py`, one or more mutations per behaviour, all RED once the live-file-growth test was added).

Not done (Slice B / later): renderer aggregation, store, ChatPanel, Sidebar navigate-first, cleanupEmptySession, ADR-102, `docs/architecture/remote.md`.

## Orchestrator review of Slice A (2026-10-19)

Reviewed every hunk; typecheck exit 0; 12 touched files 531/531 green (re-run independently);
guard proven red: dropping the reporter in `RemoteServer.handleInvoke` fails "emits invoke-progress
frames with the request id, then `sending`, then the response". Accepted, including deviations 1–8.
Open questions answered: (1) `discardSocket` rejecting pending invokes — not now (handlers are
detached, calls time out as before). (2) No final progress report on a read error — correct; the
renderer must tolerate a stream that stops short. (3) ADR-102 + remote.md — orchestrator writes them.

## Slice B brief (dispatched 2026-10-19)

Implement the renderer half: spec sections "Renderer: aggregation + navigate-first", "UI", the
`cleanupEmptySession` fix, as amended by "Design review resolutions" (R1, R2, C2, C4, C6, C7 comment,
N1, N2, N4, N5). Additional orchestrator notes:

- `subagentFileBytes` lists EVERY `agent-*.jsonl` on disk, but the renderer fetches only the agents in
  `agentIdToToolUseId` (and some listed agents have no file → size missing). So: the subagent phase's
  done = historyLastDone + Σ sizes of completed fetches; treat a missing size as 0; and before commit
  set fraction 1. Never let the computed fraction exceed 1 or go backwards.
- The overall total comes from the FIRST progress frame's `total`; with no frames (old server,
  non-Claude engine) fraction stays null (indeterminate). Map phases: `transcript`/`costs` →
  'reading', the renderer's own fetch stage → 'subagents', `sending` → 'receiving', unknown → 'reading'.
- Bounded fan-out: ≤ 4 subagent fetches in flight, largest size first.
- Detail text examples: "Reading transcript · 12.3 of 40.1 MB · ~3 s left", "Loading 73 subagents ·
  31.0 of 40.1 MB · ~1 s left", "Receiving…". Use the existing `formatBytes` (find it; do not add a
  second one). ETA format: "~N s left" (< 60 s) / "~N min left".
- Move `ProgressBar` to `src/renderer/src/components/shared/ProgressBar.tsx`; update importers.
- Mobile: the progress block must fit 412 px width (no overflow) — `w-56 max-w-[80vw]` or similar.
- Tests: spec "Tests that must exist" items 6–9, plus: R1 (placeholder keeps the persisted permission
  mode / engine / model — must fail if `beginTranscriptLoad` used `emptySession` defaults), R2 (a send
  during a click load awaits it; a second click on a loading session does not start a second load),
  C4 (both `evicted` and `isHistorical` empty entries survive switchSession and stay in
  recents/pins/hidden/customTitles — must fail on pre-fix code), C6.
- Gates: typecheck, lint, touched tests in isolation, then the non-browser projects
  (`bunx vitest run --project unit --project unit-node --project component --project e2e`). The
  browser project cannot load from this worktree (node_modules symlink outside Vite's allow list) —
  the orchestrator runs it from a proper checkout.

## Slice B implementer report (2026-10-19, not self-certified)

Landed (renderer half; Slice A files untouched):

- `lib/transcript-load-progress.ts` (new): `TranscriptLoadProgress` (`fraction|null, phase 'reading'|'subagents'|'receiving', doneBytes,
totalBytes|null, etaMs|null, subagents|null`), `createLoadProgress` state machine (total from the FIRST frame, `done` only rises, subagent
  fetches add `subagentFileBytes[agentId]` with a missing size = 0, clamped to the total, `finish()` = 100% only when a total is known,
  ETA withheld until >= 5% and >= 300 ms), `describeTranscriptLoad`, `formatEta`. Phase map: transcript/costs/unknown -> reading,
  sending -> receiving (no 'rendering', N2).
- `lib/session-history-load.ts`: `loadSessionIntoStore(..., {onProgress})` (writes guarded by `isCurrent`; non-Claude = one indeterminate
  frame; the 4-arg `loadSessionHistory` call only when a callback is given); subagent fetches bounded to 4 in flight, largest file first,
  missing size last, result assembled in listing order (C2); `reloadsInFlight` -> `loadsInFlight` (R2) with `trackTranscriptLoad`,
  `isTranscriptLoadInFlight`, `loadClickedSession` (never rejects; failed flag on reject/`skipped` only while still the selection; progress
  cleared on settle by registration identity) and `beginTranscriptPlaceholder` (seeds opencode/pi/Codex engine, then the store action);
  `reloadActiveTranscript` feeds progress too. C7 noted in a comment.
- `stores/session-store.ts`: `transcriptLoadProgress` in `PerSessionState`/`EMPTY_SESSION_STATE` (N4), `setTranscriptLoadProgress`,
  `historicalIdentity` helper extracted from `loadHistoricalSession` and shared with the new `beginTranscriptLoad(info)` (R1),
  `loadHistoricalSession`'s final set clears progress, `cleanupEmptySession` keeps `evicted || isHistorical` entries (C4).
- `components/Sidebar/Sidebar.tsx`: navigate-first click (`beginTranscriptPlaceholder` -> `switchSession` -> drawer close ->
  `loadClickedSession`); a load already in flight counts as resident.
- `components/chat/ChatPanel/ChatPanel.tsx`: `TranscriptLoading.progress` / `.detail` from a field selector (N5); `LoadingState` takes children.
- `components/shared/ProgressBar.tsx` (moved from HarnessesInstalled; importers updated; new opt-in `smooth` prop).

Deviations:

1. The click's currency token is `selectionTarget` (the last-clicked routing id), not a numeric `selectionSeq`: with a counter, clicking
   A, B, then A again (A's load still running, R2 says do not restart) would leave A's load superseded and the spinner stranded.
   Superseding by a different id behaves exactly as before.
2. Progress is cleared on settle by "I am still the registered load" rather than by `isCurrent` (C6 literal): a superseded load must also
   leave no progress behind (acceptance criterion), and identity still protects a newer load of the same id.
3. `TranscriptLoadProgress` gained `subagents: number | null` (the count shown in "Loading 73 subagents").
4. `max-w-[80vw]` is rejected by the ADR-093 zoom-trap lint rule; the progress block is `w-56 max-w-[90%]` (percent of its container).
5. Detail text drops the repeated unit ("12.3 of 40.1 MB") by post-processing the existing `formatBytes` output; no second formatter.
6. `isInvokeTimeout` and everything else from Slice A untouched. `formatBytes` is imported from `SettingsDialog/harness-view` (the only one).
7. `setTranscriptLoadProgress` is an exported function (like `setTranscriptLoadFailed`), not a store action.

Tests: `lib/__tests__/transcript-load-progress.unit.test.ts`, `lib/__tests__/session-history-load-progress.unit.test.ts`,
`stores/__tests__/session-store-transcript-load.component.test.ts`, `components/shared/__tests__/ProgressBar.component.test.tsx`,
extended `Sidebar.component.test.ts` (6 navigate-first tests) and `ChatPanel.component.test.tsx` (5 load-progress tests); N4 pinned in the
two PerSessionState literals (`MessageBubble.unit.test.tsx`, `renderToolBlock.test.tsx`) and in the store test. Red-proof: `red_b.py`
(scratchpad), ~35 targeted mutations, plus the HEAD version of `Sidebar.tsx` (6 Sidebar tests fail).

## Orchestrator review of Slice B (2026-10-19)

Reviewed every source hunk (transcript-load-progress.ts, session-history-load.ts, Sidebar.tsx,
session-store.ts, ChatPanel.tsx, ProgressBar move). Deviations 1–7 accepted (selectionTarget instead
of a counter is right for R2's re-adopt case). One REQUIRED change sent back: `describeTranscriptLoad`
printed the planned byte total (2M+2S ≈ 2× the on-disk size) as "x of y MB" — replace with a
percentage ("Reading transcript · 42% · ~3 s left"); drop the SettingsDialog `formatBytes` import.

Slice B follow-up (orchestrator-required): `describeTranscriptLoad` now prints a percentage (`Reading transcript · 42% · ~3 s left`,
`Loading 73 subagents · 87% · ~1 s left`, `Receiving…`; label only when the fraction is unknown) instead of MB, because the planned total is
~2x the real size; floor, so it never reads 100% early. The `formatBytes` import is gone. `doneBytes`/`totalBytes` stay on the type.

## Verification brief (orch-verifier, 2026-10-19)

Build: `out/` of this worktree (`bun run build` in the gate chain). App: `node scripts/app-shot.mjs`
run FROM THE WORKTREE with `HOME=<scratch>/vhome` where vhome holds APFS clones (`cp -cR`/`cp -c`) of
`~/.claude/projects/-Users-daniel-liu-work-dp360-migration-app-v4` and
`~/.claude/ui/{sessions.json,settings.json,directory-cache.json}`. NEVER the real `~/.claude`;
never `--with-remote` (the owner's app is running). Default headless. Assert DOM/state first
(`--eval`, `window.__claudeuiVerifier`), screenshots second.

Claims:

1. Navigate-first: after clicking app-v4's "Continuing session e86a8c8c handoff"
   (`[data-testid="DirectoryItem"] [data-testid="SessionItem"][data-id="5bece358-…"]`), within
   ≤ 100 ms `activeSessionId` is that id and `[data-testid="TranscriptLoading"]` is in the DOM with
   `TranscriptLoading.progress` (role=progressbar) and `TranscriptLoading.detail`.
2. Progress: sample `aria-valuenow` + detail text every ~50 ms until the transcript paints: values
   never decrease, reach ≥ 90 before paint, detail shows "Reading transcript · N%" then
   "Loading 73 subagents · N%" (an ETA "~N s left" appears at some point); final paint has
   `MessageBubble` count 398 and no TranscriptLoading.
3. A second click on the same row while loading does not reset progress (no value drop) and the load
   still lands once.
4. Click 5bece358 then immediately "Session 08e65545 continuation" (1ae1d292): 1ae1d292 ends active
   and painted (520 bubbles); 5bece358 shows no TranscriptLoadFailed, has no
   `transcriptLoadProgress`, and both ids remain in `recentSessionIds`.
5. Clicking back to 5bece358 afterwards loads and paints it.
6. Mobile: `--profile s25-ultra-edge --font-scale 1.5 --overflow-audit`, screenshot taken ~300 ms
   after the click while TranscriptLoading is visible: `OVERFLOW []` and the bar + detail fit.
7. Regression: an already-loaded session re-click opens instantly (no TranscriptLoading); Settings →
   Installed harnesses page still renders its ProgressBar-using UI without console errors.
   Report: per claim the exact eval output, the screenshot paths, consoleErrors. Not in scope (gap):
   remote web client in a real browser, non-Claude engines (no such sessions in the clone).
