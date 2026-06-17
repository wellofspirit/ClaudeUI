# Codex: First-Class Session Redesign & Parity Follow-ups

> **Audience:** a fresh session picking this up. Branch `codex-sup`.
> Written after the **Tier 0+1 parity quick-wins** landed and live testing
> surfaced three things that need *design*, not patching. All protocol facts
> below were verified against the pinned schema in `src/main/codex/protocol/`.

---

## 0. What already landed (Tier 0+1 quick-wins)

Committed alongside this doc. typecheck clean; full suite (3144 tests) green.
Reviewed at the source.

| # | Item | Behavior | Key files |
| --- | --- | --- | --- |
| ① | **Fork** | "Fork" on a Codex session calls native `thread/fork` instead of erroring. **Whole-thread only today** — see Issue 2 for per-message. | `CodexSession.spawnAndHandshake`, `session-store.forkFromMessage`, `MessageBubble` |
| ② | **Plan checklist** | `turn/plan/updated` → new `session:plan` event → existing Todo widget (snapshot; `inProgress→in_progress`). | `mapCodexEvent.mapPlanUpdated`, `CodexSession`, `types`, `preload`, `useClaudeEvents`, `web/api-adapter` |
| ③ | **Server-requests** | `item/permissions/requestApproval` surfaced as an approval (Allow→`turn`, Allow-for-session→`session`, Deny→`{}`); `mcpServer/elicitation/request` safe-declines. No more `methodNotFound` wedges. | `CodexSession.wireServerRequestHandlers` |
| ④ | **Sidebar actions** | pin/hide already worked (sessionId-keyed); delete + watch wired for Codex via rollout-path resolver + watcher + provider-aware `deleteSession` store action. | `codexSessions.{resolveCodexRolloutPath,deleteCodexSession}`, `codex-watcher.ts`, `session.ipc`, `remote-handlers`, `preload`, `Sidebar` |
| ⑤ | **acceptForSession** | "Allow for session" button (Codex-only) → `acceptForSession` for command/file approvals. Claude coerces it to `allow`. | `types.ApprovalDecision`, `CodexSession.resolveApproval`, `FloatingApproval`, `claude-session` |

Refactor note: `resolveApproval` now passes the **raw** UI decision through; each
server-request handler maps it to its own Codex response shape
(`mapToCodexCommandDecision` for command/file; permissions builds `{permissions, scope}`).

---

## 1. Issue — Permission-mode / approval-policy mapping is wrong

**Symptom (live):**
```
[codex] ERROR codex_core::tools::router: approval policy is UnlessTrusted;
reject command — you cannot ask for escalated permissions if the approval
policy is UnlessTrusted
```

**Root cause.** Codex has **two orthogonal axes**, we collapsed them into Claude's single "permission mode":

- `V2AskForApproval` = `untrusted | on-failure | on-request | never`
- `V2SandboxMode`    = `read-only | workspace-write | danger-full-access`
  (turn-level `V2SandboxPolicy` adds `readOnly{networkAccess?}`, `workspaceWrite{…}`,
  `dangerFullAccess`, `externalSandbox{networkAccess?}`)

Current mapping (`CodexSession.ts` `toApprovalPolicy` / `toSandboxMode` / `toSandboxPolicy`):

| ClaudeUI mode | approvalPolicy | sandbox |
| --- | --- | --- |
| `default` / `plan` | `untrusted` | `read-only` |
| `acceptEdits` / `auto` | `on-request` | `workspace-write` |
| `bypassPermissions` | `never` | `danger-full-access` |

Under **`untrusted`**, Codex's router *rejects* escalated-permission requests outright
instead of prompting — so a "default" Codex session is effectively read-only and errors
the moment the model wants to write/escalate. `on-request` is the policy under which the
model can *ask* (and under which the `item/permissions/requestApproval` handler we added
actually fires). We also render Claude's mode picker
(`SessionView.tsx` `PERMISSION_MODES = ['default','acceptEdits','plan','auto']`) verbatim
for Codex; `plan` is meaningless to Codex and the rest map by accident.

