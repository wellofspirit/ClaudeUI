# Checkpoint 1: Team/Agent Messages Not Working in ClaudeUI

## Problem Statement

When running agent teams in ClaudeUI, teammates spawn successfully but the team-lead never receives their messages. The session hangs after the first AI turn completes. In the CLI, teams work fine — the team-lead autonomously processes teammate messages and responds.

## Architecture Overview

### How the SDK API works (ClaudeUI's path)

```
ClaudeUI (Electron main process)
  → calls sdkQuery({ prompt: AsyncIterable, options: {...} })
    → sdk.mjs spawns cli.js subprocess with:
        --output-format stream-json --verbose --input-format stream-json
    → sdk.mjs pipes messages:
        AsyncIterable → JSON+newline → subprocess stdin
        subprocess stdout → JSON parse → AsyncGenerator<SDKMessage>
    → sdk.mjs is a DUMB PIPE — no conversation loop logic
```

### How the CLI subprocess works internally

The subprocess runs `B3z()` (aka `runHeadless`), which calls `m3z()`. Inside `m3z`:

1. **Setup phase**: variable init, MCP, sandbox, plugins, etc.
2. **Two concurrent paths**:
   - **`f6()`** — the query execution function. Dequeues from `queuedCommands`, runs the AI turn via `hDq()`, processes results, then checks for team inbox messages.
   - **Stdin IIFE** — `(async () => { for await (let r of A.structuredInput) { ... } })()` — reads messages from stdin, dispatches control requests and user messages, calls `f6()` when a new prompt arrives.
3. **Return**: `m3z` returns `G` (an async queue) that the caller iterates to yield `SDKMessage` objects.

### How the CLI handles teams (interactive mode)

The CLI's React Ink UI has `lGq()` (InboxPoller hook):
- Polls `~/.claude/teams/{team}/inboxes/team-lead.json` every 1 second
- Classifies messages (permissions, shutdown, plan approval, regular)
- When session idle: calls `onSubmitMessage(xml)` → triggers new AI turn
- When session busy: queues in `inbox.messages` state, delivers when turn completes

### How the CLI handles teams (headless/print mode)

In `m3z()` / `f6()`, after each AI turn's `result`:
```
f6() completes a turn → result received
  → check queuedCommands → if non-empty, loop
  → check teamContext → if team lead:
      while(true):
        check YK1() (any running in_process_teammate tasks?)
        check teammates in teamContext
        if neither → break (no more teammates)

        read inbox: m56("team-lead", teamName)
        if unread messages:
          format as <teammate-message> XML
          By({mode:"prompt", value:xml}, setAppState)  // queue as prompt
          f6()  // recurse to run next turn
          return

        sleep 500ms  // poll interval
```

## Key SDK Internals Discovered

### File-based mailbox system
- Location: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- Write: `s5(recipient, {from, text, timestamp}, teamName)` — with file locking
- Read: `ed(agentName, teamName)` → returns all messages
- Unread: `m56(agentName, teamName)` → filters `!msg.read`
- Clear: `qQ6(agentName, teamName)` — marks all as read

### Team lead check: `cX(teamContext)`
```js
function cX(A) {
  if (!A?.leadAgentId) return false;
  let q = V0();        // current agent's ID
  let K = A.leadAgentId;
  if (q === K) return true;
  if (!q) return true;  // no agentId = top-level = leader
  return false;
}
```

### Active teammates check: `YK1(appState)`
```js
function YK1(A) {
  for (let q of Object.values(A.tasks))
    if (q.type === "in_process_teammate" && q.status === "running") return true;
  return false;
}
```

### Message XML format
```xml
<teammate-message teammate_id="agent-name" color="cyan" summary="brief summary">
  {message JSON text}
</teammate-message>
```

### `isSingleUserTurn` in sdk.mjs
- `typeof prompt === "string"` → true → closes stdin after first result
- `AsyncIterable` → false → keeps subprocess alive
- ClaudeUI passes AsyncIterable (MessageChannel), so subprocess stays alive ✓

## Current Investigation: Session Hangs

### Debug logging results

Added `console.error("[DEBUG-TEAM] ...")` at key points in `cli.js` (in-place, not as patch).

**Only this fires:**
```
[SDK stderr] [DEBUG-TEAM] m3z initialized, stream-json mode active
```

**These never fire:**
```
[DEBUG-TEAM] m3z setup complete, starting stdin loop
[DEBUG-TEAM] about to start stdin IIFE
[DEBUG-TEAM] stdin for-await loop starting
[DEBUG-TEAM] f6() called
[DEBUG-TEAM] do-while iteration start
[DEBUG-TEAM] result received in hDq loop
```

### Hypothesis

The `m3z()` function has extensive setup between the variable initialization and the `return` statement that starts the stdin loop:

```
m3z() {
  let D=!1, X=!1, M=!1, P=null, W, G=new hp6   ← LOG HERE fires

  // ~10KB of setup code:
  // - Event subscriptions (Gj.subscribe)
  // - Sandbox init
  // - Output writer creation (U3z)
  // - Hook setup (Jo7)
  // - Setup trigger
  // - Message history loading (p3z)
  // - MCP server reconnection
  // - Plugin installation
  // - f6 function definition
  // - Various async operations

  return A.setUnexpectedResponseCallback(...)    ← LOG HERE never fires
    ,(async () => { for await (...) { ... } })()
    ,G
}
```

