# Task Stop Direct Execution Patch

Adds a control_request handler for "stop_task" that directly invokes the TaskStop tool without going through the model.

## Affected Component

**Package**: `@anthropic-ai/claude-agent-sdk`
**Version discovered**: 2.1.39
**File**: `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`

## The Problem

The SDK doesn't provide a programmatic API to invoke tools directly. The standard approach would be to send a synthetic user message asking the model to invoke TaskStop, but this:

1. **Has latency**: Round-trip through the model takes 500-2000ms
2. **Is indirect**: Relies on model interpretation, not guaranteed
3. **Is inefficient**: Uses API quota for a simple control operation

For user-initiated stop actions, we need instant, guaranteed execution.

## The Solution

Patch the SDK's control_request handler to recognize a new "stop_task" subtype that directly invokes the TaskStop tool with <10ms latency.

## Critical Discovery: Variable Scoping in the SDK

### The Challenge

The control_request handler runs inside an async IIFE within the `for await(let W1 of A.structuredInput)` loop. This loop is itself inside a larger async IIFE that's part of the DXz function:

```javascript
function DXz(E,L,g,d,z1,Z1,a1,I6,FA,R8,J9) {
  // ... setup code ...
  return (async()=>{
    for await(let W1 of A.structuredInput){
      if(W1.type==="control_request"){
        // OUR PATCH GOES HERE
      }
    }
  })()
}
```

**The Scoping Problem:**
- DXz receives tools as its 4th parameter (`d`)
- But the control_request handler is inside a nested async IIFE
- DXz parameters are NOT accessible from this nested scope
- Attempting to access `d`, `a1`, `FA`, etc. results in `undefined`

### Variables Actually in Scope

Through trial and error, we discovered these variables ARE accessible in the control_request handler:

| Variable | Purpose | Source |
|---|---|---|
| `W1` | The control_request message | Loop variable |
| `$` | getAppState function | Closure from parent |
| `O` | setAppState function | Closure from parent |
| `M` | abortController | Closure from parent |
| `J1` | Success response function | Defined before IIFE |
| `T1` | Error response function | Defined before IIFE |
| `P` | Message queue (nU1) | Closure from parent |
| `S` | SDK resources object | Defined in DXz body |
| `BW6` | **TaskStop tool object** | **Module-level variable!** |

### The Breakthrough: Direct Tool Access

**Key Discovery**: TaskStop is defined as a module-level variable `BW6` and is accessible from anywhere in the SDK, including our handler!

```javascript
// In the SDK at the module level (around line 2295):
var BW6 = {
  name: i01,  // i01 = "TaskStop"
  aliases: ["KillShell"],
  maxResultSizeChars: 1e5,
  // ... all tool methods including call() ...
}
```

This eliminates the need to:
- Search tools arrays
- Access DXz parameters
- Call getAppState to find tools (appState.tools and appState.mcp.tools are empty anyway)

## The Implementation

### Injection Point

After the "mcp_toggle" handler, before the `continue` statement:

```javascript
else if(W1.request.subtype==="mcp_toggle"){
  // ... mcp_toggle logic ...
}
/*PATCHED:task-stop-direct*/else if(W1.request.subtype==="stop_task"){
  let taskId=W1.request.task_id;
  if(!taskId){T1(W1,"task_id is required");continue}
  try{
    await BW6.call({task_id:taskId},{getAppState:$,setAppState:O,abortController:M},null);
    J1(W1,{success:true})
  }catch(err){
    T1(W1,err instanceof Error?err.message:String(err))
  }
}
continue
```

### Why This Works

1. **`BW6`** - TaskStop tool object, accessible as module-level variable
2. **`$`** - getAppState function (dollar sign character, not a variable placeholder)
3. **`O`** - setAppState function (closure variable)
4. **`M`** - abortController (closure variable)
5. **`J1(W1, data)`** - Enqueues success control_response
6. **`T1(W1, error)`** - Enqueues error control_response

## Variable Extraction Strategy

The patch script uses these patterns to find the correct variable names:

### 1. Response Functions (J1/T1)

```javascript
// Find success function - looks for pattern before mcp_toggle
const successPattern = /\),([\w$]+)\(W1\)/;  // Matches: )),J1(W1)

// Find error function
const errorPattern = /if\(!\\$1\)([\w$]+)\(W1,/;  // Matches: if(!$1)T1(W1,
```

### 2. Context Functions ($, O, M)

These are hardcoded as they're consistently named across SDK versions:
- `$` - Always the getAppState function
- `O` - Always the setAppState function
- `M` - Always the abortController

### 3. TaskStop Tool (BW6)

Directly referenced as `BW6` - this is a stable module-level variable name.

## How the Code Was Found

### 1. Locate the control_request Handler

```bash
bundle-analyzer find cli.js "control_request"
```

Found at offset 10829303: `if(W1.type==="control_request")`

### 2. Find the Injection Point

Search for mcp_toggle (last handler before continue):

```bash
bundle-analyzer find cli.js "mcp_toggle"
```

The pattern to match:
```javascript
else if(W1.request.subtype==="mcp_toggle"){
  // ... handler code ending with T1(W1, error) ...
}
}
}
}  // Three closing braces
continue  // <- Inject BEFORE this
```

### 3. Discover Variable Scoping