**Fix — two levels:**
- **Now (unblocks):** remap so Codex `default = on-request + workspace-write` (codex's own
  default), `plan = read-only` (+ `on-request` or `never`), `acceptEdits/auto =
  on-failure`/`on-request` + `workspace-write`, `bypass = never + danger-full-access`.
  Verify the chosen `default` against `codex`'s own CLI default before locking it in.
- **Better (parity):** a **provider-aware control** that exposes Codex's real axes
  (approval policy × sandbox) instead of pretending it's Claude's single mode. Likely a
  4-level autonomy scale (Read-only / Ask / Auto / Full) with correct semantics per level.

**Files:** `src/main/codex/CodexSession.ts` (`toApprovalPolicy`, `toSandboxMode`,
`toSandboxPolicy`, `setPermissionMode`, `run` → `turn/start`);
`src/renderer/src/components/SessionView.tsx` (`PERMISSION_MODES`) + the mode picker in
`InlinePickers.tsx`.

---

## 2. Issue — Fork is whole-thread; per-message fork IS achievable

Earlier belief ("Codex only does whole-thread fork") was **wrong**. `thread/fork` alone
copies the whole thread (no cursor param — `threadSource` is just a provenance tag), **but**
the protocol also has:

```
thread/rollback { threadId: string, numTurns: number } -> { thread }
```

So **per-message fork = `thread/fork` (copy) then `thread/rollback(totalTurns − targetTurn)`**
to trim the trailing turns. It is **turn-granular**, which is exactly what "fork from this
message" means.

**What's needed:**
- Track **turn indices** in the loaded history so `forkFromMessage(messageId)` can compute
  `numTurns = totalTurns − turnOf(messageId)`. (Today `loadCodexHistory` flattens turns →
  messages and discards the turn boundary; preserve it.)
- Thread `numTurns` through the fork plumbing (currently `forkOrigin.anchorUuid` carries the
  source threadId for Codex; add the rollback count, e.g. as a second field).
- `CodexSession`: after `thread/fork`, if `numTurns > 0`, call `thread/rollback`.

The current implementation is the `numTurns = 0` case (whole thread). Adding the rollback
restores real fork parity.

**Files:** `CodexSession.spawnAndHandshake` (fork branch), `CodexHistory`/rollout parser
(emit turn indices), `session-store.forkFromMessage`, createSession plumbing.

---

## 3. Issue — Codex sessions are "translated", not first-class (the perf one)

**Symptoms (live):** opening a Codex session feels slow; the first message takes a long
time to reach Codex.

**Two concrete causes:**

1. **Double cold-spawn on resume.** Opening a Codex session spawns a *throwaway*
   `codex app-server` purely for `thread/read` (history) and kills it
   (`CodexHistory.loadCodexHistory` → `withCodexAppServer`); the first message then spawns a
   **second** app-server for the live thread (`CodexSession.spawnAndHandshake`). Claude reads
   its JSONL transcript file directly (no process, `session-history.ts`) and spawns once.
2. **Handshake on the send path.** `spawn + initialize + thread/resume` all run *after* the
   user hits send, so the first message waits ~0.5–1s (worse on long threads — `thread/resume`
   reloads the whole thread server-side).

```
Current resume + first message (two cold spawns):
  Open session  → spawn app-server #1 → thread/read → KILL        (~0.5–1s)
  Send message  → spawn app-server #2 → initialize → thread/resume (~0.5–1s, ON SEND PATH)
                → turn/start → stream
```

