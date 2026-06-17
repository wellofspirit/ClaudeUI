# Test Coverage Proposal

This proposal defines the test coverage we should have, not the coverage we can cheaply afford. It is scoped around **risk reduction and regression detection**, not coverage percentages. It complements [testing-strategy.md](testing-strategy.md) and [component-guide.md](component-guide.md).

The guiding principle: **if a bug in this code could ship to a user and we wouldn't notice until someone complains, we need a test.**

## 1. Current Baseline

```
Layer 1 (unit):        15 main-process service tests, 4 hook/store unit files,
                        diff-lib tests, shared utility tests
Layer 2 (component):   29 component tests + 6 hook event-wiring tests — 2182 tests
Layer 3 (e2e):         1 file  (basic-conversation.e2e.test.ts)
Layer 4 (integration): 1 file  (event-sequences.integration.test.ts, gated)
Patches:               0 automated tests (13 patches registered in apply-all.mjs)
```

### Gaps by severity

| Area                                              | Files                  | Tested   | Risk                                 |
| ------------------------------------------------- | ---------------------- | -------- | ------------------------------------ |
| Main services                                     | 36                     | 15 (42%) | High — stateful business logic       |
| IPC handlers                                      | 4 files, ~106 handlers | 0        | High — renderer/main contract        |
| Renderer hooks                                    | 10                     | 6        | Medium                               |
| E2E flows                                         | —                      | 1        | High — cross-subsystem nets          |
| SDK patches                                       | 13                     | 0        | High — break silently on SDK upgrade |
| Renderer components                               | 29 with logic          | 29       | Well covered                         |
| Pure utilities (diff lib, crypto, content-blocks) | —                      | Most     | Well covered                         |

The investment has been concentrated on the renderer. The main process — where git operations, PTY lifecycle, remote-access networking, and plugin execution live — is largely uncovered.

## 2. Priority Tiers

Tiers are ordered by **blast radius × probability of breakage**. Tier 1 is non-negotiable; Tier 3 is nice-to-have but cheap to add.

---

### Tier 1 — Must have

#### 1.1 `git-service.ts` unit tests

**Why:** Git operations are visible on every chat message (branch pill, changes count, diff panel). Silent failures mean users commit wrong state or miss conflicts. `simple-git` errors are the usual suspect.

**Layer:** Layer 1, `src/main/services/__tests__/git-service.test.ts`

**Infrastructure:** Use a real temporary git repo per test via `fs.mkdtemp()` + `simple-git` against that path. Do NOT mock `simple-git` — we want to catch wrapper bugs and argument-shape regressions.

**Cases:**

- `status()` — clean repo, staged files, unstaged files, untracked files, deleted files, renames, submodules ignored
- `getBranches()` — current branch marking, remote-tracking branches, detached HEAD
- `switchBranch()` — success, dirty-tree rejection, nonexistent branch
- `stageFile()` / `unstageFile()` — including paths with spaces and unicode
- `commit()` — empty message rejection, amend flag, signoff, pre-commit hook failure propagation
- `push()` / `pull()` — success, rejected (non-fast-forward), auth failure, no upstream set
- `getDiff()` — staged vs unstaged vs commit range, binary file handling, CRLF normalization
- `stash()` / `stashPop()` — conflict resolution path
- `checkoutFile()` — reverts a modified file
- Polling lifecycle — `startPolling()` / `stopPolling()` fires `onChange` only on real changes, not on noop polls
- Error normalization — any thrown `simple-git` error surfaces as a typed, serializable shape (the IPC layer needs to JSON-round-trip it)

**Expected count:** ~35 tests.

---

#### 1.2 `pty-manager.ts` unit tests

**Why:** Terminal panel is always mounted (ADR-002) and groups by cwd (ADR-003). Buggy spawn/resize/kill leaks PTYs and leaves ghost processes on Windows. `node-pty` has platform-specific behavior worth pinning.

**Layer:** Layer 1, `src/main/services/__tests__/pty-manager.test.ts`

**Infrastructure:** Mock `node-pty.spawn` — return a fake PTY that exposes `write`, `resize`, `onData`, `onExit`, `kill`. Do not launch real shells in CI.

**Cases:**

