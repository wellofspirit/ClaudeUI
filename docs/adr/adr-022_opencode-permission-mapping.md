# ADR-022: opencode permission model — autonomy-mode → ruleset mapping

**Status:** Accepted
**Date:** 2026-06-22
**Relates to:** [ADR-018](adr-018_v2-engine-vendor-account-model.md) (neutral autonomy modes), [ADR-019](adr-019_opencode-engine-backend.md) (opencode backend)

## Context

ClaudeUI exposes four neutral **autonomy modes** (`plan | ask | autoEdit | full`, ADR-018), surfaced
with Claude-style labels and mapped to Claude's permission-mode strings (`plan` / `default` /
`acceptEdits` / `auto`). The opencode backend must realize those same intents against opencode's own
permission machinery.

opencode does **not** have a Claude-style mode enum. Autonomy is the pair **(agent, permission
ruleset)**:

- **agent** — `build` (default primary), `plan` (read-only primary), plus subagents
  (`general`/`explore`) spawned by the `task` tool. Each agent ships its own ruleset.
- **permission** — an **ordered array** of `{ permission, pattern, action }` rules,
  `action ∈ { allow, ask, deny }`, evaluated **last-match-wins** (`K.findLast(match)` in the source).
  `permission` is a tool/category name (`*`, `read`, `edit`, `bash`, `webfetch`, `task`, `glob`,
  `grep`, `list`, `doom_loop`, `external_directory`, …); `pattern` matches the tool argument (file path
  / bash command / **task subagent type**). Read-class tools (`read`/`glob`/`grep`/`list`) **and
  `task`** are allow-by-default — they only prompt if a rule makes them.

Two facts established by reading the opencode source (vendored 1.17.9 binary), not just probing:

- **Composition / precedence.** At eval time opencode computes `K = merge(agent.permission,
session.permission)` then `K.findLast(match)`. So the **session-level permission is layered AFTER the
  agent and overrides it** (last-match-wins).
- **Session patch is cumulative.** `PATCH /session/{id}` does `setPermission(merge(existing, payload))`
  — there is **no replace/clear**; session permission only grows.
- **Built-in agents** are themselves `merge(base, override, userConfig)`. The `build` agent is
  permissive (`{*:allow}` baseline + `doom_loop`/`external_directory`/`*.env`-read asks). The **`plan`
  agent** = `merge(base, { question:"allow", plan_exit:"allow", task:{ general:"deny" },
edit:{ "*":"deny", <plan-files>:"allow" } })` — it denies edits (except plan markdown) and **denies
  only the `general` subagent**; other subagents (e.g. read-only `explore`) stay allowed.

opencode's interactive TUI layers prompting on top of the bare server agents; the server agents
themselves are mostly permissive.

**The bug this fixes.** `OpencodeSession.applyPermissionMode` discarded opencode's ruleset and patched
a single wildcard rule `[{ permission:'*', pattern:'*', action: allow|ask }]`:

- `ask`/default → `{*:* ask}` forced **every** tool to prompt — including `task`. In `ask` mode
  opencode raises a `permission.asked` for the `task` tool itself (on the parent session) and parks
  the task at `status=running`; with the renderer also failing to surface that approval, the turn hung
  forever and no subagent was ever spawned.
- `acceptEdits` → `{*:* allow}` allowed _everything_ (incl. bash) — not "auto-accept _edits_".
- All modes clobbered opencode's own protections (`.env` reads, external-directory, doom-loop).

## Decision

