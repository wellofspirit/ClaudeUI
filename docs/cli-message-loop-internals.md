# CLI Message Loop Internals

Deep documentation of the Claude Agent SDK CLI's (`cli.js`) internal message loop architecture, focusing on the queue system, steer (mid-turn user message) handling, and the sub-turn lifecycle. Based on reverse engineering of the minified bundle.

> **SDK version**: 0.2.50 — minified names are version-specific. See [Appendix A](#appendix-a-minified-name-mapping-sdk-0250) for the full mapping.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Queue Module](#2-the-queue-module)
3. [The Main Query Generator (queryGenerator)](#3-the-main-query-generator-querygenerator)
4. [The Sub-Turn Loop (Inside queryGenerator)](#4-the-sub-turn-loop-inside-querygenerator)
5. [Attachment System](#5-attachment-system)
6. [Steer: Mid-Turn User Message Lifecycle](#6-steer-mid-turn-user-message-lifecycle)
7. [The SDK Session Class (SessionQuery)](#7-the-sdk-session-class-sessionquery)
8. [The SDK Streaming Handler (sdkStreamingHandler)](#8-the-sdk-streaming-handler-sdkstreaminghandler)
9. [The Do-While Outer Loop](#9-the-do-while-outer-loop)
10. [CLI REPL React Layer](#10-cli-repl-react-layer)
11. [Implications for ClaudeUI](#11-implications-for-claudeui)
12. [Appendix A: Minified Name Mapping (SDK 0.2.50)](#appendix-a-minified-name-mapping-sdk-0250)
13. [Appendix B: Bundle Analyzer Commands](#appendix-b-bundle-analyzer-commands)

---

## 1. Architecture Overview

The CLI processes messages through a layered architecture:

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLI REPL (React/Ink)                                               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  replComponent — React component, handles UI + key events   │    │
│  │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  │  onQuery callback — for await(Ly(...)) b8(msg)       │   │    │
│  │  └──────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│  SDK Path (when used as library, e.g. ClaudeUI)                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  sdkStreamingHandler (h6) — do-while loop                   │    │
│  │  ├── Dequeues from Queue via dequeueOne()                   │    │
│  │  ├── Calls sdkEntrypoint() → SessionQuery.submitMessage()   │    │
│  │  └── Enqueues results to ReadableStream controller (Z)      │    │
│  └─────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│  Session Layer                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  SessionQuery class — manages one agent turn                │    │
│  │  submitMessage() → for await(queryGenerator(...)) yield msg │    │
│  └─────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│  Query Layer                                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  queryGenerator — while(!0) sub-turn loop                   │    │
│  │  ├── Snapshots queue → builds attachments                   │    │
│  │  ├── Calls apiStreaming() for model response                │    │
│  │  ├── Executes tools                                         │    │
│  │  ├── stopHookHandler() for pre/post hooks                   │    │
│  │  └── Loops (reassigns messages, continues)                  │    │
│  └─────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│  Queue Module                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  queueArray (L$) — in-memory array of queued items          │    │
│  │  push(), dequeueOne(), removeConsumed(), popAllEditable()   │    │
│  │  frozenSnapshot (i24) — read-only copy for UI               │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

Data flows **downward** (user input → queue → query → API), while events flow **upward** (API response → query yields → session yields → consumer).

---

## 2. The Queue Module

The queue is a simple in-memory array (`queueArray`) with helper functions. It is the central mechanism for mid-turn message injection.

### Queue Item Shape

```typescript
interface QueueItem {
  value: string | ContentBlock[];  // the message content
  mode: "prompt" | "task-notification" | "task-started" | "orphaned-permission" | "bash";
  priority?: "now" | "next" | "later";  // default: "next" for push(), "later" for pushLater()
  imagePasteIds?: string[];
  // NOTE: no `uuid` field on natively queued items
}
```

### Queue Functions

| Function | Pseudoname | What it does |
|---|---|---|
| `push(item)` | `queuePush` | Appends with `priority: "next"` (default). Calls `notifySubscribers()`. Logs `"enqueue"`. |
| `pushLater(item)` | `queuePushLater` | Appends with `priority: "later"` (default). Same notifications. |
| `dequeueOne()` | `dequeueOne` | Removes and returns the highest-priority item (priority order: `now=0, next=1, later=2`). Logs `"dequeue"`. |
| `removeConsumed(items)` | `removeConsumed` | Removes items from `queueArray` by **`.value` match** (not by reference or UUID). Called after queue items are converted to attachments. Logs `"remove"` per item. |
| `removeByPredicate(fn)` | `removeByPredicate` | Removes items where `fn(item)` returns true. Returns removed items. Used for cleanup (e.g., removing `task-started` items on result). |
| `popAllEditable(currentInput, cursorOffset)` | `popAllEditable` | **The edit mechanism**: separates editable vs non-editable items, pops all editable ones from queue, concatenates their text with `currentInput`, returns `{text, cursorOffset, images}`. Clears queue and re-inserts only non-editable items. |
| `snapshotQueue()` | `snapshotQueue` | Returns `[...queueArray]` — a shallow copy. Used by `queryGenerator` to capture queue state at sub-turn boundaries. |
| `getFrozenSnapshot()` | `getFrozenSnapshot` | Returns `frozenSnapshot` (`Object.freeze([...queueArray])`). Used by UI via `useSyncExternalStore`. |
| `isNonEmpty()` | `queueNonEmpty` | Returns `queueArray.length > 0`. Used by the do-while loop condition. |
| `subscribe(callback)` | `subscribe` | Adds to subscriber set. Returns unsubscribe function. |
| `notifySubscribers()` | `notifySubscribers` | Updates `frozenSnapshot` and calls all subscribers. |
| `logQueueOp(operation, content?)` | `logQueueOp` | Writes to SQLite via `recordQueueOperation()`. Does NOT emit to SDK stream. |

### Editability

The function `isEditable(mode)` returns `true` if the mode is NOT in the non-editable set:

```javascript
const NON_EDITABLE_MODES = new Set(["task-notification", "task-started"]);
function isEditable(mode) { return !NON_EDITABLE_MODES.has(mode); }
```

So `"prompt"` mode items ARE editable, while system items are not.

### Queue Text Extraction

```javascript
function extractQueueText(value) {
  if (typeof value === "string") return value;
  let parts = [];
  for (let block of value)
    if (block.type === "text") parts.push(block.text);
  return parts.join("\n");
}
```

---

## 3. The Main Query Generator (`queryGenerator`)

`queryGenerator` is an `async function*` that implements the core sub-turn loop. It is the workhorse of the entire agent system.

### Signature

```typescript
async function* queryGenerator({
  messages,          // conversation history
  systemPrompt,      // system prompt string
  userContext,        // user context attachments
  systemContext,      // system context attachments
  canUseTool,        // permission callback
  toolUseContext,    // tool config, app state, abort controller, etc.
  fallbackModel,     // model to fall back to on error
  querySource,       // "repl_main_thread" | "sdk" | "compact" | etc.
  maxOutputTokensOverride,
  maxTurns,          // max sub-turns before stopping
  skipCacheWrite     // whether to skip caching
}): AsyncGenerator<Message>
```

### High-Level Flow

```
queryGenerator entry
│
├── Initialize: turnCount=1, working copies of messages
│
└── while(!0) {                          ← INFINITE LOOP (sub-turns)
      │
      ├── Microcompaction (trim if needed)
      ├── Autocompaction (summarize if needed)
      │
      ├── ▶ QUEUE SNAPSHOT: f6 = snapshotQueue()
      │     (only if querySource is "repl_main_thread" or "sdk")
      │
      ├── ▶ ATTACHMENTS: for await(attachmentGenerator(..., f6, ...))
      │     yield attachment, push to toolResults[]
      │     (this converts queue items → queued_command attachments)
      │
      ├── ▶ QUEUE CLEANUP: removeConsumed(f6.filter(prompt))
      │     (removes consumed items from queueArray by .value match)
      │
      ├── Refresh tools if needed
      ├── Check maxTurns limit
      │
      ├── Build next messages: [...userMessages, ...assistantMessages, ...toolResults]
      ├── Reassign loop variables (A=messages, w=toolUseContext, etc.)
      │
      ├── ── LOOP BACK TO while(!0) ──
      │
      │   ... within the loop body, between snapshot and cleanup:
      │
      ├── ▶ API STREAMING: while(retryable) {
      │     for await(apiStreaming({messages, systemPrompt, tools, ...}))
      │       yield each event (assistant, stream_event, attachment, etc.)
      │   }
      │
      ├── ▶ TOOL EXECUTION:
      │     either via StreamingToolExecutor (parallel) or sequential bX1()
      │     yields tool results, pushes to toolResults[]
      │
      ├── Abort check → return if aborted
      ├── Stop hook handler → may return or continue
      └── Loop continues...
    }
```

### Key Detail: Queue Snapshot Timing

The queue snapshot happens **at the top of each sub-turn iteration**, before attachments are built and before the API call. This means:

1. Items added to the queue during the previous sub-turn's tool execution are captured
2. Items added **during** the current sub-turn's API call or tool execution are NOT in this snapshot — they'll be captured in the next iteration
3. Between snapshot and cleanup, items are still in `queueArray` — but `removeConsumed` will remove them after `attachmentGenerator` completes

---

## 4. The Sub-Turn Loop (Inside `queryGenerator`)

A more detailed look at what happens in each sub-turn:

### Phase 1: Pre-processing

```javascript
let workingMessages = [...normalizeMessages(messages)];
// Microcompact (trim old messages if over threshold)
// Autocompact (summarize conversation if needed)
let systemPromptFinal = buildSystemPrompt(systemPrompt, systemContext);
```

### Phase 2: Queue Snapshot + Attachments

```javascript
let queueSnapshot = (querySource === "repl_main_thread" || querySource === "sdk")
  ? snapshotQueue()   // [...queueArray]
  : [];

for await (let att of attachmentGenerator(null, toolUseContext, null, queueSnapshot, allMessages, querySource))
  yield att;                    // yields attachment events (including queued_command)
  toolResults.push(att);        // attachments become part of messages for next API call

// Cleanup: remove consumed prompt items from live queue
let consumedPrompts = queueSnapshot.filter(item => item.mode === "prompt");
if (consumedPrompts.length > 0) removeConsumed(consumedPrompts);
```

### Phase 3: API Call

```javascript
let streamingFallback = false;
while (retryable) {
  retryable = false;
  try {
    for await (let event of apiStreaming({
      messages: transformMessages(workingMessages, userContext),
      systemPrompt: systemPromptFinal,
      tools, signal, model, ...
    })) {
      // Handle model fallback
      if (event) {
        // Yield tombstones for orphaned messages on fallback
        yield event;
        if (event.type === "assistant") {
          assistantMessages.push(event);
          // Feed to StreamingToolExecutor if enabled
        }
      }
    }
  } catch (e) {
    if (e instanceof ModelFallbackError && fallbackModel) {
      // Switch model and retry
      retryable = true;
      continue;
    }
    throw e;
  }
}
```

### Phase 4: Tool Execution

```javascript
if (streamingToolExecutor) {
  // Parallel execution — tools started during streaming
  for await (let result of executor.getRemainingResults()) {
    yield result.message;
    toolResults.push(...normalize(result));
  }
  toolUseContext = executor.getUpdatedContext();
} else {
  // Sequential execution
  for await (let result of executeToolsSequential(toolUses, assistantMessages, canUseTool, toolUseContext)) {
    yield result.message;
    toolResults.push(...normalize(result));
  }
}
```

### Phase 5: Continuation Check

```javascript
// Abort check
if (toolUseContext.abortController.signal.aborted) {
  // Handle interrupt
  return;
}

// Max output tokens recovery
if (lastMessage.stop_reason === "max_tokens" && recoveryCount < 3) {
  // Inject "continue from where you left off" message
  // Reassign and continue
  continue;
}

// Stop hooks
let hookResult = yield* stopHookHandler(workingMessages, assistantMessages, ...);
if (hookResult.preventContinuation) return;
if (hookResult.blockingErrors.length > 0) {
  // Reassign with blocking errors and continue
  continue;
}

// If no tool use in last response, we're done
return;

// Otherwise: build next messages and loop
let nextMessages = [...workingMessages, ...assistantMessages, ...toolResults];
// Reassign: A = nextMessages, w = toolUseContext, etc.
// continue → back to while(!0)
```

---

## 5. Attachment System

Attachments are injected between sub-turns to provide context to the model. They are processed by a pipeline:

### `buildAttachments(prompt, context, ideState, queueSnapshot, messages, querySource)`

Collects attachments from multiple async sources in parallel:

```
Always-on attachments:
  - date_change         — "The date has changed" reminder
  - changed_files       — files modified outside the editor
  - nested_memory       — CLAUDE.md / memory files
  - dynamic_skill       — skill content
  - skill_listing       — available skills
  - ultra_claude_md     — ultra memory
  - plan_mode           — plan mode state
  - plan_mode_exit      — plan mode exit notification
  - todo_reminders      — todo list reminders
  - critical_system_reminder — critical reminders
  - team context (if team mode)

Main-thread-only attachments (querySource === "repl_main_thread" or "sdk"):
  - ide_selection       — selected lines in IDE
  - ide_opened_file     — opened file in IDE
  - output_style        — active output style
  - diagnostics         — LSP diagnostics
  - lsp_diagnostics     — LSP diagnostic details
  - unified_tasks       — background task reminders
  - async_hook_responses — hook results
  - token_usage         — token budget
  - budget_usd          — USD budget
  - verify_plan_reminder — plan verification
  - queued_commands     — ★ QUEUE ITEMS CONVERTED HERE
```

### `queueItemsToAttachments(queueSnapshot)`

```javascript
function queueItemsToAttachments(queueSnapshot) {
  if (!queueSnapshot) return [];
  return queueSnapshot
    .filter(item => item.mode === "prompt")
    .map(item => ({
      type: "queued_command",
      prompt: item.value,
      source_uuid: item.uuid,         // only present if set by caller
      imagePasteIds: item.imagePasteIds
    }));
}
```

### `normalizeAttachment(attachment)` — The `queued_command` Case

When `normalizeAttachment` encounters `type: "queued_command"`:

```javascript
case "queued_command": {
  if (Array.isArray(attachment.prompt)) {
    // Multi-block prompt (text + images)
    let textParts = attachment.prompt
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
    let images = attachment.prompt.filter(b => b.type === "image");
    let content = [{
      type: "text",
      text: `The user sent a new message while you were working:\n${textParts}\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`
    }, ...images];
    return normalizeToMessages([createUserMessage({ content, isMeta: true })]);
  }
  // String prompt
  return normalizeToMessages([createUserMessage({
    content: `The user sent a new message while you were working:\n${attachment.prompt}\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`,
    isMeta: true
  })]);
}
```

This is why the steer appears as "The user sent a new message while you were working: ..." — it's injected as a meta user message in the API request's messages array.

---

## 6. Steer: Mid-Turn User Message Lifecycle

### Complete Timeline

```
Time ─────────────────────────────────────────────────────────────────────►

T0: User types message while agent is running
    │
    ├── UI: jk({value: "Fix the bug", mode: "prompt"})
    │         → queueArray.push(item)
    │         → notifySubscribers()
    │         → frozenSnapshot updated
    │         → UI re-renders: shows queued message in chat (static)
    │         → Placeholder hint: "Press up to edit queued messages"
    │
    ├── ★ EDITABLE WINDOW OPENS
    │   User can press UP → popAllEditable() pops from queue → text in input box
    │
T1: Current sub-turn's API call + tool execution completes
    │
T2: queryGenerator loops back to while(!0) top
    │
    ├── f6 = snapshotQueue()  ← items captured in snapshot
    │   (queueArray items are STILL in queueArray at this point)
    │
    ├── attachmentGenerator(..., f6, ...) runs
    │   ├── queueItemsToAttachments(f6) → [{type:"queued_command", prompt:...}]
    │   ├── normalizeAttachment() → "The user sent a new message..."
    │   └── yield attachment → flows up through Ly → vHq
    │
    ├── removeConsumed(promptItems)
    │   ├── Removes from queueArray by .value match
    │   ├── notifySubscribers()
    │   └── ★ EDITABLE WINDOW CLOSES — item gone from queue
    │
T3: Next API call includes the queued_command as a user message
    │
    └── Model sees: "The user sent a new message while you were working: Fix the bug"
```

### The Race Condition Window

The editable window is the time between T0 (message enters queue) and T2 (queue snapshot). During this window:

- The item is in `queueArray`
- `isNonEmpty()` returns `true`
- `getFrozenSnapshot()` includes the item
- UI shows the message as a queued/pending message
- User can press UP to pop it back to input

After T2 (snapshot taken), even removing from `queueArray` doesn't help — the snapshot `f6` is an independent copy already passed to `attachmentGenerator`.

### What the SDK Consumer Sees

| Event | CLI REPL (React) | SDK Consumer (ClaudeUI) |
|---|---|---|
| Item enters queue | UI re-renders via `useSyncExternalStore(subscribe, getFrozenSnapshot)` | **Nothing** — queue is internal to CLI process |
| Item consumed as attachment | Queue display updates (item disappears) | **Nothing** — `queued_command` attachment is NOT yielded when `replayUserMessages=false` |
| Model processes steer | Response references the steer content | Assistant message contains response to steer |

**Key gap**: ClaudeUI has no way to know when a steer transitions from "editable" to "consumed."

---

## 7. The SDK Session Class (`SessionQuery`)

`SessionQuery` (class `rWq`) wraps `queryGenerator` and yields SDK-formatted events.

### `submitMessage(prompt, options)` — Key Parts

```javascript
// For each event from queryGenerator:
for await (let event of queryGenerator({messages, systemPrompt, ...})) {
  // Push to mutableMessages for all conversation types
  if (event.type === "assistant" || event.type === "user" || event.type === "system") {
    messages.push(event);
  }

  switch (event.type) {
    case "assistant":
      this.mutableMessages.push(event);
      yield* yieldHelper(event);   // yields {type:"assistant", message, session_id, uuid, ...}
      break;

    case "user":
      this.mutableMessages.push(event);
      yield* yieldHelper(event);   // yields {type:"user", message, session_id, uuid, ...}
      break;

    case "stream_event":
      if (includePartialMessages)
        yield {type: "stream_event", event: event.event, ...};
      break;

    case "attachment":
      this.mutableMessages.push(event);
      if (event.attachment.type === "structured_output")
        structuredOutput = event.attachment.data;
      else if (event.attachment.type === "max_turns_reached")
        yield {type: "result", subtype: "error_max_turns", ...}; return;
      else if (replayUserMessages && event.attachment.type === "queued_command")
        // ★ Only yields if replayUserMessages=true
        yield {type: "user", message: {role:"user", content: event.attachment.prompt},
               isReplay: true, uuid: event.attachment.source_uuid, ...};
      break;

    case "system":
      // compact_boundary handling
      break;

    case "tool_use_summary":
      yield {type: "tool_use_summary", ...};
      break;
  }

  // Budget check
  if (maxBudgetUsd !== undefined && totalCost >= maxBudgetUsd)
    yield {type: "result", subtype: "error_max_budget_usd", ...}; return;
}

// After loop: yield final result
yield {type: "result", subtype: "success", result: lastText, ...};
```

### The `replayUserMessages` Gate

The `queued_command` attachment is only yielded to the SDK consumer when `replayUserMessages` is explicitly set to `true`. With the default (`false`):

- The attachment is pushed to `mutableMessages` (internal tracking)
- No event is yielded — the consumer is completely unaware
- The steer silently becomes part of the conversation context

---

## 8. The SDK Streaming Handler (`sdkStreamingHandler`)

When the SDK is used as a library (e.g., ClaudeUI), the streaming handler manages the outer loop:

### Structure

```javascript
sdkStreamingHandler = async () => {
  // Dequeue and process items one at a time
  while (currentItem = dequeueOne()) {
    // Validate mode
    if (mode !== "prompt" && mode !== "orphaned-permission" &&
        mode !== "task-notification" && mode !== "task-started")
      throw Error("only prompt commands are supported in streaming mode");

    // Handle task-notification: parse XML, emit system event
    if (mode === "task-notification") {
      Z.enqueue({type: "system", subtype: "task_notification", task_id, status, ...});
    }

    // Handle task-started: emit and continue
    if (mode === "task-started") {
      Z.enqueue(formatTaskStarted(item));
      continue;
    }

    // Handle prompt: run full agent turn
    abortController = new AbortController();
    for await (let event of sdkEntrypoint({
      prompt: item.value,
      promptUuid: item.uuid,
      ...,
      replayUserMessages: config.replayUserMessages,
      includePartialMessages: config.includePartialMessages,
      ...
    })) {
      let isSubagent = (event.type === "assistant" || event.type === "user") && event.parent_tool_use_id;
      let isReplay = event.type === "user" && "isReplay" in event && event.isReplay;

      // ★ isReplay messages are NOT pushed to messages array (y)
      if (!isSubagent && !isReplay && event.type !== "stream_event")
        y.push(event);

      if (event.type === "result") {
        // On result: remove task-started items from queue, re-enqueue them
        let taskStartedItems = removeByPredicate(item => item.mode === "task-started");
        for (let item of taskStartedItems) Z.enqueue(formatTaskStarted(item));
        // Check for running agents
        if (hasRunningAgents()) holdResult = event;
        else Z.enqueue(event);
      } else {
        Z.enqueue(event);
      }
    }

    // Prompt suggestion logic...
  }
};
```

### The `isReplay` Filter

Even when `replayUserMessages=true` and `SessionQuery` yields the `queued_command` as a user message with `isReplay: true`, the SDK streaming handler **filters it out** of the `y` (messages) array. However, it IS enqueued to the ReadableStream `Z`, so consumers of the stream would see it.

---

## 9. The Do-While Outer Loop

The do-while loop wraps `sdkStreamingHandler` and keeps running while there are background tasks or queue items:

```javascript
do {
  await sdkStreamingHandler();  // processes all current queue items
  shouldContinue = false;

  {
    let appState = await getAppState();
    let hasRunningTasks = getRunningAgents(appState)
      .some(agent => agent.type !== "in_process_teammate" && isRunning(agent));
    let hasQueueItems = queueNonEmpty();

    if (hasRunningTasks || hasQueueItems) {
      shouldContinue = true;
      if (!hasQueueItems) await sleep(100);  // poll every 100ms
    }
  }
} while (shouldContinue);

// After loop: emit held result, check for team polling, etc.
```

### Loop Condition

The loop continues as long as:
1. **Running background tasks exist** (excluding `in_process_teammate`) — polls every 100ms
2. **Queue is non-empty** — processes immediately

When a steer message arrives (via `queuePush`), `queueNonEmpty()` becomes true, and the next poll iteration processes it through `sdkStreamingHandler`.

**However**: if `queryGenerator` is already running (inside `sdkStreamingHandler`), the steer doesn't go through the do-while. Instead, it gets picked up by `queryGenerator`'s `snapshotQueue()` at the next sub-turn boundary. The do-while only matters for messages that arrive **after** the current agent turn completes and the queue was previously empty.

---

## 10. CLI REPL React Layer

The CLI's React (Ink) UI has several components related to queue display and editing.

### Queue Display Component (`queueDisplayComponent`)

Renders queued messages in the chat area:

```javascript
function queueDisplayComponent() {
  let queueItems = useSyncExternalStore(subscribe, getFrozenSnapshot);
  // Filter to displayable items (not task-notification or task-started)
  let displayable = queueItems.filter(item =>
    item.mode !== "task-notification" && item.mode !== "task-started");
  if (displayable.length === 0) return null;
  // Render each as a static message using the message component
  return displayable.map((item, i) =>
    <MessageComponent message={normalize(item)} isStatic={true} ... />
  );
}
```

### Placeholder Hint (`placeholderHint`)

Shows contextual hints in the input box:

```javascript
function placeholderHint({input, submitCount, viewingAgentName}) {
  let queueItems = useSyncExternalStore(subscribe, getFrozenSnapshot);
  // ...
  if (queueItems.some(item => isEditable(item.mode)) &&
      (config().queuedCommandUpHintCount || 0) < 3) {
    return "Press up to edit queued messages";
  }
  // ...
}
```

### Up Arrow Handler (`onUpArrow`)

```javascript
function onUpArrow() {
  if (multipleBuffers) return;
  if (!cursorAtTop) return;

  // ★ Queue edit: if there are editable items, pop them
  if (queueItems.some(item => isEditable(item.mode))) {
    popAllEditableToInput();  // calls popAllEditable(input, cursor)
    return;
  }

  // Otherwise: navigate to agents, history, etc.
}
```

### `popAllEditableToInput` (the edit callback)

```javascript
const popAllEditableToInput = useCallback(() => {
  let result = popAllEditable(currentInput, cursorOffset);
  if (!result) return false;
  setInput(result.text);
  setMode("prompt");
  setCursorOffset(result.cursorOffset);
  if (result.images.length > 0) {
    setPastedContents(prev => {
      let next = {...prev};
      for (let img of result.images) next[img.id] = img;
      return next;
    });
  }
  return true;
}, [setInput, setMode, currentInput, cursorOffset, setPastedContents]);
```

---

## 11. Implications for ClaudeUI

### What ClaudeUI Can See

| Event | Available? | How |
|---|---|---|
| User sends steer | Yes | ClaudeUI sends it (it controls the input) |
| Queue push succeeds | No | `queuePush` is internal to CLI process |
| Queue snapshot taken | No | `snapshotQueue()` is internal |
| Steer consumed as attachment | No | `queued_command` not yielded when `replayUserMessages=false` |
| Steer removed from queue | No | `removeConsumed` only updates internal state + SQLite |
| Model responds to steer | Yes | Normal assistant message references steer content |

### What ClaudeUI Needs (for edit/withdraw UX)

1. **Notification when steer is consumed** — to transition UI from "editable" to "sent"
2. **Dequeue capability** — to withdraw before consumption
3. **Value-based matching** — native queue items don't have UUIDs

### Patch Requirements

1. **In `SessionQuery.submitMessage`**: When a `queued_command` attachment is encountered, yield a new event type (e.g., `{type: "system", subtype: "queued_command_consumed", ...}`) regardless of `replayUserMessages`. This gives ClaudeUI the notification.

2. **In control-request handler**: A `dequeue_message` subtype that matches by value (not UUID), mirroring the native `popAllEditable` behavior. This only works before `snapshotQueue()` — same race window as pressing UP in the CLI.

3. **Drop `queue_message`**: The native steer mechanism (user types → `queuePush`) already handles injection. No need to duplicate it.

---

## Appendix A: Minified Name Mapping (SDK 0.2.50)

### Queue Module

| Pseudoname | Minified | Char Offset | Description |
|---|---|---|---|
| `queueArray` | `L$` | — (module-level var) | The live queue array |
| `frozenSnapshot` | `i24` | — (module-level var) | `Object.freeze([...L$])` for UI reads |
| `subscriberSet` | `Tf8` | — (module-level var) | `Set` of subscriber callbacks |
| `priorityMap` | `l24` | — (module-level var) | `{now:0, next:1, later:2}` |
| `NON_EDITABLE_MODES` | `$a9` | 5750331 | `new Set(["task-notification","task-started"])` |
| `notifySubscribers` | `q56` | ~5748250 | Updates `i24`, calls all in `Tf8` |
| `subscribe` | `ID1` | ~5748375 | Adds to `Tf8`, returns unsubscribe |
| `getFrozenSnapshot` | `bD1` | 5748393 | Returns `i24` |
| `snapshotQueue` | `xD1` | 5748393 | Returns `[...L$]` |
| `queueLength` | `n24` | ~5748420 | Returns `L$.length` |
| `queueNonEmpty` | `Fd` | ~5748440 | Returns `L$.length > 0` |
| `queuePush` | `jk` | 5748496 | Push with `priority: "next"` |
| `queuePushLater` | `kB` | ~5748600 | Push with `priority: "later"` |
| `dequeueOne` | `uD1` | ~5748700 | Remove highest-priority item |
| `removeConsumed` | `r24` | 5748937 | Remove by `.value` match |
| `removeByPredicate` | `fP6` | 5749128 | Remove where predicate returns true |
| `clearAll` | `_a9` | ~5749340 | `L$.length = 0; q56()` |
| `isEditable` | `mD1` | 5749341 | `!$a9.has(mode)` |
| `extractQueueText` | `Ha9` | 5749375 | Extract text from value |
| `popAllEditable` | `BD1` | 5749742 | Pop editable items → input text |
| `logQueueOp` | `GP6` | 5748101 | Write to SQLite |
| `recordQueueOperation` | `Vf8` | 10436815 | SQLite insert |

### Query / Session Layer

| Pseudoname | Minified | Char Offset | Description |
|---|---|---|---|
| `queryGenerator` | `Ly` | 10157028 | Main `async function*` sub-turn loop |
| `apiStreaming` | `VZ6` | 10124968 | API call + streaming |
| `stopHookHandler` | `v_q` | 10153546 | Pre/post stop hooks |
| `attachmentGenerator` | `BZ6` | 7172176 | `async function*` yields attachments |
| `buildAttachments` | `QPY` | 7160021 | Collects all attachment sources |
| `queueItemsToAttachments` | `UPY` | 7162011 | Converts queue items → `queued_command` |
| `normalizeAttachment` | `Yg8` | 10404261 | Converts attachment → API messages |
| `SessionQuery` class | `rWq` | 11055891 | SDK session wrapper |
| `submitMessage` | `vHq` | 10290500 (method) | `for await(queryGenerator) yield` |
| `sdkEntrypoint` | `aWq` | 11065694 | `yield* new SessionQuery(...).submitMessage()` |
| `yieldHelper` | `xT8` | 5971183 | Normalizes and yields SDK events |

### SDK Streaming Handler

| Pseudoname | Minified | Char Offset | Description |
|---|---|---|---|
| `sdkStreamingHandler` | `h6` | 11083275 | `async () =>` dequeues + runs turns |
| `ReadableStreamController` | `Z` | — (closure var) | `Z.enqueue(event)` sends to consumer |
| `messagesArray` | `y` | — (closure var) | Accumulated messages (excludes `isReplay`) |
| `resultHolder` | `P` | — (closure var) | Holds result when running agents exist |

### CLI REPL (React/Ink)

| Pseudoname | Minified | Char Offset | Description |
|---|---|---|---|
| `replComponent` | `KgY` | 8748492 | Main React component |
| `onQuery` | (inline) | ~11515500 | `for await(Ly(...)) b8(msg)` |
| `processMessage` | `GT6` | 10391044 | Stream event handler |
| `messageHandler` | `b8` | ~11514504 | `useCallback` wrapping `GT6` |
| `queueDisplayComponent` | `iVq` | ~11367605 | Renders queued messages |
| `placeholderHint` | `FVq` | ~11365212 | Input placeholder text |
| `inputComponent` | `Ed8` | 11420480 | Main input box component |
| `onUpArrow` | `d5` | ~11385880 | Up arrow key handler |
| `popAllEditableToInput` | `cz` | ~11389349 | Callback: `BD1(input, cursor)` |

### Helpers

| Pseudoname | Minified | Description |
|---|---|---|
| `createUserMessage` | `t1` | Creates a user message object |
| `wrapAttachment` | `Vq` | Wraps raw attachment into `{type:"attachment", attachment}` |
| `normalizeToMessages` | `Z9` | Normalizes content blocks to message format |
| `getSessionId` | `Q1` | Returns current session ID |
| `generateUUID` | `Y16` / `BP` | UUID generators |
| `flattenMessages` | `fH` | Flattens nested message structures |
| `isValidMessage` | `Et` | Checks if message should be yielded |
| `lastElement` | `wW` | Returns last element of array |
| `hasToolUse` | `s_4` | Checks if last message has tool_use content |

---

## Appendix B: Bundle Analyzer Commands

Quick reference for finding the key functions in future SDK versions:

```bash
# Queue module — search by string literals
bundle-analyzer find cli.js "queue-operation"           # → logQueueOp (GP6)
bundle-analyzer find cli.js "task-notification"         # → NON_EDITABLE_MODES ($a9)
bundle-analyzer find cli.js "Press up to edit"          # → placeholderHint (FVq)
bundle-analyzer find cli.js "popAll"                    # → popAllEditable (BD1)

# Steer injection text
bundle-analyzer find cli.js "new message while"         # → normalizeAttachment/queued_command case (Yg8)

# Queue → attachment conversion
bundle-analyzer find cli.js "queued_command"             # → queueItemsToAttachments (UPY) + others

# Sub-turn loop — find by attachment loading markers
bundle-analyzer find cli.js "query_attachment_loading_start"  # → inside queryGenerator (Ly)
bundle-analyzer find cli.js "query_recursive_call"            # → loop restart in queryGenerator

# SDK session class
bundle-analyzer find cli.js "replayUserMessages"        # → SessionQuery config (rWq/vHq)
bundle-analyzer find cli.js "isReplay"                   # → submitMessage + sdkStreamingHandler

# Do-while outer loop
bundle-analyzer find cli.js "team-dowhile-fix"           # → patched do-while (has our marker)

# API streaming
bundle-analyzer find cli.js "query_api_streaming_start"  # → inside queryGenerator
bundle-analyzer find cli.js "query_api_loop_start"       # → retry loop wrapper

# Control request handler
bundle-analyzer find cli.js "Unsupported control request subtype"  # → injection point for patches
```

### Version Diff Workflow

When the SDK updates:

```bash
# 1. Compare function changes
bundle-analyzer diff-fns old-cli.js new-cli.js --summary

# 2. Find moved queue functions
bundle-analyzer diff-fns old-cli.js new-cli.js --filter "queue"

# 3. Check specific function changes
bundle-analyzer diff-fns old-cli.js new-cli.js --body --name "Ly"

# 4. String diff for new features
bundle-analyzer strings --diff old-cli.js new-cli.js
```
