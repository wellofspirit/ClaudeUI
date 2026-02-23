# Patch: queue-control

Adds control-request subtypes for managing the CLI's output queue mid-agent-turn.

## The Problem

When the user types a message while the agent is running, the SDK has no way to inject it between sub-turns (`pPq` calls). The current workaround holds the message in the renderer and sends it after `running → idle`, which means it waits for the **entire agent turn** (the do-while loop) to end — including all background task polling.

The CLI's internal architecture actually supports mid-turn message injection: the `R6` loop dequeues from `VH` between `pPq` calls, and the do-while polls every 100ms. But there's no control-request API to push to or remove from the queue.

## The Fix

Two new control-request subtypes in the CLI's message loop:

### `queue_message`

Push a user prompt into the output queue (`VH`) via `Jk()`, then kick `G6()` so the do-while loop picks it up.

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

The message gets processed at the next sub-turn gap — between `pPq` calls within the same agent turn. No need to wait for idle.

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

## How It Finds the Code

| What | Pattern |
|---|---|
| Injection point | `else o(c,\`Unsupported control request subtype: ...\`)` — the fallback at the end of the control-request handler chain |
| `Jk` (queue push) | `function Jk(A){VH.push(...)` — module-level |
| `KP6` (queue remove) | `function KP6(A){...VH...splice...}` — module-level |
| `G6` (turn loop) | Local async function in the same closure, verified by nearby `G6()` calls |
| `t`/`o` (response helpers) | Local functions, verified by `t(c,{` and `o(c,` usage in stop_task handler |

## How the CLI Queue Works

```
Agent turn (do-while loop = G6)
├── pPq #1: user prompt → model → tool calls → result
│   ← 100ms poll gap — queue_message arrives here → VH
├── pPq #2: queued message → model → result
│   ← 100ms poll gap
├── pPq #3: background task notification → model → result
└── no running tasks, queue empty → do-while exits → idle
```

The do-while loop keeps running as long as there are background tasks (`vf(task)`) or queue items (`Id()`). Between `pPq` calls, `R6` dequeues from `VH` via `HD1()` — our `queue_message` items land right there.

## Verification

1. Start a session with a background task running
2. Send a `queue_message` control request
3. Observe the message is processed between sub-turns (not after idle)
4. Send a `queue_message`, then immediately `dequeue_message` with the same uuid
5. The message should be removed (response: `{removed: 1}`) and never processed
