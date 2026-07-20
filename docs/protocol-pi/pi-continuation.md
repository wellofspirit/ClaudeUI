# pi engine integration — continuation brief

**Purpose:** a self-contained handoff so a fresh session can continue the pi engine work with no
prior context. Read this, then the pointers at the bottom. Status as of branch `pi` @ commit
`0e51393` (2026-07-20).

---

## 1. What pi is & where it lives

pi = [earendil-works/pi](https://github.com/earendil-works/pi), Mario Zechner's minimal coding
agent. It's ClaudeUI's **third engine** (after `claude` and `opencode`), behind the engine-neutral
`ISession` seam. Pinned to `package.json#piCliVersion` = **0.80.10**.

**Architecturally pi is "Claude-shaped," not "opencode-shaped":** no server — one
`pi --mode rpc` child process per session, LF-framed JSONL over stdio. Two things pi lacks that
shaped every decision:
- **No native permission system** → a ClaudeUI-owned TypeScript extension loaded per-spawn via `-e`
  (`src/main/pi/pi-bridge-source.ts`) whose `tool_call` hook POSTs decisions to a per-session
  loopback `PiBridgeHost`; a pure `permission-engine.ts` decides.
- **No MCP client** → hosted tools (mermaid/mockup) and `dispatch_agent` are registered via
  `pi.registerTool()` in that same extension, calling back over a second `PiBridgeHost` route.

Code home: `src/main/pi/`. Auth: `src/main/auth/PiAuthProvider.ts`. Sidebar/history:
`src/main/services/pi-session-list.ts`. Renderer tool map:
`src/renderer/src/components/chat/tool-registry/PiEngineToolMap.ts`. Settings:
`src/renderer/src/components/SettingsDialog/PiVendors.tsx` + the `'pi'` scope in
`settings-sections.tsx`.

## 2. Branch state — what's SHIPPED (all gate-green + real-app verified)

Branch `pi` = `pre-release` + 8 commits, pushed to `origin/pi`. Each was built via the ADR-026
workflow (Opus specs+reviews, Sonnet implements, gates + real-app drive before commit).

| Commit | Milestone | Delivers |
|---|---|---|
| `71b3e1f` | M0 | `scripts/ensure-pi.mjs` (vendored binary, SHA256-verified) + `docs/protocol-pi/README.md` wire notes |
| `f4fb7b2` | M1 | `src/main/pi/` skeleton: `PiRpcClient`, pure `event-mapper` (`mapPiEvent`), `PiSession`, `model-discovery`, `pi-session-list`; the 5 compile-enforced engine tables |
| `f62aa10` | M2a | approval bridge: `-e` extension → `PiBridgeHost` → `permission-engine` over shared `~/.claude` rules; autonomy ask/autoEdit/full |
| `0481757` | M2b | steer, thinking-levels→effort picker, slash/skills (`get_commands`), live bash streaming |
| `cb2d004` | M3 | `PiAuthProvider`, Settings `pi` scope + `PiVendors`, shared skills via `resources_discover`, configurable default model |
| `6301637` | M4a+b | hosted `render_mermaid`/`create_mockup`/`show_mockup` + pi as dispatch **source** |
| `e54f2ac` | M4c | pi as dispatch **target** (headless `PiRpcClient` + per-target `PiBridgeHost`, two-stage approval, recursion impossible) |
| `0e51393` | docs | ADR-035, architecture.md, ADR-026 pi-wire constraint, CLAUDE.md |
| `771be7e` | audit fixes | SECURITY: one-shot `/hosted-tool` grants (token-only POST can no longer bypass dispatch_agent's ask), content-verified bridge file, timing-safe token; steer/doStart/exit lifecycle fixes; usage accountId; crash-path + hook-harness tests |
| `acd3228` | audit fixes | dispatch target: failed/stopped-turn spend counts toward cap, `draining` closes the late-ask orphan race, env recursion guard overrides (not omits) the enable flags |
| `8596223` | audit fixes | InputBox fallback ModelInfo carries explicit flags (empty-catalog pi session no longer leaks Claude pickers), pi default-model fallback branch; direct capability/store/settings test suites |

Full parity with opencode: chat/tools/sessions/usage, interactive approvals honoring the **same
`~/.claude` permission rules** as Claude/opencode, auth, shared skills, hosted mermaid/mockup,
bidirectional cross-engine dispatch.

Tests at branch tip: **324 files / 5385 passing at `test:ci` scope** (the default `bun run test`
skips the slow 2-file/53-test `git` project) + a gated `PI_INTEGRATION_TESTS` real-binary suite
(4 files, 9 tests — all green against the hardened bridge). Durable record: **ADR-035**
(`docs/adr/adr-035_pi-engine-backend.md`).

## 3. What's NOT built — the backlog (this is the point of the handoff)

Eleven capability flags are `false` in `PI_ENGINE_CAPABILITIES` (`src/shared/model-capabilities.ts`)
— nine top-level plus `auth.canDriveLogin`/`auth.multiAccount`. Three buckets — the distinction
matters:

### Bucket A — N/A to pi (correctly false forever; don't "fix")
None of these leak into the pi Settings scope (sandbox/proxy live only in the claude scope's section
list — capability gating is belt-and-braces on top; there is no backgroundTasks settings section at
all; voice is a common-scope section whose *behavior* is capability-gated per session). Flipping
them = inventing a feature pi doesn't have.
- **`sandbox`, `proxy`** — Claude cli.js *launch params*. pi runs tools directly; its isolation
  story is running pi itself in a container. No per-launch flag exists.
- **`backgroundTasks`** — Claude's detached-bash (`BashOutput`/`KillShell` streaming to a file).
  pi's `bash` has only `timeout` + `abort_bash`. No registry to surface.
- **`voice`** — Claude streams audio to a transcription server *inside cli.js*. pi has none.
- **`auth.multiAccount`** — pi's `auth.json` holds one credential *per provider* (many providers OK,
  but not two ChatGPT accounts to swap). Same as opencode.

### Bucket B — real pi capabilities, just unwired (the valuable follow-ups)
- **`fork` / `forkFromMessage`** ⭐ **highest value.** pi has a *native branching session tree*
  (`fork {entryId}`, `clone`, `get_fork_messages`, `get_tree` in the RPC — see
  `vendor/pi-cli/docs/rpc.md` + `session-format.md`). This is a place pi is *better* than what we
  expose. Unwired only because ClaudeUI's fork UX (ADR-010) is built on Claude's JSONL
  `--resume-session-at`/`--fork-session` flags. **First step:** teach the fork-anchor resolver about
  pi's entry-id tree; `PiSession` already parses the tree in `pi-session-list.ts`
  (`activeBranchEntries`). Wire `EngineSpawnOptions.resumeSessionAt`/`forkSession` in `PiSession`
  to pi's `fork`/`--session` + a get_fork_messages-backed anchor list. Moderate effort. Flip both
  flags ONLY when the full path works (ADR-030).
- **`sideQuestion`** (the `/btw` one-off question) — **cheapest.** Spawn an ephemeral
  `pi --mode rpc --no-session`, ask, dispose — the exact pattern `model-discovery.ts` and the
  dispatch target already use. Implement `PiSession.askSideQuestion()` (BaseSession returns null by
  default) + flip `sideQuestion`. Low effort.
- **`plan`** — no *native* plan mode, but pi ships plan-mode as an example extension
  (`vendor/pi-cli/examples/extensions/plan-mode/`), so the pattern is "build it as read-only
  autonomy." Add a `plan` autonomy to `permission-engine.ts` that denies all mutating kinds
  (allow read/search only) + a plan-exit affordance, then add `'plan'` to `autonomyModes`. Moderate.
  Left false rather than ship a half-version.

### Bucket C — limited by pi's design (workaround or pi-upstream)
- **`auth.canDriveLogin`** — pi's OAuth `/login` (ChatGPT/Claude Pro/Copilot subscriptions) is
  **TUI-interactive only**; no headless login endpoint to drive (unlike Claude's OAuth over cli.js
  control requests, ADR-014). M3 ships a "run `/login` in a terminal" hint + copyable binary path;
  **API keys work fully in-app today.** Workaround: shell pi's `/login` into a **PTY inside the
  app** (we already have node-pty terminals — see `pty-manager.ts`) so the user never leaves
  ClaudeUI. Medium value, moderate effort. Only the one real friction point for a subscription user.
- **`subagents`** — pi has no *native* subagent tool emitting child-session events (unlike Claude's
  Task tool / opencode's `task` tool streaming on the shared SSE). pi's subagents are an
  example-extension pattern — nothing on the wire to map to `session:subagent-*`. Higher effort,
  and partly moot since cross-engine dispatch already gives pi a delegation path.

**My recommendation for next work:** `sideQuestion` (near-free), then `fork` (exposes pi's best
feature), then the PTY-login workaround. Everything in Bucket A: leave alone.

**Known residuals (accepted 2026-07-20, audit-fix milestone):**
- Bridge-file TOCTOU: content-verify closes the preplant hole, but on POSIX an attacker who owns a
  pre-created `claudeui-pi-bridge/<ver>/` dir could still race the write→spawn window. Stronger fix
  if it ever matters: move the file under `app.getPath('userData')`.
- pi's rule evaluator still honors only bare-tool + Bash exact/prefix rules (path-glob /
  `additionalDirectories` / `defaultMode` inert — see §4).
- pi source Esc-abort does not propagate into an in-flight dispatch (documented v1 limitation;
  TaskCard Stop works).
- A dispatch target's errored-turn spend is recovered from the mapper's running total — pi's error
  events themselves carry no cost snapshot, so a turn that dies before its first cost-bearing
  `message_end` genuinely spent ~nothing and records none.

## 4. Load-bearing facts a new session MUST know

**Verified wire facts** (probed against the real binary — trust, don't re-derive; full list in
`docs/protocol-pi/README.md`):
- Framing: split stdout on `\n` only, strip trailing `\r`, NEVER Node `readline`. stdout is pure
  protocol; stderr is logging.
- `agent_settled` is the **only** reliable turn-complete signal (`agent_end` may be followed by
  retries/queued follow-ups).
- Events carry **no stable message id** — the mapper synthesizes one per `message_start`.
- Registered-tool `parameters` accept a **plain JSON-schema object** (no typebox import — the bridge
  extension is import-free); `execute()` returns MCP-shaped `{content:[{type:'text',text}],isError?}`.
- The `tool_call` gate **fires for registered tools too** → hosted tools are a two-stage flow (gate,
  then execute). That's why `permission-engine` has `PI_AUTO_ALLOW_HOSTED_TOOLS` (mermaid/mockup
  auto-allow; `dispatch_agent` gets normal gating).