**Something in the setup phase is either:**
1. **Throwing an unhandled error** — but it's unclear where it goes since there's no outer try-catch shown
2. **Hanging on an async await** — e.g., `await p3z()` (message history loading), `await F1()` (setup), sandbox initialization, MCP server connection, or plugin installation
3. **Blocked by a missing/failed dependency** — specific to the subprocess environment when spawned by the SDK

### Most likely suspects

1. **`p3z()` (message history)** — loads session history, may hang if session file is locked or malformed
2. **`vS8()` / `await MP6()` / `await A9q()`** — early setup, sandbox/auth checks
3. **MCP server connection** — `p()` runs async MCP reconnection
4. **Plugin installation** — `A6 = l()` or similar

### Next step

Added latest debug logs:
- `[DEBUG-TEAM] m3z setup complete, starting stdin loop` — right before the `return` (after ALL setup)
- `[DEBUG-TEAM] about to start stdin IIFE` — right before the async IIFE
- `[DEBUG-TEAM] IIFE CRASHED: <error>` — try-catch wrapper around entire IIFE

If `m3z setup complete` never fires, the hang is in the setup phase and we need to bisect the ~10KB of code between init and return to find the specific blocking call.

If `about to start stdin IIFE` fires but `stdin for-await loop starting` doesn't, then `A.structuredInput` (the stdin reader) is broken.

If `IIFE CRASHED` fires, we get the actual error.

## Debug Log Locations (in cli.js, in-place edits)

All logs use `console.error("[DEBUG-TEAM] ...")` which routes through the SDK's stderr callback to Electron's console.

| # | Offset (approx) | Log message | Purpose |
|---|---|---|---|
| 1 | 10803493 | `m3z initialized` | Confirms headless path entered |
| 2 | 10813929 | `m3z setup complete` | Confirms all setup finished |
| 3 | 10814041 | `about to start stdin IIFE` | Before the async loop starts |
| 4 | 10814074 | `stdin for-await loop starting` | Inside IIFE, before first iteration |
| 5 | 10814100+ | `stdin msg received: <type>` | Each message from stdin |
| 6 | 10814100+ | `processing initialize request` | Initialize control request |
| 7 | 10814644 | `calling F3z (initialize)` | Before init handler |
| 8 | 10814644+ | `F3z done` | After init handler |
| 9 | 10814644+ | `queuedCommands>0 after init` | If init triggers f6 |
| 10 | 10819718 | `user msg queued, calling f6` | User message received |
| 11 | 10806891 | `f6() called, D=` | Query function entry |
| 12 | 10810089 | `result received in hDq loop` | AI turn completed |
| 13 | 10810528 | `do-while iteration start` | Turn loop iteration |
| 14 | 10810920+ | `queuedCommands not empty` | Post-result queue check |
| 15 | 10810920+ | `post-result teamContext` | Team state after turn |
| 16 | 10810920+ | `cX(Y6)=` | Team leader check |
| 17 | 10811186+ | `no active teammates` | Break condition |
| 18 | 10811186+ | `inbox poll: unread=` | Inbox polling |
| 19 | 10812660+ | `queuing teammate messages` | Messages being re-injected |
| 20 | 10819299 | `stdin closed (X=true)` | Stdin EOF |
| 21 | 10820118 | `IIFE CRASHED: <error>` | Catch-all error handler |

## Files Involved

- `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — SDK CLI bundle (debug edits in-place)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` — SDK wrapper that spawns cli.js
- `src/main/services/claude-session.ts` — ClaudeUI's session wrapper

## Key Function Names (minified → purpose)

| Minified | Purpose |
|---|---|
| `B3z` | `runHeadless()` — headless mode entry point |
| `m3z` | Main headless function (query loop + stdin reader) |
| `f6` | Query execution function (runs AI turn, checks team inbox) |
| `hDq` | Core query generator (API calls, tool execution) |
| `pJ1` | Dequeue from `queuedCommands` |
| `By` | Enqueue to `queuedCommands` |
| `M6` | Inner function that runs the query turn loop |
| `m56` | `readUnreadMessages(agentName, teamName)` |
| `ed` | `readMailbox(agentName, teamName)` |
| `s5` | `writeToMailbox(recipient, message, teamName)` |
| `qQ6` | `markAllAsRead(agentName, teamName)` |
| `cX` | `isTeamLead(teamContext)` |
| `YK1` | `hasRunningTeammates(appState)` |
| `V0` | `getAgentId()` |
| `lGq` | InboxPoller React hook (CLI interactive only) |
| `JJ` | `"teammate-message"` (XML tag constant) |
| `F3z` | Initialize handler (processes SDK init control request) |
| `U3z` | Creates output writer from prompt input |
| `p3z` | Loads message history for resume/continue |

## What Needs to Happen (the eventual fix)

Once we get past the hang, the headless CLI subprocess should:
1. Run the team-lead's first AI turn (creates team, spawns teammates)
2. After `result`, enter the `while(true)` inbox polling loop
3. Read unread messages from `~/.claude/teams/{team}/inboxes/team-lead.json`
4. Format them as `<teammate-message>` XML
5. Queue via `By()` and call `f6()` to run the next AI turn
6. Repeat until all teammates are done

If the polling loop works natively in the subprocess, ClaudeUI just needs to keep the stdin pipe open (which it already does via MessageChannel). The messages will flow through stdout as normal `assistant`/`stream_event`/`user`/`result` messages.

If the polling loop does NOT work (e.g., `teamContext` is never populated in headless mode), we'll need a patch or a bridge in `claude-session.ts` that:
- Polls the inbox file from the Electron main process
- Pushes teammate messages back into the MessageChannel as synthetic user messages
- Formats them as `<teammate-message>` XML so the AI recognizes them