**Proposed first-class model (symmetric with Claude's one-warm-process):**

- **History/display from the rollout JSONL directly.** Parse
  `CODEX_HOME/sessions/**/rollout-*.jsonl` into `ChatMessage[]` the way Claude parses its
  transcript — instant, no process. We already read these files for sidebar listing
  (`codexSessions.ts` parses line-0 `session_meta`); extend that to full event records.
  Keep `thread/read` as a fallback.
- **One persistent app-server per *active* Codex session**, spawned when the session is
  opened/focused (**pre-warm**) and reused for every turn, approval, and plan. The handshake
  leaves the send path entirely. `CodexSession.run(null)` is already a spawn-only path — the
  missing piece is a renderer trigger that warms the focused Codex session (e.g. via
  `ensureSession`/an activate signal) instead of waiting for the first send.

Net: open = instant (file parse) → app-server warms while the user reads → first message
hits a warm thread. The double-spawn disappears, and the `codex-watcher.ts` "spawn an
app-server per file change" hack (built for ④) gets replaced by the same rollout parser.

**Tradeoffs to weigh:**
- Direct rollout parsing **deepens coupling to Codex's on-disk format** (we already depend on
  it for listing — same risk class; keep `thread/read` as a fallback and pin the format
  expectation to `codexCliVersion`).
- Pre-warming spends a process per active session — **warm only the focused session**, keep
  the existing 15-min idle teardown (`BaseSession` inactivity).
- `thread/resume` on huge threads is still not free, just hidden behind pre-warm.

**Also relevant:** the protocol has `turn/steer` (mid-turn input injection) and
`thread/compact/start` — useful later for queue/steer parity and context management.

**Files:** `CodexSession` (lifecycle: `run`, `spawnAndHandshake`, a `warm()`/activate path),
`CodexHistory.ts` (→ rollout file parser), `codexSessions.ts` (shared parser),
`codex-watcher.ts` (replace app-server reload with parser), `BaseSession` (inactivity),
renderer activate/focus trigger (`InputBox.ensureSession`, `Sidebar`/`useClaudeEvents`
resume path), `session-history.ts` (Claude file-parse reference).

**This supersedes part of ADR-017's session model — write an ADR once the approach is locked.**

---

## 4. Recommended sequencing

1. **Mode remap** (Issue 1, quick) — unblocks real Codex usage; independent.
2. **Per-message fork** (Issue 2, quick) — `fork` + `rollback`; independent.
3. **First-class refactor** (Issue 3, substantial) — warm single app-server + rollout-file
   history; the natural place to also make history/resume coherent and retire the watcher
   hack. Write the ADR here.

(1) and (2) are quick and independent; (3) is the real effort. Decide whether to land (1)+(2)
first as a correctness pass, or fold them into (3).

---

## 5. Protocol quick-reference (verified)

```
approvalPolicy : "untrusted" | "on-failure" | "on-request" | "never"
sandbox (mode) : "read-only" | "workspace-write" | "danger-full-access"
sandboxPolicy  : {type:"readOnly", networkAccess?} | {type:"workspaceWrite", …}
               | {type:"dangerFullAccess"} | {type:"externalSandbox", networkAccess?}

thread/start    {cwd, approvalPolicy?, sandbox?, model?}                 -> {thread:{id}}
thread/resume   {threadId, approvalPolicy?, sandbox?, model?}            -> {thread:{id}}
thread/fork     {threadId, approvalPolicy?, sandbox?, model?, …}         -> {thread}
thread/rollback {threadId, numTurns}                                     -> {thread}
thread/read     {threadId, includeTurns:true}                           -> {thread:{turns:[{items:[…]}]}}
turn/start      {threadId, input, approvalPolicy, sandboxPolicy, model?, effort?}
turn/steer      {threadId, expectedTurnId, input}                       -> {turnId}
turn/interrupt  {threadId, turnId}

Server→client requests handled: item/commandExecution/requestApproval,
  item/fileChange/requestApproval, item/tool/requestUserInput,
  item/permissions/requestApproval (Allow→scope:turn, AllowForSession→scope:session,
  Deny→{permissions:{}}), mcpServer/elicitation/request ({action:'decline'}).

Rollout file: CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
  line 0: {"type":"session_meta","payload":{"id","cwd","timestamp",…}}
  then:   event records (the source of truth for a thread's items/turns)
```
