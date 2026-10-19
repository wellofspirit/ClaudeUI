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
- [x] Slice A: committed 36e90044.
- [x] Slice B: committed 2c2dea97.
- [x] ADR-102, gates (typecheck/lint/test/test:ci/build all exit 0), real-app verification (claims 1–6 PASS, 7 partial).
- [ ] NEXT: push + PR (owner's call); then the lazy-subagent arc (docs/lazy-subagents-audit.md).

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

---

# Arc 2 (same PR): content-first load, background status line, lazy + background subagents

Decided by Daniel 2026-10-19 after the tail-first exploration (rejected: the main transcript parse is
only ~60 ms; see "Measured" below). Amends ADR-102 (byte plan + phases).

## Measured (Electron main, warm cache, current branch)

| phase | 5bece358 (73 agents, 387 MB subagents on disk) | 1ae1d292 (42 agents, 834 MB) |
|---|---|---|
| main transcript pass (all messages) | 58–82 ms | 46–54 ms |
| cost/status pass (main file again + EVERY subagent file) | 580–720 ms | 1120–1220 ms |
| renderer fetch of all subagent transcripts | ~900 ms | ~1900–2000 ms |

Tail-first rejected because (evidence pass, all FACT): the Claude reader is order-dependent
(tool_results before the cut dropped, notifications lose toolUseId, unfinished/runIndex need the whole
file, 230/325 assistant ids span lines); no prepend primitive exists (replica/reducer append/upsert
only, `seedColdSession` refuses non-empty-over-non-empty); a send after a tail commit spawns at once
and the older part can then never land (live guard + no-clobber); todos/sentFiles/galleries/roster/
fork index are whole-array derivations; no scroll-anchor compensation.

## Goal / acceptance

1. Click → the conversation (ALL messages) paints after the transcript pass only (~60 ms + transfer),
   with the context meter if cheaply derivable; the full-screen loader only covers that phase.
2. A thin background bar directly under the chat TopBar (`ChatPanel.backgroundLoad`,
   role=progressbar, 2 px, accent) shows the background phase: the status line (cost/tokens) and the
   subagent transcripts loading. It disappears when both are done. Detail on hover (title attr), e.g.
   "Loading usage and 73 subagents · 42%".
3. Footer status line shows a pending state (not zeros) until the background status line lands.
4. Subagent transcripts: background prefetch (≤ 2 in flight, newest agents first — by spawn position
   in the main transcript, descending — but parents of nested agents BEFORE everything else so the
   roster tree completes first). Expanding a TaskCard / opening a task-panel entry whose bucket is
   missing requests it at top priority and shows a small "Loading…" body until it lands.
5. Navigating away from the session cancels its remaining background queue (in-flight calls finish
   but their results are still committed only if the bucket is still empty and the session still
   resident); re-activating a resident session restarts the queue for missing buckets.
6. Session start during the background phase: the late status line is applied only if the session is
   not live (else dropped — the live session computes its own); subagent fills are fill-only (skip a
   non-empty bucket, skip agents that are running per activeTasks/notifications) and never block a
   send. `awaitReloadBeforeSpawn` waits only for the CONTENT phase.
7. Remote web client: identical behavior. Version skew is ONE-directional (ADR-060/099: the web
   bundle is served by the host it talks to): only an OLD bundle in a tab left open across a desktop
   update can talk to a NEW host — it omits `deferStatusLine` and gets the full result, as today. A
   new bundle never meets an old host, so there is NO old-server fallback path in the renderer.
8. Non-Claude engines unchanged (their readers return buckets inline; no background phase).

## Design

Main / wire:
- `session:load-history` gains an optional 4th wire arg `options?: { deferStatusLine?: boolean }`
  (both registrations; old clients omit it → unchanged full behavior incl. statusLine). With
  `deferStatusLine`, `loadSessionHistory` skips `computeTokenMetrics`/`foldSubagentCosts`/
  `dispatchedCostsByRouting` and returns `statusLine: null` plus `statusLineDeferred: true`. Its byte
  plan becomes `total = M` (transcript pass only, phase `transcript`; last report done = M).
  Other callers (seed-canonical-transcript, session-watcher, session-manager, automation-manager)
  are unchanged (full, with statusLine).
- New query channel `session:load-history-status(sessionId, projectKey, resumeSessionAt?)`,
  `capability:'fs-read'`, `withProgress:true`, both transports, preload + web adapter +
  `ClaudeAPI.loadSessionStatusLine(sessionId, projectKey, resumeSessionAt?, onProgress?)`. Returns
  the same `StatusLineData` loadSessionHistory computes today (metrics pass + subagent cost fold +
  dispatched-cost merge — extract that block into one function used by both paths; byte plan
  `total = M + S`, phase `costs`).
- Replace `subagentFileBytes` with `subagentIndex: Record<toolUseId, { agentId: string;
  parentToolUseId: string | null; bytes: number; order: number; name?: string; description?: string;
  agentType?: string }>` built from `agentIdToToolUseId` + sidecars (`readAgentSidecar`:
  `toolUseId`, `parentAgentId` → map to that parent's toolUseId, `name`, `description`,
  `agentType`) + file sizes; `order` = spawn position in the main transcript (nested: parent's order
  + fractional/child sequence — anything that sorts newest-first sensibly). Agents with no file:
  bytes 0, still listed.

Renderer:
- `loadSessionIntoStore` (Claude): call with `deferStatusLine`; commit messages immediately
  (`loadHistoricalSession` with `statusLine: null`) and mark the entry `statusLinePending: true`
  (view-only field like transcriptLoadProgress). Then start the session's background job (do not
  await it in the click path): (a) `loadSessionStatusLine` with progress → on land: if still resident
  and not live, set the status line (through the sanctioned writer — check sealed-fields; statusLine
  may be sealed → add a replica-side fill function next to `seedColdSession`), clear pending; if live,
  just clear pending; (b) subagent prefetch queue per the ordering rules. (No old-server fallback — see
  acceptance 7.)