- pi's `abort` is **turn-scoped, not process-killing** (the pi dispatch target survives for
  continuation, unlike the Claude target which tears down).

**Gotchas that bit me:**
- `InputBox` derives reasoning pickers via `claudeModelCapabilities()` for EVERY engine — non-claude
  ModelInfo MUST set `supportsEffort`/`supportedEffortLevels`/`supportsAdaptiveThinking` explicitly
  or Claude's pickers leak onto pi sessions. This now includes the synthetic empty-catalog
  fallback in `InputBox.selectedModel` (fixed `8596223`; renderer guard tests pin it) — any NEW
  place that fabricates a ModelInfo must set the flags too.
- The `tool_call` gate and `/hosted-tool` execution are correlated by a one-shot grant
  (`PiSession.hostedGrants`, fixed `771be7e`) — the bearer token alone deliberately does NOT
  authorize execution. Anything that adds a hosted tool must flow through
  `PI_HOSTED_TOOL_NAMES` in permission-engine.ts or its execute() will fail closed.
- Cross-engine remembered models leak into spawns — `resolvePiSpawnModel` guards it: with a
  non-empty catalog a foreign/stale model is swapped to a valid pi model (configured default, else
  first catalog entry); `undefined` (pi keeps its own restored model) is only the empty-catalog /
  failed-discovery rung.
