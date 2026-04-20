# 11 — Cancellation

Three independent cancellation tiers. Understanding the split is crucial — they trigger differently and have different reach.

| Tier | Who triggers it | Reach |
|---|---|---|
| **Query-wide** | Host (us) — `AbortController.abort()` or `SIGTERM` | Whole query, including the subprocess |
| **Per-inbound-request** | cli.js → us — `control_cancel_request{request_id}` | One specific inbound handler (canUseTool, hook, elicitation, oauth, user_dialog) |
| **Per-outbound-request** | Host (us) — request timeout or manual | One specific outbound control_request |

---

## 11.1 Query-wide cancellation

Triggered by the host. Kills cli.js outright. Two entry points:

### `AbortController.abort()`

```ts
const ac = new AbortController()
const q = query({
  prompt: '...',
  options: { abortController: ac, ... },
})

// ...later:
ac.abort()
```

Internals:
1. `ac.signal` abort listener fires inside `query.ts`.
2. `child.kill('SIGTERM')` sent to cli.js subprocess.
3. cli.js exits (UNIX: SIGTERM default; Windows: TerminateProcess).
4. Our `child.on('exit', ...)` fires:
   - Removes the abort listener (prevents leaks across queries).
   - `control.rejectAll('cli.js exited')` — every outstanding outbound control_request rejects.
   - `control.abortAllInbound()` — every in-flight inbound handler's AbortSignal fires.
   - `writer.end()` — closes stdin.
   - `queue.finish()` — consumer's `for await (const msg of handle)` resolves (or rejects if exit was non-zero).

The AbortController may be reused across multiple queries. The listener is added with `{once: true}` and explicitly removed on child exit, so there's no accumulation.

### Graceful: `queryHandle.endSession()`

```ts
await q.endSession()
```

Sends `control_request { subtype: 'end_session' }` with a 5 s timeout. cli.js flushes pending output, writes a final `result` line, breaks its main read loop, exits code 0.

**Use when** the host initiates shutdown (user closes the window, app quits, session is torn down intentionally). Prefer this over SIGTERM — it's deterministic, no risk of dropping an in-flight tool result.

---

## 11.2 Per-inbound-request cancellation

cli.js sends us `control_request` messages (can_use_tool, hook_callback, elicitation, oauth_token_refresh, request_user_dialog). When cli.js no longer needs our answer — because the user interrupted, the parent tool was cancelled, a timeout fired inside cli.js, etc. — it sends:

```json
{ "type": "control_cancel_request", "request_id": "<same id>" }
```

Our harness handles this:
1. `ControlChannel.cancelInbound(request_id)` fires the AbortController registered at `beginInbound(request_id)`.
2. The `signal` we passed into the callback context (`canUseTool`, hook callback, `onElicitation`, `getOAuthToken`, `onUserDialog`) transitions to aborted.
3. The consumer's handler observes `signal.aborted` and bails (e.g., dismiss the UI prompt without user action).

### Registering a handler

Inside `query.ts::handleControlRequest`, every inbound request is wrapped:

```ts
const ac = ctx.control.beginInbound(request_id)
try {
  // dispatch to handler — pass ac.signal
} finally {
  ctx.control.endInbound(request_id)
}
```

`beginInbound` creates a fresh `AbortController` and stores it in `ControlChannel.inbound: Map<request_id, AbortController>`. `endInbound` removes it (whether completed or errored). `cancelInbound` fires it and also removes.

### What should the consumer do?

When `signal.aborted` fires mid-callback:
1. **If UI is shown**: dismiss it. User should not be left with a stale prompt.
2. **If already computing**: bail out via `throw new Error(...)` or return a sentinel.
3. **Do NOT send a control_response** — cli.js has discarded its expectation. Sending one is benign (we wrap in try/finally), but wasteful.

Our harness catches the `abort` exception and invokes `respondError(request_id, 'handler failed')`. cli.js's side of the channel may ignore that (it already moved on). That's fine.

### Concrete scenario

