# Patch: queue-control

Adds control-request subtypes for managing the CLI's output queue mid-agent-turn.

## The Problem

When the user types a message while the agent is running, the SDK has no way to inject it between sub-turns. The current workaround holds the message in the renderer and sends it after `running → idle`, which means it waits for the **entire agent turn** (the do-while loop) to end — including all background task polling.

The CLI's internal architecture actually supports mid-turn message injection: the loop dequeues from the queue array between sub-turn calls, and the do-while polls every 100ms. But there's no control-request API to push to or remove from the queue.

## The Fix

Two new control-request subtypes in the CLI's message loop:

### `queue_message`

Push a user prompt into the output queue via the queue-push function, then kick the turn-loop starter so the do-while loop picks it up.

```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "queue_message",
    "value": "Fix the auth bug too",
    "uuid": "msg-123"
  }
}
```

Response: `{ "queued": true }`

The message gets processed at the next sub-turn gap — between sub-turn calls within the same agent turn. No need to wait for idle.

### `dequeue_message`

Remove a queued message by uuid before it's been processed. Allows the user to edit or cancel a queued message.

```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "dequeue_message",
    "uuid": "msg-123"
  }
}
```

Response: `{ "removed": 1 }` (number of items removed, 0 if already processed)

## How It Finds the Code (Pattern Matching)

All minified function names are extracted **dynamically** from content patterns — no hardcoded names. This makes the patch resilient to SDK version bumps where minified identifiers change.

| What | Stable Anchor / Pattern |
|---|---|
| Injection point | `else <fn>(c,\`Unsupported control request subtype: ...\`);continue}else if(c.type==="control_response")` — regex captures the error helper name |
| Success response helper | `),<fn>(c,{})}}catch` — found in the stop_task handler near the anchor |
| Queue push + loop starter | `<fn>({mode:"prompt",value:<v>.message.content,uuid:<v>.uuid}),<fn>()` — the user-message handler near the anchor |
| Queue remove-by-predicate | `function <fn>(<v>){let <v>=[];for(let <v>=<queue>.length-1` — found near the queue push function definition |
| Queue array | Captured from the push function definition: `function <pushFn>(<v>){<queue>.push(` |
| sdk.mjs stopTask | `async stopTask(<v>){await this.request({subtype:"stop_task",task_id:<v>})}` — regex with backreference |

### Name mapping across versions

| Role | 0.2.49 | 0.2.50 |
|---|---|---|
| Queue push | `Jk` | `jk` |
| Queue remove | `KP6` | `fP6` |
| Queue array | `VH` | `L$` |
| Queue non-empty | `Id` | `Fd` |
| Turn loop starter | `G6` | `G6` |
| Success response | `t` | `e` |
| Error response | `o` | `o` |

## How the CLI Queue Works

```
Agent turn (do-while loop)
├── sub-turn #1: user prompt → model → tool calls → result
│   ← 100ms poll gap — queue_message arrives here → queue
├── sub-turn #2: queued message → model → result
│   ← 100ms poll gap
├── sub-turn #3: background task notification → model → result
└── no running tasks, queue empty → do-while exits → idle
```

The do-while loop keeps running as long as there are background tasks or queue items. Between sub-turn calls, items are dequeued from the queue — our `queue_message` items land right there.

## Verification

1. Start a session with a background task running
2. Send a `queue_message` control request
3. Observe the message is processed between sub-turns (not after idle)
4. Send a `queue_message`, then immediately `dequeue_message` with the same uuid
5. The message should be removed (response: `{removed: 1}`) and never processed