Map each autonomy mode to a **self-contained ruleset layered on a `{*:allow}` baseline** (mirroring how
opencode's own agents are structured), so read-class tools and `task` stay auto-allowed while
write-class tools are gated. `applyPermissionMode` **always** patches the mode's full ruleset
(including `plan`).

A self-contained ruleset is the _robust_ choice given the source facts above: because session
permission **overrides** the agent and is **cumulative (cannot be cleared)**, a ruleset patched as the
latest payload always has its rules evaluated last → it **dominates** regardless of which agent is
active or what prior modes accumulated. (A delta-only ruleset would be vulnerable to stale overrides
from a previous mode, since you can't un-patch them.)

| Autonomy (Claude mode string) | agent   | session permission ruleset (last-match-wins)          |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `plan`                        | `plan`  | `[{*:allow}, {edit:* deny}, {task:general deny}]`     |
| `ask` (`default`)             | `build` | `[{*:allow}, {edit:ask}, {bash:ask}, {webfetch:ask}]` |
| `autoEdit` (`acceptEdits`)    | `build` | `[{*:allow}, {bash:ask}, {webfetch:ask}]`             |
| `full` (`auto`)               | `build` | `[{*:allow}]`                                         |

- **`ask` is Claude-faithful**: reads/glob/grep/list/`task` auto-allowed; edit/bash/webfetch prompt.
  `task` is _not_ gated → no spurious subagent-spawn prompt, no hang.
- **`plan`** mirrors opencode's own `plan` agent: deny edits, and deny **only the `general`
  subagent** (`{task:general deny}`) — read-only subagents (e.g. `explore`) stay allowed via the
  baseline, so **plan-mode `task`/research still works**. `deny` refuses without a permission
  round-trip (no approval to surface → no hang). Pairing with the `plan` agent adds its planning
  system prompt + plan_exit flow. We deliberately do **not** reproduce opencode's plan-file edit
  allow-list (`.opencode/plans/*.md`) — minor; plan output is surfaced via `plan_exit`.
- **Subagents are unaffected by the parent ruleset**: a `task` runs in a child session under its own
  (permissive) subagent agent, so it does not raise child-session `permission.asked` events (which the
  event mapper would otherwise drop — see Consequences).

**Defense-in-depth (renderer).** `TaskCard` now consumes a pending `approval` and renders the shared
`<ApprovalButtons>` (mirroring the lifted plan/question cards). If a `task` ever legitimately asks
(custom opencode agent, or Claude), the UI degrades to a visible Allow/Deny instead of a silent hang —
independent of the permission mapping above.

## Consequences

- opencode autonomy now matches Claude semantics; the reported "research subagent hangs forever" bug is
  resolved at the source (mapping) **and** masked (TaskCard approval) — verified end-to-end against the
  vendored binary: in `ask` mode the `task` runs un-prompted and the subagent explores via
  glob/grep/read with no prompts.
- We restore the **portable** subset of opencode's built-in guards in the gated modes (plan / ask /
  acceptEdits): `doom_loop:ask` + secret-file read protection (`*.env` ask, `*.env.example` allow).
  `full`/`auto` stay unguarded (unattended by design). We **omit** opencode's `external_directory`
  guard: its safe form needs an env-specific allow-list for opencode's own tool-output/temp dirs, so a
  bare `{external_directory:ask}` would spuriously prompt on opencode's internal writes. A proper
  "additional directories" mapping is part of the broader unified-permission design (below).
- **Known residual (deferred):** the event mapper's cross-session filter drops _all_ child-session
  events, so a subagent that _did_ raise its own `permission.asked` (child `sessionID`) would be
  invisible and could hang. The mapping above avoids this in practice (subagents don't prompt under
  their permissive agents), but full child-session handling is part of the deferred Phase-6 subagent
  work (`subagents: false` in 5b).
- The mode strings consumed are the renderer's existing Claude-style values; no renderer change to the
  autonomy picker.

## Unified permission rules (default mode)

Beyond the per-mode base ruleset, the user's **configured** permission rules now apply to opencode too,
so the same allow/ask/deny rules + additional directories govern both engines.

- **Source of truth = Claude's permissions** (`ClaudePermissions` — `allow`/`ask`/`deny` `Tool(specifier)`
  strings + `additionalDirectories`, edited by the existing PermissionsDialog). No new store/UI.
- **`permission-compiler.ts`** (pure, unit-tested) parses `Tool(specifier)` → opencode
  `{permission, pattern, action}`: tool→category map (Read/Glob/Grep→read/glob/grep, Edit/Write/
  NotebookEdit→edit, Bash→bash, WebFetch→webfetch, Task→task; MCP/unmapped skipped); specifier
  translation (Bash `cmd:*` prefix → glob `cmd*`; WebFetch `domain:x`→`x*`; file globs pass through);
  `additionalDirectories`→`external_directory` ALLOW rules (`join(dir,'*')`, platform-correct).
- **Composition**: `applyPermissionMode` patches `[...base(mode), ...compiledUserRules]` — user rules
  appended AFTER the base (override it), emitted **allow → ask → deny** so deny wins last-match-wins,
  replicating Claude's deny>ask>allow precedence. All three scopes (user/project/local) merged.

**Pending follow-on (decided, not yet built):**

- **"Always-allow" write-back** — generate Claude-format `suggestions` for opencode approvals and, on
  accept, `replyPermission('always')` (live session) **and** persist via `saveClaudePermissions`
  (shared store → reapplies next spawn, visible in PermissionsDialog). Full parity with Claude.

## Auto mode — LLM permission gatekeeper

ClaudeUI's `full` autonomy maps to Claude's `auto` mode, which in cli.js is an **LLM "security
monitor"** (not a rule check). Until opencode has an equivalent, opencode `full` is gated like
`default` (interim, above). The opencode port is specified in **[ADR-023](adr-023_opencode-automode-classifier.md)**.

One verified finding worth recording here (it informs the model choice): the cli.js classifier builds
an **independent** prompt — it omits the main system prompt (`skipSystemPromptPrefix`) and re-serializes
a slimmed transcript — so its request **shares no cache prefix with the live conversation**. Judge-model
choice therefore buys **no** cache reuse from the session on any model; caching helps only
classifier-to-classifier (per judge model). Cost is dominated by transcript slimming + a cheap judge +
a per-turn call cap, not by model-matched cache reuse. Full design + cost-guards in ADR-023.