User triggers agent → agent calls Bash → we show permission prompt. User presses `interrupt` in the UI. ClaudeUI sends `queryHandle.interrupt()` (outbound `control_request { subtype: 'interrupt' }`). cli.js:
1. Handles the interrupt, stops the current turn.
2. Fires `control_cancel_request` for any outstanding `can_use_tool` it had sent us.
3. Our `canUseTool` context's `signal.aborted` flips.
4. The UI's `useEffect(() => signal.addEventListener('abort', dismiss))` dismisses the dialog.

---

## 11.3 Per-outbound-request timeouts

`ControlChannel.request(payload, { timeoutMs })` in `src/main/sdk/control.ts`. Default **30 s**. Configurable per-call.

| Subtype | Timeout | Reason |
|---|---|---|
| `initialize` | 60 s | First-run model listing / plugin scan can be slow |
| `mcp_authenticate` | 0 (disabled) | Blocks on user completing OAuth in browser |
| `claude_authenticate` | 0 | Same — browser-driven OAuth |
| `claude_oauth_callback` | 0 | Long-lived completion |
| `claude_oauth_wait_for_completion` | 0 | Explicit wait |
| `end_session` | 5 s | Short — cli.js should drain fast |
| Everything else | 30 s | Default |

When a timeout fires:
1. The pending entry is removed from `pending: Map<request_id, PendingRequest>`.
2. The Promise rejects with `Error('control_request <subtype> (<id>) timed out after <ms>ms')`.
3. cli.js's response, if it ever arrives, is silently dropped by `handleResponse()` (no matching pending entry).

Without a timeout, a pathological cli.js state (hung MCP server, blocked OAuth callback) would leak a pending Promise forever. The timeout is a safety net.

**Set `timeoutMs: 0` to disable** for genuinely long-lived operations. Never leave the default on user-interactive subtypes.

---

## 11.4 Cleanup on query teardown

When cli.js exits (for any reason — clean, SIGTERM, crash):

```ts
child.on('exit', () => {
  control.rejectAll('cli.js exited')
  writer.end()
  queue.finish()
})
```

`rejectAll()`:
- Iterates `pending` map, calls each entry's `reject(new Error('cli.js exited'))` after clearing its timer.
- Clears the map.
- Calls `abortAllInbound()` — every outstanding inbound handler's AbortSignal fires.

Net effect: every Promise tied to the query resolves/rejects. No leaks. The consumer iterator finishes.

---

## 11.5 Guarantees and failure modes

### Guaranteed

- An outbound `control_request` either resolves, rejects on error, rejects on timeout, or rejects on query teardown. It will never leak forever.
- An inbound `control_request` handler's `signal` will fire on either cli.js-side cancellation or query teardown.
- `AbortController.abort()` on the query's controller always SIGTERMs the child (or invokes the custom spawn's signal plumbing).

### Not guaranteed

- That cli.js has finished cleanly when `endSession()` resolves. The subprocess may still be running a beat or two after the control_response returns. Observe `child.on('exit')` if you need strict ordering.
- That all pending `stream_event` deltas arrive before a `result`. They should, but if cli.js is killed mid-stream, anything buffered is lost.
- That a `control_cancel_request` arrives before the consumer finishes responding. Race window: consumer called `respondSuccess()` just as cli.js sent the cancel. Harmless — cli.js's response-processing is idempotent on canceled requests.

---

## 11.6 Interrupt vs end_session vs SIGTERM

| Action | Turn-in-progress | Subprocess | Recommended use |
|---|---|---|---|
| `interrupt()` | Cancels | Stays alive | Mid-turn user interrupt; allow the agent to finish cleanup |
| `endSession()` | Cancels cleanly, drains output | Exits code 0 | Normal session shutdown |
| `AbortController.abort()` | Killed abruptly | SIGTERM | Unclean shutdown (window close, quit) |
| `child.kill('SIGKILL')` | Killed instantly | Force killed | Never — we have no path that issues this |

The happy path for most interactions is `interrupt()` for mid-turn cancellation and `endSession()` for cleanup. SIGTERM is the last-resort safety net.