- `db.ts` clamps unknown engine ids to `'claude'` — any new engine must be added to the
  `rowToMeta`/`importSessionEnginesOnce` allowlists.
- Bridge extension MUST stay **import-free** and **fail-closed**. Product code writes only
  `os.tmpdir()` (the bridge file) + `PiAuthProvider`'s documented `~/.pi/agent/auth.json` api_key
  merge + user-initiated session delete under `~/.pi/agent/sessions` (`deletePiSession`) — never
  else under `~/.pi/**`.
- pi honors the same `~/.claude` permission FILES as Claude/opencode (same loader/parser/persist
  helpers), but its evaluator honors a **subset of rule shapes**: bare-tool + Bash exact/prefix
  rules only. Non-Bash specifier rules (`Edit(src/**)` etc.) are skipped (fall through to the mode
  base, never default-allow), and `additionalDirectories`/`defaultMode` are merged but inert —
  path-glob evaluation is an open follow-up, not shipped.

## 5. Test setup & how to verify (reproduce my environment)

- **Test auth:** the user's ChatGPT OAuth was transplanted from opencode into `~/.pi/agent/auth.json`
  as provider `openai-codex` (same OAuth client id `app_EMoamEEZ73f0CkXaXp7hrann`; token was valid
  to 2026-07-28 — **may need refresh**). Test model: **`openai-codex/gpt-5.6-luna`**. ⚠️ It shares a
  refresh token with opencode's `openai` credential — a pi-side refresh can rotate it and strand
  opencode's copy; isolate a throwaway `~/.pi` for probes when possible.
