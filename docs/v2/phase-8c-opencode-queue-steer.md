# Phase 8c — opencode Queue + Steer

> Third of the Phase-8 series. Enables `queue` + `steer` capabilities for opencode. **Claude untouched.**
> Branch `v2-phase-8c-opencode-queue-steer` (off 8b). opencode source: `D:\WorkPlace\opencode-src` (v1.17.9).

## Design decision (locked) — read this first

opencode has **no server-side holdable queue**: a prompt POSTed to a busy session is accepted (no 409)
and **coalesced into the running loop** — the runLoop re-reads the message list each step and picks the
new message up at the next step (verified, O1 research / `session/prompt.ts` runLoop). One `session.idle`
fires at the very end of the whole coalesced loop. There is **no un-send**.

Therefore, for opencode, "queue" and "steer" collapse into ONE mechanism: **send-while-busy = post the
prompt immediately → opencode coalesces it mid-turn**. This honors both caps — `queue` enables the
renderer's type-ahead (send while running), `steer` = the mid-turn coalesce. We emit
`session:steer-consumed` right after posting so the renderer moves the queued card into the chat
(reflecting that opencode is now processing the follow-up).

**Trade-off (note in commit):** stage-and-edit *dequeue* is moot under post-immediately (can't un-send);
the `↑`-edit affordance no-ops gracefully (acceptable per the seam research). The alternative
(buffer→flush-on-idle) would support dequeue but delay the message until the current turn fully ends —
rejected as less responsive and less native to opencode.

## Verified facts (confirm the renderer ones during impl, then build on them)

- **opencode:** `POST /session/{id}/prompt_async` (or the slash `/command` route) to a busy session →
  coalesced into the runLoop, no 409. Single `session.idle` at the end.
- **ClaudeUI renderer (confirm exact shapes by reading these):**
  - `InputBox/utils.ts` `resolveSendAction`: returns `{type:'queue-prompt'}` when `running && queueEnabled` (`queueEnabled = capabilities.queue`); else `{type:'noop'}` (input retained). So `queue` MUST be true to allow send-while-busy.
  - `InputBox` `queue-prompt` case → `window.api.sendPrompt(prompt, attachments)` → IPC `session:send`.
  - `session:send` (`session.ipc.ts` ~808-831): reads `session.willQueue` BEFORE `run()`, relays `session:user-message` with `queued: willQueue`, then `session.run(prompt, attachments)`. **Confirm there is no `isClaudeSession` gate on `session:send`** (should be neutral).
  - `willQueue` getter on `OpencodeSession` already returns `this.isProcessing`.
  - `session:user-message {queued:true}` → renderer `setQueuedText` (the queued card).
  - `session:steer-consumed` → `useClaudeEvents` `onSteerConsumed` → store `consumeQueuedText(routingId)` → moves queued text into chat as a user message (`steer-${ts}`). **Confirm the exact emit payload** from `claude-session.ts` (~1029-1032: `system/queued_command_consumed` → `this.send('session:steer-consumed', …)`) and match it (likely `{ prompt }` or the prompt string — verify the preload `onSteerConsumed` + the store action signature).
  - On running→idle, `InputBox.tsx` (~414-421) auto-consumes any remaining queued text.
  - `dequeueMessage`/`session:dequeue-message`: currently hard-gated `isClaudeSession` (`session.ipc.ts` ~893). Confirm whether `dequeueMessage` is on `ISession` or Claude-only.

## Scope (locked)

1. **`OpencodeSession.run(prompt, attachments)` — steer path.** At the top of `run` (after the
   `_cancelled` reset, after the `prompt === null` eager branch), BEFORE `this.isProcessing = true`,
   insert:
   ```ts
   // A prompt arriving mid-turn coalesces into the running opencode loop (steer).
   if (this.isProcessing && this.client && this.openSessionId) {
     const userMsg: ChatMessage = { id: uuid(), role: 'user', content: [{ type:'text', text: prompt }], timestamp: Date.now() }
     this.messageHistory.push(userMsg)               // history only; renderer renders via steer-consumed
     try { await this.sendPrompt(prompt, attachments) } // reuses slash-routing + attachments + promptAsync (coalesces)
     catch (err) { logger.warn('OpencodeSession', `steer send failed: …`) }
     this.send('session:steer-consumed', <payload matching Claude's emit>)
     return
   }
   ```
   Do **NOT** reset `isProcessing`, `startTimeMs`, re-`createSession`, re-`ensureSSEConsumer`, or
   re-`applyPermissionMode` on the steer path — the turn is already live. Reuse `sendPrompt` (it already
   handles slash-command routing + attachment file-parts + `promptAsync`). The coalesced message's
   response streams in the ongoing turn; the single `session.idle` at the end already flips
   `isProcessing=false`.
2. **`session:steer-consumed` payload** — match exactly what Claude emits + what `consumeQueuedText`
   consumes (verify; emit the same shape so the renderer moves the queued card → chat as the user
   message). The opencode echo of the user message (`message.updated` role:user) is already ignored by
   the mapper, so no duplicate.
3. **dequeue** — make `dequeueMessage` a safe no-op for opencode (BaseSession default returning
   `{removed:0}` / whatever Claude returns, or an OpencodeSession override) and de-gate
   `session:dequeue-message` so an opencode call returns gracefully instead of erroring. (Rarely hit —
   the queued card clears via steer-consumed almost immediately.) Match the existing return shape.
4. **Capability flips:** `OPENCODE_ENGINE_CAPABILITIES.queue = true`, `steer = true`; update the comment.

**Out of scope:** stage-and-edit dequeue for opencode (moot — see design note); any server-side queue.

## File / seam map
- `src/main/opencode/OpencodeSession.ts` — steer path in `run`; `dequeueMessage` no-op (or via BaseSession default).
- `src/main/providers/ISession.ts` / `BaseSession.ts` — if `dequeueMessage` isn't already on `ISession` with a default, add a default no-op so the IPC can call it on any engine.
- `src/main/ipc/session.ipc.ts` (+ `remote-handlers.ts` if mirrored) — de-gate `session:dequeue-message` from `isClaudeSession` to capability/neutral (match Claude's return shape on the opencode no-op path). Confirm `session:send` needs no change.
- `src/shared/model-capabilities.ts` — flip `queue` + `steer`; update comment.
- Tests under `src/main/opencode/__tests__/`.

## Tests (mocked client, no binary)
- `run(prompt)` while **idle** → normal turn (`createSession` + `promptAsync`) — unchanged.
- `run(prompt)` while **processing** (`isProcessing=true`, `openSessionId` + client set) → STEER: calls `sendPrompt`/`promptAsync` (coalesce), emits `session:steer-consumed`, does **NOT** call `createSession` again, does **NOT** reset `isProcessing`.
- Two consecutive mid-turn sends → two `promptAsync` posts + two `session:steer-consumed` emits.
- A `/known-command` sent mid-turn still routes via `runCommand` (sendPrompt reuse) and emits steer-consumed.
- `willQueue` returns `isProcessing`.
- `dequeueMessage` on opencode → safe no-op (no throw), matches the return shape.
- caps: `queue` + `steer` true (update the resolve-capabilities / OpencodeSession cap assertions).
- Keep existing opencode tests green (esp. the eager-connect/ensureConnected ones from 8a).

## Verify
```
bun run typecheck && bun run test:ci && bun run lint && bun run build
```
(Gate via a verification subagent; app-shot deferred to a cross-phase smoke.)

## Gotchas
- **Claude untouched** — all changes are in `OpencodeSession` + the cap flip + the dequeue de-gate. Claude's `run`/queue/steer path is unchanged.
- The steer path must NOT re-init the turn (no createSession / SSE / permission re-apply / isProcessing reset / startTimeMs reset).
- **Match the steer-consumed payload** the renderer expects — wrong shape = the queued card never clears (stuck) or the message doesn't render.
- opencode coalesces — exactly one `session.idle` for the whole turn incl. steered messages; don't emit an extra result per steer.
- No `bun install`/`add`. Main-process-only opencode code.

## Commit
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): queue + steer via mid-turn prompt coalescing (Phase 8c)`.
Body should note the post-immediately design + the dequeue trade-off.