- `create()` — picks pwsh on Windows, bash on Unix; honors `SHELL` env var; passes `cwd` and `cols`/`rows`
- `write()` — routes to the correct PTY by id; no-op on unknown id (don't throw — preserve renderer contract)
- `resize()` — clamps to sane bounds; no-op if cols/rows unchanged
- `kill()` — releases id; idempotent on repeated kill
- Cold cleanup — PTYs inactive for 10+ minutes are killed (ADR-003). Use `vi.useFakeTimers()`
- Data fan-out — multiple `onData` subscribers all receive the same buffer
- Exit propagation — `onExit` fires with correct exit code, unsubscribes all handlers
- Spawn failure — `create()` throws synchronously when shell binary is missing
- cwd normalization — matches the grouping key used in the renderer (ADR-003)

**Expected count:** ~15 tests.

---

#### 1.3 IPC handler boundary tests

**Why:** 106 `ipcMain.handle` registrations, zero tests. This is the renderer↔main contract. Component tests assume handlers work; no test guards against `safeHandler()` envelope regressions, missing handler registration, or malformed argument handling.

**Layer:** Layer 1/2 hybrid, `src/main/ipc/__tests__/*.ipc.test.ts` — one file per IPC module.

**Infrastructure:** Use `TestIpcBridge` (same bridge that powers component tests) plus a stub for the underlying service. Wire the real `registerSessionIpc()` / `registerTerminalIpc()` / etc. against the bridge and assert behavior from the renderer side.

**Cases per module:**

- **Handler registration** — each documented channel is actually registered (prevents typo regressions)
- **Envelope contract** — `safeHandler`-wrapped channels return `{ ok: true, data }` on success and `{ ok: false, error }` on thrown error; `unwrap()` round-trips both
- **Argument validation** — malformed or missing args return a typed error, not an unhandled throw that crashes main
- **Service exception propagation** — when the underlying service throws, the renderer receives a serializable error (no lost stack, no `[object Object]`)
- **Timeout path** — `utils/ipc-timeout.ts` rejects after N ms when the handler never returns; the handler cleanup runs
- **Channel blocklist for remote** — `remote-dispatcher.ts` rejects desktop-only channels (sandbox, voice capture, file picker). Every blocklisted channel gets a negative test

**Expected count:** ~60 tests across the four IPC files. Tedious but mechanical.

---

#### 1.4 Patch regression tests

**Why:** 13 patches modify the minified SDK. When the SDK upgrades, minified names change and patches can apply-but-no-op, or fail-to-apply and ship broken behavior. Currently detected by manual QA.

**Layer:** Layer 4 (behavioral, in `patch/<name>/test.mjs` using the `/patch-test-harness` skill).

**Cases per patch:**

- **Application success** — `apply.mjs` produces a marker and the marker is idempotent (running twice is a no-op)
- **Anchor uniqueness** — the pattern in `apply.mjs` matches exactly once in the current `cli.js` (future-proofing: if a refactor duplicates the anchor, we want a failing test, not a silent miscompile)
- **Behavioral verification** — exercise the patched code path via `sdkQuery()` and assert the expected event/message shape:
  - `subagent-streaming` → consumer receives `subagent_stream_event` and `subagent_message`
  - `taskstop-notification` → `task_notification` arrives on explicit stop
  - `team-streaming` → teammate events forwarded; `task_notification` on completion
  - `queue-control` → `dequeue_message` request succeeds; `queued_command_consumed` notification fires
  - `mcp-status` → returns non-empty after MCP server init
  - `mcp-tool-refresh` → tool list refreshes after reconnect
  - `background-task` → control message round-trip
  - `usage-relay` → usage events reach SDK stdout
  - `request-usage` → per-request token counts emitted after `message_stop`
  - `rate-limit-relay` → per-window utilization emitted
  - `incomplete-session-resume-fix` → resumed session has contiguous `parentUuid` chain
  - `voice-server` → TCP server accepts connection on configured port

**Expected count:** ~2–4 tests per patch, ~40 tests total.

**Gating:** Behavioral tests need the SDK and valid auth — gate them on `CLAUDE_INTEGRATION_TESTS=1` like Layer 4. Anchor/idempotency tests run always.

---

#### 1.5 Expanded Layer 3 E2E coverage

**Why:** One E2E test doesn't earn the "nets cross-subsystem bugs" framing in `testing-strategy.md`. The `bootTestApp` harness already exists — marginal cost per flow is low.

**Layer:** Layer 3, `src/e2e/flows/*.e2e.test.ts`.

**Required flows:**

1. **Multi-turn conversation** — send → result → send again → result; verify message ordering and that `input_tokens`/`output_tokens` accumulate correctly
2. **Tool use with approval** — assistant emits `tool_use` → `canUseTool` → user approves → `tool_result` → continuation → `result`. Assert approval clears from `pendingApprovals` after tool completes
3. **Tool use denied** — same flow, user denies → SDK receives deny message → assistant continues gracefully
4. **Session rekey mid-stream** — routingId `temp-1` starts streaming, `session:status` arrives with a new sessionId, streaming continues under the new key without dropped messages
5. **Session switching during streaming** — session A is streaming; user clicks session B; session A continues receiving events and state updates without affecting B
6. **Error propagation** — main process IPC throws → renderer's `session:error` event → error surfaces in store's `errors[]` array
7. **Todo lifecycle** — assistant emits TodoWrite → store populates todos → all marked complete + `result` event → todos cleared
8. **Permission mode change mid-session** — `setPermissionMode('acceptEdits')` control message → subsequent tool uses skip approval → `setPermissionMode('default')` → approvals required again
9. **Team/subagent streaming** — parent task spawns subagent → subagent stream events route to correct `AgentTabBar` entry
10. **Interrupt** — user clicks stop mid-stream → `session:interrupt` IPC → SDK yields no further events → status transitions to `idle`

**Expected count:** 10 files, ~30 tests.

---

### Tier 2 — Should have

#### 2.1 `plugin-manager.ts` unit tests

**Why:** Plugin system (ADR-004, ADR-005) runs third-party code. Lifecycle bugs here mean ghost plugins, crashed renderer, or unauthorized IPC access.

**Cases:**

- Load — scans `~/.claude/ui/plugins/`, skips malformed manifests, respects `enabled` flag
- Isolation — plugin preload bridge exposes only the whitelisted API surface; direct `ipcRenderer` access is blocked
- Lifecycle — `activate` / `deactivate` hooks fire in order; errors in one plugin don't kill others
- Session API (ADR-005) — sessionId-based events deliver to registered listeners; unregistered sessionIds drop events silently
- Disposal — unloading a plugin unregisters all its IPC handlers and event subscriptions

**Expected count:** ~15 tests.

---

#### 2.2 `remote-server.ts` + `remote-dispatcher.ts` + `remote-bridge.ts`

**Why:** Remote web access (ADR / feature) exposes a WebSocket server with E2E crypto and token auth. Security-relevant; bugs could leak sessions.

**Cases:**

- Token auth — missing/invalid token rejects with 401; valid token upgrades to WebSocket
- E2E handshake — key exchange completes; subsequent messages decrypt; tampered ciphertext rejected
- Dispatcher routing — allowed channel routes to handler; blocklisted channel returns typed error without invoking handler
- Bridge fan-out — a single `session:stream` main event broadcasts to all connected remote clients filtered by session subscription
- Catchup — new client receiving events since last `eventId` gets the event-log slice in order
- Backpressure — slow client doesn't block other clients (if implemented; otherwise file as known limitation)
- Disconnection cleanup — client socket close releases subscriptions and buffered events

**Expected count:** ~20 tests. Use a real ephemeral port + `ws` client.

---

#### 2.3 `worktree.ts` + `useGitWatcher` + `useTerminalColdCleanup`

**Cases for worktree.ts:**

- `create()` — happy path, path collision, target branch missing
- `remove()` — with and without `--force`, when worktree has uncommitted changes
- `list()` — parses porcelain output, handles detached HEAD worktrees

**Cases for useGitWatcher:**

- Starts polling when active session has a git cwd; stops on session switch to non-git cwd
- Debounces rapid cwd changes

**Cases for useTerminalColdCleanup:**

- Fires after 10 min inactivity (ADR-003); reset on any terminal activity
- Does not fire for the currently-focused terminal
- Cleanup unsubscribes timers on unmount

**Expected count:** ~15 tests combined.

---

#### 2.4 Session-store direct action tests

**Why:** Component tests exercise store actions transitively. Direct tests catch regressions in pure store logic (upsert-by-id, rekey, multi-session isolation) without React overhead and with clearer failure output.

**Layer:** Layer 1, `src/renderer/src/stores/__tests__/session-store-actions.test.ts` (augmenting the existing `.component.test.ts`).

**Cases:**

- `addMessage()` upserts by `betaMessage.id` across partial streams
- `appendStreamingText()` merges text blocks into the current assistant message
- `appendToolResult()` extracts from synthetic user message and attaches to the right tool_use
- `setPendingApproval()` / `removePendingApproval()` — keyed by `requestId`
- `rekeySession()` — old key removed, new key holds identical state, subscribers re-point
- Concurrent session isolation — events for session A never mutate session B's slice
- `clearBtw()`, `dismissError()`, `setActiveSession()` — deterministic
- Derived selectors — `useActiveSession` returns `undefined` on stale sessionId, not a throw

**Expected count:** ~20 tests.

---

#### 2.5 `automation-manager.ts` expanded coverage

Existing tests cover core scheduling. Add:

- DST transition — cron schedule across spring-forward / fall-back doesn't double-fire or skip
- Interval drift — long-running runs don't cause next-run to pile up; interval reschedules from end, not start
- Crash recovery — partially-written run record on disk doesn't corrupt history on restart
- Concurrent automation runs — two automations firing at the same tick both execute; don't share state

**Expected count:** ~10 tests.

---

### Tier 3 — Nice to have

#### 3.1 `session-watcher.ts` / `subagent-watcher.ts`

File-watch lifecycle: spawn → watch → update → unwatch → respawn. Real fs tests with `chokidar`-style polling.

**Expected count:** ~10 tests.

---

#### 3.2 `usage-fetcher.ts` rate-limit merge logic

Existing tests exist. Add:

- 429 backoff + retry-after header
- Disk cache stale fallback when network is down
- Header-vs-API scale conversion (0–1 vs 0–100) — known gotcha, deserves a pinned test

**Expected count:** ~5 tests.

---

#### 3.3 `tunnel-manager.ts` / `socks-bridge.ts`

CloudFlare tunnel spawn/teardown, SOCKS5 HTTP-CONNECT bridge. These are thin wrappers; mock the child process. Lower priority because failure modes are mostly "tunnel didn't start" which is visible.

**Expected count:** ~8 tests.

---

#### 3.4 `voice-capture.ts` / `voice-client.ts`

Audio capture + streaming transcription. Integration-ish; keep mocked at the native-binding boundary.

**Expected count:** ~6 tests.

---

#### 3.5 `useGutterDragSelection` / `useIsMobile`

UI-only hooks. Add only if we see regressions here; likely covered by diff-viewer component behavior.

---

## 3. Infrastructure Work

These tests need infrastructure that doesn't exist yet:

1. **`makeTempGitRepo()` helper** — `fs.mkdtemp` + `simple-git` init + seeded commits. Needed for `git-service.ts` tests.
2. **`fakePty()` factory** — returns a `node-pty`-shaped object with spies. Needed for `pty-manager.ts`.
3. **IPC handler test harness** — wire a real `registerXxxIpc()` to a `TestIpcBridge` with stubbed service dependencies, assert envelope round-trips. Should live in `src/test/helpers/boot-ipc-harness.ts`.
4. **Patch test harness** — already has `/patch-test-harness` skill; needs a top-level runner that applies a patch to a fresh `cli.js` copy and exercises it via `sdkQuery()`. Output compatible with Vitest reporters.
5. **WebSocket test client** — `ws` client bound to ephemeral port, speaks the E2E crypto protocol end-to-end. For remote-server tests.
6. **Ephemeral `~/.claude/ui/` override** — `CLAUDE_UI_HOME` env var that services like `ui-config.ts`, `plugin-manager.ts`, `automation-manager.ts` honor. Isolates tests from the developer's real config.

Item 6 may already exist partially — audit before adding.

## 4. Non-Goals

Things we should **not** test, and why:

- **Electron window chrome, menu, dock, tray icons** — can't be meaningfully tested without a real Electron instance; cost > value.
- **xterm.js rendering** — third-party library; trust the maintainers.
- **`simple-git` internals, `node-pty` internals** — same.
- **Exact byte output of `diff-viewer`** — already covered by existing lib tests; don't add snapshot tests on top.
- **Pure CSS / Tailwind classes** — component tests assert behavior, not class names.
- **Internal logger log message strings** — format changes shouldn't fail tests.
- **Trivial getters/setters in stores** — covered transitively.

## 5. Acceptance Criteria

A phase is "done" when:

- **Tier 1 done** → `git-service`, `pty-manager`, IPC boundary, patches, and the 10 E2E flows land. CI runs all of them. Any SDK upgrade triggers patch-test runs automatically.
- **Tier 2 done** → `plugin-manager`, `remote-server`, worktree + watchers, store action unit tests land.
- **Tier 3 done** → remaining services have at least smoke tests.

## 6. Execution Order

Suggested order to maximize risk reduction per week of work:

1. Week 1: `git-service.ts` tests (1.1) — highest visible user impact
2. Week 1–2: IPC boundary tests (1.3) — prevents a whole class of regressions
3. Week 2: Patch regression tests (1.4) — protects against SDK upgrades
4. Week 3: `pty-manager.ts` tests (1.2) + Layer 3 E2E expansion (1.5)
5. Week 4: Tier 2 starts with `remote-server.ts` (security-relevant)
6. Week 5+: Remaining Tier 2, then Tier 3 as capacity allows

## 7. Ongoing Discipline

To keep coverage from drifting back:

- **Every new service gets a test file the same commit.** No "I'll add tests later" — `later` doesn't happen.
- **Every patch gets a harness test before `apply-all.mjs` registers it.**
- **Every new IPC handler gets an entry in the relevant `*.ipc.test.ts`.**
- **Every bug fix gets a regression test.** If the bug could re-enter, pin it.
- **Run `test:integration` weekly**, not just on SDK upgrades. Contract drift is silent otherwise.

The 4-layer architecture is sound. What's missing is the execution at layers 1, 3, and 4. This proposal closes that gap.