- **Gates (run from repo root):** `bun run typecheck && bun run lint && bun run test`, plus
  `PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi` (real binary; runs the
  credential-gated tests on this machine). After any dep change: `bun run rebuild:native`.
- **Real-app drive** (verifier-electron / `scripts/app-shot.mjs`): `bun run build` then a Playwright
  `_electron` driver script in `.cache/verify/` (gitignored). Gotchas learned the hard way:
  sidebar `DirectoryItem`s are collapsed by default (click the group before asserting session rows);
  **never use a live-response needle that can self-match the user's own prompt bubble** (use a
  model-*computed* sentinel like a math answer); assert idle via `InputBox.cancel` count 0; and the
  Electron instance can hold a build lock — a transient build exit 9 usually means "close the prior
  driven app first."
- **⚠️ Real-app dispatch drives can attach to the live conversation session** (most-recent ClaudeUI
  session). The clean proof for pi-as-target is the isolated `pi-dispatch-target.integration.test.ts`,
  not an app drive.

## 6. Workflow to follow (ADR-026 — non-negotiable for non-trivial work)

Opus orchestrates + reviews **every line**; a Sonnet sub-agent implements against a written kickoff
spec (never self-certifies, never commits/`git add`/branches/`bun install`). Review the diff (not
the summary), re-run gates independently, verify guard tests fail pre-fix, drive the real app,
commit precisely (no `git add -A`, no AI attribution), one commit per milestone. My kickoff specs
are in the scratchpad (`scratchpad/specs/m*.md`) — pattern them for the next milestone.

## 7. Pointers (durable records)

- **ADR-035** `docs/adr/adr-035_pi-engine-backend.md` — the authoritative design record.
- **`docs/protocol-pi/README.md`** — verified wire facts (transport, events, sessions, auth,
  extensions). Version-exact protocol docs ship in `vendor/pi-cli/docs/*.md`.
- Source questions: **shallow-clone the pinned tag** (`git clone --depth 1 --branch v0.80.10
  https://github.com/earendil-works/pi`) — there is deliberately NO vendored pi source clone.
- Auto-memory `project-pi-engine-integration` (loads each session) — the one-line status + gotchas.
- opencode is the structural template throughout: when unsure how pi should do X, read how
  `src/main/opencode/` does it (ADR-019/022/024/033).
