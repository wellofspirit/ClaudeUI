# Patch: incomplete-session-resume-fix

## The Bug

When resuming a session from its JSONL file, the SDK loads messages and rebuilds the conversation by walking the `parentUuid` chain from the most recent message (leaf) back to the root. If **any message in that chain is missing from the loaded map**, the chain breaks and all messages before the gap are lost.

The SDK intentionally filters out certain progress message types during JSONL loading — specifically `bash_progress`, `powershell_progress`, and `mcp_progress`. These are transient streaming output (e.g., bash command progress bars) that aren't needed for conversation replay. However, the filter removes them from the messages Map without fixing `parentUuid` references from subsequent messages.

### Impact

A single filtered progress message anywhere in a conversation permanently breaks the resume chain at that point. On a 9000+ message session, this can reduce the loaded context to just ~60 messages — everything after the last filtered progress message. The model loses all earlier conversation history.

### Reproduction

1. Have a session where Claude ran a bash command that produced streaming progress output (e.g., file conversion with progress bars)
2. The SDK writes a `progress` entry with `data.type: "bash_progress"` to the JSONL
3. Resume the session with `--resume <session-id>`
4. Only messages after the last `bash_progress` entry are loaded

## Root Cause Analysis

### The JSONL message chain

Each message in the JSONL has a `uuid` and `parentUuid`, forming a linked list:

```
[user: uuid=AAA, parentUuid=null]
  → [assistant: uuid=BBB, parentUuid=AAA]
    → [progress: uuid=CCC (bash_progress), parentUuid=BBB]
      → [user: uuid=DDD, parentUuid=CCC]
        → [assistant: uuid=EEE, parentUuid=DDD]
          → ...
```

### The filter in `u_6()` (JSONL parser)

In the function `u_6` (async, takes a file path), messages are parsed and added to a Map:

```js
for (let R of h)
  if (Wl(R)) {  // accepts: user, assistant, attachment, system, progress
    if (R.type === "progress" && R.data && typeof R.data === "object"
        && "type" in R.data && er6(R.data.type))
      continue;  // ← SKIPS the message, UUID never enters the Map
    // ...
    q.set(R.uuid, R);
  }
```

The `er6()` function checks against a Set called `Qzz`:
```js
Qzz = new Set(["bash_progress", "powershell_progress", "mcp_progress", ...[]]);
```

After filtering, message CCC is gone from the map. Message DDD still has `parentUuid: CCC`.

### The chain walker `Ao6()`

```js
function Ao6(A, q) {  // A = messages Map, q = leaf message
  let K = [], Y = new Set(), z = q;
  while (z) {
    if (Y.has(z.uuid)) { /* cycle */ break; }
    Y.add(z.uuid);
    K.push(z);
    z = z.parentUuid ? A.get(z.parentUuid) : void 0;  // ← undefined if parent filtered!
  }
  return K.reverse();
}
```

When it reaches DDD and tries `A.get("CCC")`, it gets `undefined` → loop ends → chain has only messages from DDD onward.

## The Fix

**Strategy**: When a progress message is filtered, record its `uuid → parentUuid` mapping. After all messages are loaded, walk each message's `parentUuid` through this redirect map to skip over filtered messages.

### Before (conceptual)

```
AAA → BBB → [CCC filtered] → DDD → EEE
                                ↑ parentUuid=CCC (broken!)
```

### After (with redirect)

```
redirect map: { CCC → BBB }

DDD.parentUuid: CCC → look up in redirect → BBB
Result: AAA → BBB → DDD → EEE (chain intact)
```

### Multiple consecutive filtered messages

If several progress messages appear in a row:
```
AAA → [BBB filtered] → [CCC filtered] → DDD
redirect map: { BBB → AAA, CCC → BBB }
```
The fixup loop follows the chain: `DDD.parentUuid = CCC → BBB → AAA` (stops when target is not in redirect map).

### Part A: Capture redirect map

**Location**: Inside `u_6()`, the progress filter line.

**Find** (unique string):
```
&&er6(R.data.type))continue;
```

**Replace with**:
```js
&&er6(R.data.type)){
  /*PATCHED:incomplete-session-resume-fix*/
  if (R.uuid && R.parentUuid) {
    if (!_pcf_redir) var _pcf_redir = new Map();
    _pcf_redir.set(R.uuid, R.parentUuid);
  }
  continue
}
```

Uses `var` for hoisting so the variable is accessible after the loop without needing to declare it outside.

### Part B: Apply redirects

**Location**: Right before `ozz(q);` in `u_6()` (after the message loading loop).

**Inject before `ozz(q);`**:
```js
if (typeof _pcf_redir !== "undefined" && _pcf_redir.size > 0) {
  for (let [, _m] of q) {
    if (_m.parentUuid && _pcf_redir.has(_m.parentUuid)) {
      let _pu = _m.parentUuid;
      let _seen = new Set();
      while (_pu && _pcf_redir.has(_pu) && !_seen.has(_pu)) {
        _seen.add(_pu);
        _pu = _pcf_redir.get(_pu);
      }
      _m.parentUuid = _pu;
    }
  }
}
```

The `_seen` Set prevents infinite loops in case of circular references in the redirect map (shouldn't happen, but defensive).

## How to find the code with bundle-analyzer

```bash
# 1. Find the progress filter in u_6
bundle-analyzer find cli.js "er6(R.data.type))continue" --compact

# 2. Find er6 definition
bundle-analyzer find cli.js "function er6" --compact

# 3. Find the filtered progress type set (Qzz)
bundle-analyzer find cli.js "bash_progress" --compact

# 4. Find ozz(q) call site (fixup injection point)
bundle-analyzer find cli.js "ozz(q);" --compact

# 5. Find Ao6 — the chain walker that breaks
bundle-analyzer find cli.js "function Ao6" --compact

# 6. Find u_6 — the JSONL parser
bundle-analyzer find cli.js "function u_6" --compact

# 7. Find Wl — the message type filter
bundle-analyzer find cli.js "function Wl" --compact
```

## Stable anchors for future versions

| Anchor | Why it's stable |
|--------|----------------|
| `er6(R.data.type))continue` | The filter-and-skip pattern for progress messages |
| `Qzz = new Set(["bash_progress"` | The set of filtered progress types |
| `ozz(q);` | The compact boundary cleanup call in u_6, right after the loading loop |
| `function Ao6(A, q)` | The parentUuid chain walker |
| `function u_6(A)` | The JSONL parser function |

## Testing

1. Find a session with `bash_progress` entries in its JSONL:
   ```bash
   grep -l "bash_progress" ~/.claude/projects/*/sessions/*.jsonl
   ```

2. Resume the session and check how many messages load:
   ```bash
   # Add debug log before Ao6 in Hl6:
   # console.error('[DEBUG] chain length:', M.length)
   ```

3. Without patch: chain length will be small (e.g., 60)
4. With patch: chain length should match total messages in JSONL

## Verification

After applying the patch, verify:
```bash
grep "PATCHED:incomplete-session-resume-fix" node_modules/@anthropic-ai/claude-agent-sdk/cli.js
# Should output 1 match
```
