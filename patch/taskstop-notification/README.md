# Patch: taskstop-notification

Fixes TaskStop to properly notify SDK consumers when tasks are stopped.

## The Problem

When a background task is stopped via TaskStop, the SDK consumer never receives a notification, and even if it did, the status would be wrong:

1. **No notification sent** — TaskStop kills the task and sets `notified:true`, but never calls the notification sender. The task appears stuck in "running" state.
2. **~~"killed" status rejected~~** — *(Fixed upstream in SDK 0.2.49)* The CLI uses `"killed"` internally, but the XML parser's validator only accepts `completed|failed|stopped`. Unknown statuses default to `"completed"`, so stopped tasks would show as completed.

## The Fix

### Part A: killed → stopped mapping (upstreamed in SDK 0.2.49)

> **This part is no longer needed on SDK 0.2.49+.** The CLI now natively
> accepts `"killed"` in the validator and maps it to `"stopped"`. The patch
> script detects this and skips Part A automatically.

Extends the status validator to accept `"killed"` and maps it to the schema-compliant `"stopped"`:

```js
// Before:
y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped",
G1=y1(x1)?x1:"completed";

// After:
y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped"||R1==="killed",
G1=y1(x1)?(x1==="killed"?"stopped":x1):"completed";
```

### Part B: Inject notification call

Inserts a call to the notification sender (e.g. `kxY()`) before the `notified:true` flag is set:

```js
// Before:
await _.kill(A,{...}),z((O)=>{...notified:!0...});

// After:
await _.kill(A,{...}),NOTIFY(A,$.description||$.command||"","killed",z,void 0),z((O)=>{...notified:!0...});
```

The notification sender signature is `NOTIFY(taskId, description, status, setState, toolUseId)`:
- `setState` (4th param) is required — it calls `Xw(taskId, setState, cb)` internally
  to set `notified:true` and gate against duplicate notifications
- `toolUseId` (5th param) is optional — used for `<tool-use-id>` in the XML output;
  TaskStop doesn't have it available, so we pass `void 0`
- `description` uses `$.description||$.command||""` to handle both `local_agent`
  (has `.description`) and `local_bash` (has `.command`) task types

## How It Finds the Code

All identifiers are extracted dynamically by content patterns:

| What | Pattern |
|---|---|
| Status validator | `(S)=>S==="completed"\|\|S==="failed"\|\|S==="stopped"` followed by `?.[1]` extraction and ternary default |
| Notification sender | `function NAME(A,q,K,Y,z){...K==="completed"?...:K==="failed"?...:"was stopped"}` |
| TaskStop location | Unique string `"Successfully stopped task:"` |
| Notified setter | `SET_STATE((S)=>{let T=S.tasks[ID];if(!T\|\|T.notified)return S;...notified:!0...})` |
| Task object var | `VAR=(await ...).tasks?.[TASK_ID]` |

## Verification

1. Start a background task (e.g., `sleep 30`)
2. Stop it via TaskStop
3. UI should show orange "stopped" badge (not green "completed")