- Background progress: `backgroundLoadProgress: {fraction, label} | null` view-only per session;
  total = statusTotal (first status frame) + Σ index bytes of agents queued; done = status done + Σ
  bytes of fetched agents; monotonic; on-demand fetches count too.
- Subagent bucket writes go through ONE new replica function (e.g. `fillSubagentBucket(routingId,
  toolUseId, messages)`) — fill-only, no-op for an unknown session or a non-empty bucket. Do NOT write
  sealed fields elsewhere (eslint enforces).
- On-demand: TaskCard (expanded) and TaskEntry (panel) call `requestSubagentTranscript(routingId,
  toolUseId)` when the bucket is missing and the index lists the agent; show a "Loading…" line
  (`TaskCard.subagentLoading` / `TaskEntry.subagentLoading`). `hasSubagentOutput` for the
  failure-summary logic: treat "index lists a transcript with bytes > 0 and bucket not yet loaded" as
  pending, not as "no output" (do not flash the markdown result body then swap).
- Content-phase loader: unchanged component; tracker plan now total = M (no subagents phase in the
  content load). Keep 'receiving'.
- Footer: while `statusLinePending`, render the status line as a muted "Loading usage…" (or the
  template with placeholders) — find the footer renderer via `statusLineTemplate`.
- The background job registry is separate from `loadsInFlight` (sends must not wait for it).
- Watched sessions, ensureTranscriptLoaded (rename/watch), reloadActiveTranscript: content-first too;
  background job only for the ACTIVE session.

Out of scope: tail-first; caching the status line across opens (good follow-up: key by mtimes);
host-side `seedCanonicalTranscript` still computes the status line on spawn (sendPrompt waits on it
~1 s — note as follow-up); full-sync progress (next arc).

Tests that must exist: main defer option returns identical messages/notifications/index with
statusLine null and progress total = M; status channel equals today's statusLine (deep-equal vs the
non-deferred call on the same fixture); index built from sidecars incl. nested parent mapping and
missing-file agents; registry/transport registration of the new channel (both transports, progress
frames); renderer: content commit before status/subagents; status line dropped when live; fill-only
bucket writes; prefetch order (nested parents first, then newest first) and ≤ 2 concurrency;
on-demand jumps the queue; cancel on navigate-away + restart on return; background bar monotonic and
gone when done; footer pending state; TaskCard loading body + no failure-summary flash. Each must fail without the change.

## Arc 2 design review resolutions (2026-10-19) — ALL accepted; these OVERRIDE the Arc 2 design above

- **R1** Both replica fills (subagent bucket, status line) no-op unless the entry HOLDS its transcript:
  `existing?.seeded && existing.messages.length > 0` (what `seedColdSession` reads, replica.ts:~527) —
  a fetch landing after `switchSession` cold-evicted the entry must not write onto it. Test it.