**What DOESN'T Work:**
- ❌ Extracting tools from DXz parameters (not accessible)
- ❌ Using `appState.tools` (always empty)
- ❌ Using `appState.mcp.tools` (only has MCP tools, which are also empty initially)
- ❌ Trying to access `d`, `a1`, `FA` from DXz parameters

**What DOES Work:**
- ✅ Direct reference to `BW6` (module-level TaskStop object)
- ✅ Using `$()` for getAppState
- ✅ Using `O` for setAppState
- ✅ Using `M` for abortController

### 4. Find TaskStop Tool Object

```bash
grep -n "name:i01" cli.js
```

Found at line 2295: `BW6={name:i01,...}`

Verified it's accessible:
```javascript
console.error("[TEST] BW6 defined?", typeof BW6 !== "undefined");
// Output: true
```

## Applying the Patch

```bash
node patch/task-stop-direct/apply.mjs
```

The script:
1. Checks for `/*PATCHED:task-stop-direct*/` marker (idempotent)
2. Finds the injection point after mcp_toggle
3. Extracts J1/T1 function names dynamically
4. Injects the stop_task handler with hardcoded context variables
5. Verifies the patch was applied

## Debugging Tips for Future SDK Updates

If the patch breaks in a new SDK version:

### 1. Verify BW6 Still Exists

```bash
grep -n "TaskStop" cli.js | head -10
```

Look for the tool object assignment (currently `BW6`).

### 2. Check Variable Names

The key variables to verify:
- `$` - getAppState (look in mcp_status handler: `let q1=await $()`)
- `O` - setAppState (look for `O((state)=>({...state...}))`)
- `M` - abortController (look in interrupt handler: `if(M)M.abort()`)
- `J1`/`T1` - Response functions (defined right before the structuredInput loop)

### 3. Test Variable Accessibility

Add this debug code to the handler:
```javascript
console.error("[DEBUG] BW6?", typeof BW6 !== "undefined");
console.error("[DEBUG] $?", typeof $ !== "undefined");
console.error("[DEBUG] O?", typeof O !== "undefined");
console.error("[DEBUG] M?", typeof M !== "undefined");
```

### 4. Verify Control Flow

Add logging at key points:
```javascript
console.error("[DEBUG] Handler invoked, taskId:", taskId);
// ... before BW6.call
console.error("[DEBUG] Calling BW6...");
// ... after BW6.call
console.error("[DEBUG] BW6 completed");
```

## Integration with ClaudeUI

### Sending stop_task Request

```typescript
// In ClaudeSession.stopTask()
const stopMessage = {
  type: 'control_request' as const,
  request: {
    subtype: 'stop_task',
    task_id: taskId
  },
  request_id: uuid()
}
this.messageChannel.push(stopMessage)
```

### Receiving control_response

```typescript
// In ClaudeSession.run() message loop
if (type === 'control_response') {
  const response = msg.response as Record<string, unknown>
  if (response.subtype === 'error') {
    console.error('[Error]', response.error)
  } else if (response.subtype === 'success') {
    console.log('[Success]', response.response)
  }
}
```

## Control Response Behavior

### Why control_response Isn't Visible to Consumers

**Investigation Result**: Control responses ARE generated and enqueued correctly, but are intentionally filtered by the SDK.

**The Flow:**
1. ✅ stop_task control_request is sent through structuredInput
2. ✅ Handler invokes BW6.call() (TaskStop)
3. ✅ J1()/T1() enqueue control_response to P (nU1 queue)
4. ✅ P yields the control_response through its async iterator
5. ❌ SDK's query() consumer filters it out

**The Filter (in SDK query function):**
```javascript
for await(let T of DXz(...)){
  // Control responses are explicitly excluded from results
  if(T.type!=="control_response" &&
     T.type!=="control_request" && ...)
    f.push(T)
}
```

**Why This Is OK:**

Control_response messages are internal SDK protocol messages not meant for SDK consumers. Instead, consumers observe the **side effects**:

1. **TaskStop executes** - The task is actually terminated
2. **task_notification arrives** - When the task stops, the SDK sends a `type:"system", subtype:"task_notification"` message with `status:"stopped"`, which IS visible to consumers
3. **ClaudeUI already handles** task_notification messages

So we don't need to see the control_response - we just need TaskStop to execute (which it does), and then wait for the task_notification (which already works).

## Benefits

- **Instant execution**: <10ms vs 500-2000ms model round-trip
- **Guaranteed**: Direct tool invocation, not model-dependent
- **Clean separation**: User control actions separate from agent decisions
- **Consistent cleanup**: Uses same TaskStop tool with proper state management
- **Simple implementation**: Single direct function call, no array searching

## Testing

### Unit Test (test-stop-task.mjs)

```bash
node test-stop-task.mjs
```

Expected output:
```
[Test] Starting SDK session...
[Test] Session ID: ...
[Test] Sending stop_task control_request...
[SDK stderr] [SDK] TaskStop error: No task found with ID: fake-task-123
```

### Integration Test (ClaudeUI)

1. Start a background Task or Bash command
2. Click stop button (sends control_request)
3. Check logs for `[SDK] TaskStop completed successfully`
4. Verify task terminates
5. Check for task_notification with status "stopped"

## Future Improvements

1. **Fix control_response yielding** - Make responses visible to SDK consumers
2. **Add response handling** - Process success/error in ClaudeUI
3. **Support batch stops** - Stop multiple tasks in one request
4. **Add stop confirmation** - Optional user confirmation before stopping critical tasks