- **R2** The background job is started by ACTIVATION, not by the click: one reconciler on
  `activeSessionId` (store subscriber/effect, e.g. near useClaudeEvents.ts:~212-218): active +
  historical + not live + holds transcript + (status line pending OR buckets missing per index) →
  ensure the job; otherwise cancel the job of the previously active session. The click path never
  starts the job. Covers `ensureTranscriptLoaded` (rename/watch) commits and re-activation.
- **R3** Status-line fill = REPLACE unless live (not fill-only). `loadHistoricalSession` keeps
  `statusLine ?? base.statusLine` and eviction does not clear it, so a re-opened session shows its
  previous status line at once; the footer shows it (not "Loading usage…"), and the fresh one replaces
  it. Pending UI only when `statusLine === null && job.statusPending`. Live → drop (the live session
  seeds its own accumulators incl. subagent costs, claude-session.ts:~510-526/2316-2347).
- **R4** Generation token per session job: `Map<routingId, {generation, cancel}>`; bump on
  `loadHistoricalSession`'s final set and in `evictedViewPatch`/`markViewEvicted` (which also drop the
  index + background view state). Landing fills / progress no-op on a generation mismatch.
- **R5** New channel registered completely on both transports: session.ipc.ts unbind list (~303),
  remote parity pin (remote-handlers.ipc.test.ts ~1670), src/test/helpers/boot-test-app.ts (~140),
  preload, web api-adapter, `ClaudeAPI` type, docs/architecture/remote.md. The options arg is validated
  as `options?.deferStatusLine === true`; everything else ignored. Same `fs-read` capability.
- **C1** No `statusLineDeferred` flag; no `resumeSessionAt` on the status channel (anchored callers —
  `loadForkSeed`, `loadResumedTranscript`, host seed — stay on the full read).
- **C2** `subagentFileBytes` → `subagentIndex` is safe (no released bundle has Arc 1). Fix ADR-102's
  skew wording (done) and the stale C8 note above (superseded: a new bundle never meets an old host).
- **C3** `order` = subagent file mtime, newest first (already stat'd); only override: parents of nested
  agents first.
- **C4** No activeTasks/notifications check — fill-only on a non-empty bucket covers running agents.
- **C5** Background bar total planned up front: total = (M + S_idx) + S_idx (M = the content load's
  total, S_idx = Σ index bytes); status frames mapped proportionally into the first (M + S_idx);
  each fetch adds its index bytes. Monotonic without waiting for a frame.
- **C6** Nested task-panel entries: request at the DESCRIPTOR level (TaskDetailPanel.tsx ~27-35 → `kind:
  'missing'` today renders null): if `index[toolUseId]?.parentToolUseId` exists, request the PARENT
  bucket (and its own) and render a loading entry. Requests in an effect keyed by toolUseId, deduped
  by the job.
- **C7** Roster: "nested parents first" only; no index-built rows; nested counts lag until the parent
  bucket lands (document in code).
- **C8** Declare `session:load-subagent-history` `withProgress` too (handler can report nothing;
  the transport's `sending` frame re-arms the remote 30 s timer at transfer start). Treat fetch
  timeouts (`isInvokeTimeout`) as retryable once in the job.
- **C9** Extend `readAgentSidecar` with `name`/`description`/`agentType` via the existing
  `stringField`; ~5% of sidecars lack `toolUseId` → index only agents the main transcript mapped;
  build the index as a null-prototype object or Map → plain object on the wire.
- **C10** One per-session view object `backgroundLoad: { fraction, label, statusPending } | null`
  (not separate flags). Footer: `View.tsx` ~1087 renders zeros for null today; pending =
  `statusLine === null && backgroundLoad?.statusPending`.
- **N1** Options object through `readSessionHistory`/`loadSessionHistory` (`{ resumeSessionAt?,
  onProgress?, deferStatusLine? }` or similar) instead of more positionals — update callers.
  **N2** Return `transcriptMtimeMs` in the result. **N3** Channel name `session:load-status-line`,
  API `loadSessionStatusLine`. **N4** One small `lib/subagent-prefetch.ts`, no generic scheduler.
  **N5** Document: a session resumed before an old agent's bucket was prefetched shows only that
  agent's new run until the next idle re-click. **N6** Tests: add R1, R4, C6, C3; no old-server test.

## Arc 2 slices

- **Slice C (main + wire):** defer option (N1), `session:load-status-line` (N3, withProgress, R5,
  extracted status-line block shared with the full path), `subagentIndex` (C3, C9), `transcriptMtimeMs`
  (N2), `session:load-subagent-history` withProgress (C8), byte plans (content: total = M; status:
  total = M + S), ADR-102 amendment text left to the orchestrator.
- **Slice D (renderer):** content-first commit, activation reconciler (R2), job + generation (R4),
  replica fills (R1, R3), background bar under TopBar (C5, C10, testid `ChatPanel.backgroundLoad`),
  prefetch module (N4, ≤ 2 in flight, C3 order), on-demand TaskCard / TaskEntry / descriptor (C6),
  footer pending (C10), retry once on timeout (C8), remove the content-phase `subagents` phase.

## Slice C implementer report (2026-10-19, not self-certified)

Landed (main process + wire; no Slice D behaviour):

- `core/services/session-history.ts`: `loadSessionHistory(sessionId, projectKey, resumeSessionAt?, options?: {onProgress?, deferStatusLine?})`.
  The status-line block (metrics pass + subagent cost fold + dispatched-cost merge) is ONE function, `computeStatusLine`, used by the
  full read and by the new `loadSessionStatusLine(sessionId, projectKey, onProgress?)`. Byte plans are one `createHistoryProgress(onProgress,
  plan)` with three kinds: `full` (unchanged 2M+2S, last report 2M+S), `content` (deferred: total M, phase `transcript`, first 0, last M) and
  `status` (total M+S, phase `costs`, first 0, last total). `subagentIndex` (null-prototype, keyed by origin tool_use id: `agentId,
  parentToolUseId, bytes, order = file mtimeMs, name?, description?, agentType?`) replaces `subagentFileBytes`; `transcriptMtimeMs` is
  stat'ed before the first byte is read.
- `core/services/agent-identity.ts`: `readAgentSidecar` also returns `name`/`description`/`agentType` (via `stringField`).
- `core/services/engine-history.ts`: `readSessionHistory(id, key, anchor?, engineId?, options?)`, `EngineHistory.read(id, key, anchor?, options?)`.
- `core/ipc/session.ipc.ts` + `core/ipc/remote-handlers.ts`: `session:load-history` takes the options object as its 4th wire arg
  (`options?.deferStatusLine === true`, everything else ignored); new `session:load-status-line` (`fs-read`, `query`, `withProgress`) on both
  transports (+ the session.ipc unbind list); `session:load-subagent-history` declared `withProgress` (handler takes the reporter, reports nothing).
- `preload/index.ts`, `web/api-adapter.ts`, `test/helpers/boot-test-app.ts`, `shared/types.ts`: `loadSessionHistory(..., onProgress?, options?)`,
  `loadSessionStatusLine(sessionId, projectKey, onProgress?)`, `SubagentIndexEntry`, `LoadSessionHistoryOptions`; options ride as a 4th wire
  arg only when given (the old 3-arg call is byte-identical on both clients).
- `docs/architecture/remote.md`: one sentence listing the three `withProgress` channels.
- Arc 1 renderer consumer adapted minimally: `lib/session-history-load.ts` sizes each fetch by `subagentIndex[toolUseId]?.bytes`
  (`transcript-load-progress.ts` untouched, it never read the field).

Deviations / judgement calls:

1. N1 scope. The options object is used for the NEW knobs (and Slice A's `onProgress`, which moved into it) on `loadSessionHistory` /
   `readSessionHistory` / `EngineHistory.read`; the older positionals (`resumeSessionAt`, `engineId`) stay. Moving them too would rewrite
   ~25 call sites and mock assertions for no behaviour. `ClaudeAPI.loadSessionHistory` keeps `onProgress` as its 4th positional and adds
   `options` as the 5th (Slice D's call site is the only caller that will pass it; the renderer-facing signature churn would have touched
   Slice B's tests for nothing).
2. `order` is the file mtime in ms (C3), 0 for a missing file; "newest first" is the consumer's sort (descending). "Nested parents first"
   is the consumer's override, not encoded in `order`.
3. A sidecar WITHOUT `toolUseId` makes `readAgentSidecar` return null (its existing contract, claude-session relies on it), so such an agent
   is indexed (the main transcript mapped it) with `parentToolUseId: null` and no names even if the sidecar carries them.
4. Two agents mapped to one origin id (not something cli.js writes): the newer transcript (`order`) wins the key.
5. `statSubagentFiles` now returns agentId -> `{bytes, mtimeMs}` (a Map); a file that vanishes between readdir and stat is dropped (it used to
   count 0). The full plan's S is still every `agent-*.jsonl` on disk, mapped or not (the cost fold reads them all).
6. `loadSessionStatusLine` is Claude-only and not engine-dispatched (no `readSessionHistory` engine check); a missing transcript yields the
   all-zero `StatusLineData`, never null. It has no `resumeSessionAt` (C1).
7. `readAgentSidecar`'s existing test expectation changed (the 2.1.280 fixture carries `agentType`/`description`, now returned).
8. The "remote-server test with progress frames for the new channel and load-subagent-history" is covered in two parts, not by booting the
   real handlers inside `remote-server.test.ts` (that file registers stand-in channels and has none of the handler mocks): the real
   declarations are pinned in `remote-handlers.ipc.test.ts` (`withProgress`, `dispatcher.reportsProgress(...)` — the exact predicate
   `handleInvoke` gates its frames on), and `remote-server.test.ts` gained a case for a `withProgress` handler that reports NOTHING (the
   load-subagent-history shape): exactly `sending {done:0,total:null}` then the response.

Tests (new unless noted): `main/services/__tests__/session-history-deferred.test.ts` (19: deferred-vs-full deep-equal, plans, status
deep-equal incl. dispatched merge, index from sidecars / nested parent / missing file / sidecar-less agent / unmapped file / mtime order /
`__proto__` key, `transcriptMtimeMs`), `session-history-progress.test.ts` (moved to the options object; the `subagentFileBytes` test went to
the index tests), `remote-handlers.ipc.test.ts` (+3, the parity pin gained `session:load-status-line`), `session.ipc.test.ts` (+5),
`remote-server.test.ts` (+1), `preload-invoke-progress.test.ts` (+2), `api-adapter.test.ts` (+2), `agent-identity.test.ts` (+1, 1 updated),
`engine-history.test.ts` (updated), `session-history-load-progress.unit.test.ts` (fixtures moved to `subagentIndex`).
Red-proof: scratchpad `red_c.py`, 30 mutations, every one RED after two added tests (a shrinking-transcript test for the content plan's closing
report; a removeHandler-count test for the unbind list); plus deleting the boot-test-app helper fails `bun run typecheck` (the object is typed
`ClaudeAPI`).

## Orchestrator review of Slice C (2026-10-19)

Every source hunk reviewed (session-history.ts, agent-identity.ts, engine-history.ts, both
registrations, preload, web adapter, renderer adaptation). typecheck exit 0; guard proven red
independently (ignoring `deferStatusLine` → 4 deferred-read tests fail). Deviations 1–6 accepted
(ClaudeAPI keeps `onProgress` 4th + `options` 5th; no real-handler server test needed — the
declarations are pinned and the transport predicate is tested).

## Slice D brief (dispatched 2026-10-19)

Implement "Slice D (renderer)" from "Arc 2 slices", with every Arc 2 resolution (R1–R5, C1–C10,
N4–N6). Orchestrator notes:
- Content load: `loadSessionHistory(..., onProgress, { deferStatusLine: true })` for Claude; remove the
  eager subagent fan-out from `loadSessionIntoStore` and the content tracker's `subagents` phase
  (`TranscriptLoadPhase` = 'reading' | 'receiving'); content plan total = M.
- Store the `subagentIndex` per session (view-only, NOT replicated; dropped on evict per R4) so
  TaskCard/TaskEntry/descriptor and the prefetch job can read it.
- Activation reconciler (R2) + per-session job with generation (R4) in ONE module
  `lib/subagent-prefetch.ts` (N4) (it may also own the status-line fetch, or a sibling small function —
  keep it small): status line first-or-concurrent, then buckets; ≤ 2 in flight; order: parents of
  nested agents first, then `order` (mtime) desc; on-demand requests jump the queue; retry once on
  `isInvokeTimeout`; cancel on deactivation; restart on reactivation for what is still missing.
- Replica fills in `stores/replica.ts` only: `fillSubagentBucket` (fill-only + R1) and a status-line
  replace (R3: replace unless live, + R1). Check eslint sealed-field rules.
- Background bar: `backgroundLoad: { fraction, label, statusPending } | null` (C10) per session,
  view-only; ChatPanel renders a 2 px bar directly under TopBar (`ChatPanel.backgroundLoad`,
  role=progressbar, `title` = label e.g. "Loading usage and 73 subagents · 42%"), absolutely
  positioned so it does not shift layout; hidden when null. Plan per C5.
- Footer pending per C10 (find the renderer at InputBox `View.tsx` ~1087).
- On-demand UI: `TaskCard.subagentLoading`, `TaskEntry.subagentLoading`, and a loading descriptor for
  nested task-panel entries (C6). No markdown-result flash before the bucket lands for an agent the
  index lists with bytes > 0.
- `awaitReloadBeforeSpawn` must still wait only for the content load.
- Update ADR-102? NO — the orchestrator amends it.
- Tests per the Arc 2 list + N6 (R1, R4, C6, C3), each proven red. Gates: typecheck, lint, touched
  tests in isolation, `bun run test` (browser project works here).

## Slice D implementer report (2026-10-19, not self-certified)

Landed (renderer half of Arc 2; Slice C files untouched):

- `lib/session-history-load.ts`: the Claude path reads with `loadSessionHistory(id, key, undefined, onProgress, {deferStatusLine: true})` and commits as
  soon as the main transcript is in memory. The per-agent fan-out (`MAX_SUBAGENT_FETCHES`, size sort, `subagentFileBytes`) is gone. The progress
  callback is ALWAYS passed (its first frame's `total` = M is what the background bar's plan starts from). The commit hands `loadHistoricalSession`
  the new 8th arg `{subagentIndex, statusPending, statusBytes: M + Σ index bytes}`.
- `lib/transcript-load-progress.ts`: phases `'reading' | 'receiving'`; `subagentsStarted` / `subagentFetched` / `subagents` removed; `describeTranscriptLoad` is
  "Reading transcript · N% · ~x s left" or "Receiving…".
- `lib/subagent-prefetch.ts` (new, N4): the activation reconciler (`startBackgroundLoad`, one store subscriber on a tuple of what the decision reads) and the
  per-session job. Job = status pass (concurrent) + bucket fetches, `MAX_BUCKET_FETCHES = 2`, order: parents of nested agents, then `order` (mtime) desc;
  `requestSubagentTranscript(routingId, toolUseId)` jumps the queue (and makes a demand-only job when none runs); a timeout (`isInvokeTimeout`) is retried
  once, any other failure / an empty read zeroes the index entry (`markSubagentUnavailable`) so cards stop waiting; cancel on deactivation stops NEW
  fetches only (in-flight ones still land); a live session clears the wait and drops the late status line; bar planned up front (C5), monotonic.
- `hooks/useClaudeEvents.ts`: mounts `startBackgroundLoad()` (desktop renderer and web client alike). `hooks/useSubagentPending.ts` (new): index lists bytes > 0 and the
  bucket is absent.
- `stores/replica.ts`: `fillSubagentBucket` (fill-only, R1) and `replaceStatusLine` (replace, not live, R1, R3) — the only new writers of sealed fields; `holdsOwnTranscript` =
  `seeded && messages.length > 0`.
- `stores/session-store.ts`: `PerSessionState.subagentIndex | backgroundLoad | backgroundGeneration` (view-only; in `EMPTY_SESSION_STATE`), `BackgroundLoadView`,
  `setBackgroundLoad` and `markSubagentUnavailable` (both generation-guarded), `loadHistoricalSession(..., background?)` (final set replaces index / bar and bumps the
  generation), `evictedViewPatch(session?)` clears index + bar and bumps the generation (covers `markViewEvicted`, `switchSession`'s cold eviction and `beginTranscriptLoad`).
- UI: `ChatPanel` (`ChatPanel.backgroundLoad`: role=progressbar, 2 px bar in a 6 px hover strip, `title` = label, `absolute top-full` under the TopBar wrapper, so no layout shift);
  `InputBox` / `View` (footer "Loading usage…" = `InputBox.statusLine.pending` only when `statusLine === null && backgroundLoad.statusPending`);
  `TaskCard` (`TaskCard.subagentLoading`, request effect on expand, failure summary counts a pending transcript as output); `TaskEntry` (`TaskEntry.subagentLoading`, request effect);
  `TaskDetailPanel` + `View` (descriptor kind `'loading'` for a nested agent whose parent bucket is pending, requests parent + own at the descriptor level, C6);
  `useAgentRoster` comment (C7, nested rows lag until the parent lands).

Deviations / judgement calls:

1. R4's "generation" is a numeric `backgroundGeneration` on the entry (not a `Map<routingId,{generation,cancel}>`): the store bumps it at the two places the spec names (commit and eviction),
   so the prefetch module holds no registry of its own beyond the live `jobs` map; every landing compares the entry's current generation with the job's.
2. `BackgroundLoadView` carries one extra field, `statusBytes` (the status pass's planned bytes, M + S_idx), because a job restarted by reactivation has to rebuild the C5 plan and M is
   only known to the content load. C10's shape otherwise.
3. A failed / empty bucket zeroes its index entry (`bytes: 0`) instead of tracking failure elsewhere: "a transcript is on its way" is then simply `bytes > 0 && bucket absent` everywhere
   (card, entry, panel, reconciler) and a transcript that cannot be read falls back to the markdown result.
4. On-demand requests also work for a LIVE session (fill-only keeps a running agent's bucket safe); the reconciler's background job does not run for a live one.
5. The watched-session refetch (`refetchWatchedSession`) and the other non-click readers (`loadResumedTranscript`, fork seed) stay FULL reads (status line included); only `loadSessionIntoStore` is content-first
   (so click, rename / watch toggle via `ensureTranscriptLoaded`, and `reloadActiveTranscript` are).
6. "Context meter if cheaply derivable" is not implemented: the footer shows "Loading usage…" until the status line lands (nothing in the deferred result carries the window).
7. Because the progress callback is always passed, `ensureTranscriptLoaded` / rename now also ride `invokeWithProgress` (desktop) / progress frames (web) — harmless, the throttle is per call.
8. Existing tests changed because their contract did: `replica-uncarried` (the call now carries the callback + options), `session-history-load-progress` (the fan-out / subagent-phase tests became content-first ones),
   `transcript-load-progress` (subagent phase removed), ChatPanel's "follows the store" test (`receiving` instead of `subagents`), two `PerSessionState` literals (3 new fields).

Tests (new unless noted): `lib/__tests__/subagent-prefetch.unit.test.ts` (21: reconciler, order, concurrency, on-demand, cancel / restart, R4 generation, R1 / R3 fills, retry / give-up, bar),
`lib/__tests__/session-history-load-progress.unit.test.ts` (content-first load; updated), `stores/__tests__/session-store-transcript-load.component.test.ts` (+7 view state),
`components/chat/__tests__/TaskCard-subagent-loading.component.test.tsx` (5), `TaskEntry.component.test.tsx` (+3), `TaskDetailPanel.component.test.ts` (+4, C6),
`ChatPanel.component.test.tsx` (+3), `InputBox/__tests__/View.unit.test.tsx` (+3) and `InputBox.component.test.ts` (+3), `hooks/__tests__/useClaudeEvents-background-load.component.test.ts` (2).
Red-proof: scratchpad `red_d.py`, 39 targeted mutations (generation, eviction, R1 / R3 fills, order, bounds, cancel, retry, bar, hook wiring, every UI surface, plus "the content load fetches subagents again"),
all RED (D22 first vacuous, then a test for an on-demand job upgraded to the background phase made it red).

## Orchestrator review of Slice D (2026-10-19)

Core read by the orchestrator (subagent-prefetch.ts, replica fills, store fields + every
`evictedViewPatch` caller, content-first path, ChatPanel bar, TaskCard, footer); full 29-file diff by a
fresh reviewer (no REQUIRED; report kept in the session scratchpad). Change request (all REQUIRED for
this round, small):
1. `reconcile`: every "nothing should run" exit clears a non-null `backgroundLoad` (generation-guarded)
   — incl. the `!isHistorical` branch (a session that went live while inactive and came back idle) and
   the "nothing pending" early return. Test the went-live-while-inactive scenario.
2. `runStatus`: when the status line lands with the generation intact but the job no longer
   registered (cancelled by deactivation), still clear `statusPending` (generation-guarded write) so
   reactivation does not re-run the 0.6–1.2 s status pass. Test it.
3. No dependence on `directories` for a job: carry `projectKey` (and sessionId) on the commit's
   `background` object / the store entry, so `newJob`/`requestSubagentTranscript` never need
   `findSessionInfo` (a pinned/recents session absent from the listing would otherwise show
   "Loading usage…" and a spinning card forever). Test with an empty `directories`.
4. Remove the dead `cancelled` checks (cancel() unregisters).
5. ChatPanel bar: the hover strip must not intercept clicks — `pointer-events-none` on the strip is
   fine (drop the hover affordance; keep `aria-label`; `title` may stay on the visible bar). Use the
   same rounding for `aria-valuenow` and the label (floor).
6. One doc-comment line: the bar restarts at 0% on reactivation (by design).

### Slice D follow-up (orchestrator review items 1–6, not self-certified)

1. `reconcile`: every no-run exit (live, not historical / evicted / no index, empty transcript, nothing pending) clears a non-null `backgroundLoad` through one `clearWait()`
   (generation-guarded). Test: a session that went live while inactive and came back idle; a stale bar on a session with nothing pending.
2. `runStatus`: when the reading lands for a job that was cancelled meanwhile (generation intact), `clearStatusPending` ends the wait (bar kept, without the status flag, if buckets are
   still missing) so a return does not run the pass again. Tests: the pass is read once across leave + return; the bar survives with `statusPending: false`.
3. Jobs no longer touch `directories` / `findSessionInfo`: the commit records `transcriptSource {sessionId, projectKey}` on the entry (`loadHistoricalSession`'s `background.source`, cleared by
   `evictedViewPatch`), and `newJob` / `requestSubagentTranscript` read it. Tests run with an empty `directories` (reconciler, on-demand request).
4. `Job.cancelled` and its checks are gone (`cancel()` unregisters; `pump` returns for an unregistered job).
5. ChatPanel bar: `pointer-events-none`, 2 px element (the 6 px hover strip is dropped; `title` stays), `Math.floor` for `aria-valuenow` and the width, matching the label.
6. Header comment of `lib/subagent-prefetch.ts` says the bar restarts at 0% on reactivation (by design) and that a job needs nothing from the listing.

Red-proof (scratchpad inline script): E1a, E1b, E2, E3a, E3b, E5a, E5b and "a cancelled job keeps pumping" all RED against targeted mutations. Gates: typecheck exit 0; lint exit 0;
prettier --check on all touched files exit 0; 14 touched renderer test files `Tests 458 passed (458)`; `bun run test` exit 0, `Test Files 849 passed (849)`, `Tests 18495 passed | 8 skipped (18503)`.

## Arc 2 verification brief (orch-verifier, 2026-10-19)

Same isolation as Arc 1's brief (APFS-cloned vhome, never the real ~/.claude, never --with-remote, no
prompts; delete vhome with `rm -rf` as its own command at the end — the verifier may ask the
orchestrator to do it). Sessions: 5bece358 (73 agents, has depth-2 nested agents) and 1ae1d292.
Claims:
1. Content first: click 5bece358 → `MessageBubble` count reaches 398 within ~1 s of the click (record
   the time), while `ChatPanel.backgroundLoad` is present (role=progressbar) and
   `InputBox.statusLine.pending` reads "Loading usage…".
2. Background: sample `ChatPanel.backgroundLoad` aria-valuenow + title every ~100 ms: monotonic,
   title starts "Loading usage and N subagents", ends (bar removed) within ~5 s; afterwards the footer
   shows the real status line (not zeros, no pending), and the store has buckets for ≥ 90% of the index
   entries with bytes > 0 (`sessionStore.getState().sessions[id].subagentMessages` vs `subagentIndex`).
3. On demand: click 1ae1d292 and immediately expand a TaskCard whose bucket is not yet loaded (pick
   the LAST TaskCard in the DOM; expand via its header click) → `TaskCard.subagentLoading` appears
   then is replaced by the subagent output; record timings.
4. Deactivate mid-background (click the other session) → the first session's bar is gone and no
   further `loadSubagentHistory` calls happen for it (count by wrapping `window.api.loadSubagentHistory`
   in an eval before the clicks); reactivate → the job resumes only for what is missing and the status
   line is NOT re-fetched (wrap `window.api.loadSessionStatusLine` and count).
5. Roster: after the background phase, the agent roster (`AgentRosterList` / its testids) lists nested
   (depth ≥ 1) rows for 5bece358 (compare with HEAD-less expectations: just assert some row has depth
   > 0 via store or DOM).
6. Regression: re-click an already-loaded session opens instantly; a send is not attempted.
7. Mobile `--profile s25-ultra-edge --font-scale 1.5 --overflow-audit` during the background phase:
   `OVERFLOW []`, bar visible under the TopBar.
Report per claim with EVAL output, screenshots (desktop during background phase, after, mobile),
consoleErrors.
