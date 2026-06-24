# Phase 8a — opencode Skills + Slash commands

> First of the Phase-8 series (the bucket-1 deferred opencode interaction features). Enables the
> `slashCommands` + `skills` capabilities for the **opencode** engine, sourced from opencode's native
> server API. **Claude is untouched and must stay behavior-preserving.** Background research +
> decisions: see the conversation that produced this spec; opencode source is cloned at
> `D:\WorkPlace\opencode-src` (tag **v1.17.9** — the pinned version).

## Verified facts (opencode 1.17.9 — build on these, do NOT re-discover)

**Commands**
- `GET /command` → `Array<{ name: string; description?: string; agent?: string; model?: string; template: string; subtask?: boolean }>`. Server-side `Command.Info` also carries `source: 'command'|'mcp'|'skill'` + `hints: string[]`, but those may not serialize through the v1 OpenAPI — treat as **optional/best-effort**. Built-ins: `init`, `review` (`review` is `subtask:true`). Plus config commands, MCP prompts, and `slash:true` skills surfaced as commands.
- Invoke: `POST /session/{id}/command` body `{ command: string /* the NAME */, arguments: string /* '' if none */, agent?, model?, variant?, messageID?, parts? }`. Runs a **full turn server-side** (template expansion: `$1..$N`, `$ARGUMENTS`, inline `` !`cmd` ``, `@file` mentions) and returns the created assistant message `{info, parts}`. Output **also streams via `/event`** as normal `message.updated`/`message.part.updated`; a `command.executed` event `{ name, sessionID, arguments, messageID }` fires at the end. **Completion is still marked by `session.idle`** — `command.executed` is informational.
- Unknown command → HTTP **BadRequest** ("Available commands: …").
- The real invoke route is `POST /session/{id}/command`. (`/tui/execute-command` is a TUI-only control channel — NOT this.)

**Skills**
- `GET /skill` → `Array<{ name: string; description?: string; location: string; content: string }>`.
- Skills are **model-invoked** via a `skill` tool. There is **NO user-invoke API and NO skill SSE event**. A `slash:true` skill ALSO appears in `GET /command` (invoke via the command path). opencode discovers skills from `~/.claude/skills/**/SKILL.md`, `~/.agents/skills`, project `.claude`/`.agents`/`{skill,skills}`, plus a built-in `customize-opencode`.

**ClaudeUI parity facts**
- `ClaudeSession` emits `session:slash-commands` (`{name}[]`, '/'-prefixed, minus a `CLI_ONLY` set) + `session:skills` (name `string[]`) at `system/init` — `claude-session.ts:881-891`. Claude **spawns eagerly** (a `run(null)` spawn-only path) to obtain init. Mirror this contract.
- Renderer slash menu is engine-neutral, gated on `capabilities.slashCommands` (`InputBox.tsx:112-118`); selection inserts `/name ` text → sent as a normal prompt. `/btw` + `/clear` are client-intercepted (`InputBox/utils.ts`); everything else flows as a prompt.
- Skills button gated on `capabilities.skills` only (`chat/ChatPanel/TopBar.tsx:20`, **no engineId check**). `SkillsDialog` → `window.api.loadSkillDetails(cwd)` → `config:load-skill-details` IPC → `scanSkills(cwd)` (`skill-scanner.ts`) → `SkillInfo[]` (`{ name, displayName?, description, source, pluginName?, path, content }` — confirm the `source` union in `shared/types.ts`).
- Transient-server discovery pattern to mirror: `src/main/opencode/model-discovery.ts` (acquire → fetch → release, cached; degrade to `[]`).

## Scope decisions (locked)

1. **Eager connect for opencode** (parity with Claude's eager spawn). Change `OpencodeSession.run(null)` from the current no-op into a **connect-only** path: `acquire` the server + build the client, fetch `GET /command` + `GET /skill` (these are instance/cwd-scoped — **no opencode session needed**), emit `session:slash-commands` (map names → `{name:'/'+name}`) + `session:skills` (name list), and **keep the connection** for reuse. `run(prompt)` reuses the existing `conn` (already coded `if (!this.conn)`). Spawns the opencode server on session creation instead of first prompt — acceptable, matches Claude, warms first-turn latency. **Degrade silently** (opencode optional): any discovery/connect failure emits nothing and does not throw. Store the discovered command names in a `Set<string>` on the session.
   - Ref-count check: `run(null)` acquires (ref+1); `run(prompt)` reuses (no extra acquire); `cancel()`/`dispose()` release once. No double-acquire.

2. **Slash-command run routing.** In `run(prompt)`, if `prompt` starts with `/` AND the first token (sans `/`) is in the discovered command-name `Set`, route to `client.runCommand(openSessionId, {command, arguments})` instead of `promptAsync`. Else send via `promptAsync` unchanged (the model sees the literal text). Parse with `prompt.match(/^\/(\S+)\s*([\s\S]*)$/)` → `command=m[1]`, `arguments=(m[2] ?? '').trim()` (or keep raw — opencode trims/handles). Keep the local user-message recording + the SSE flow **identical** (the SSE consumer handles streaming + `session.idle` either way). Wrap `runCommand` in try/catch → on BadRequest, fall back to `promptAsync` (or emit `session:error`) so an edge-case name mismatch never wedges the turn.

3. **Skills dialog source — engine-dispatch.** In the `config:load-skill-details` IPC handler, resolve the engine of the active session for that cwd (via `sessionManager`): if **opencode**, source from a cached cwd-keyed `discoverOpencodeSkills(cwd)` (`GET /skill` via transient server, mapped to `SkillInfo[]`); else `scanSkills(cwd)` **unchanged**. Map opencode `{name, description, location, content}` → `SkillInfo { name, displayName: name, description: description ?? '', source: <closest valid union value, e.g. 'project'>, path: location, content }`. Renderer + `SkillsDialog` unchanged. Mirror in `remote-handlers.ts` if that channel is mirrored there.

4. **Capability flips.** `OPENCODE_ENGINE_CAPABILITIES.slashCommands = true`, `skills = true` (`shared/model-capabilities.ts`). Update the trailing comment (remove them from the "flips true in later phases" list).

## File / seam map

**New**
- `src/main/opencode/command-skill-discovery.ts` — cwd-keyed cached `discoverOpencodeSkills(cwd): Promise<SkillInfo[]>` (and optionally `discoverOpencodeCommands(cwd)` if the IPC wants it; the session does its own command/skill emit from its held connection). Mirror `model-discovery.ts` (acquire/fetch/release, degrade to `[]`, `invalidate*` exported for auth-change).

**Edited**
- `src/main/opencode/OpencodeClient.ts` — `listCommands(): Promise<Command[]>` (GET /command), `runCommand(sessionId, body): Promise<unknown>` (POST /session/{id}/command), `listSkills(): Promise<Skill[]>` (GET /skill).
- `src/main/opencode/protocol/types.ts` — `Command`, `Skill` interfaces; `COMMAND_EXECUTED: 'command.executed'` in `EVENT_TYPES`.
- `src/main/opencode/OpencodeSession.ts` — `run(null)` connect+discover+emit; `run(prompt)` slash routing; command-name `Set`.
- `src/main/opencode/event-mapper.ts` — handle `command.executed` (ignore/informational). **No other change for A**; a subtask command's child-session events stay filtered until Phase D (note it).
- `src/shared/model-capabilities.ts` — flip slashCommands + skills; update comment.
- `src/main/ipc/session.ipc.ts` (+ `remote-handlers.ts` if mirrored) — engine-dispatch `config:load-skill-details`.
- Tests under `src/main/opencode/__tests__/`.

**Out of scope (A)**
- Subtask command child rendering (`review`'s subagent) → Phase D.
- Custom-command `.claude/commands` scanner changes (Claude-pathed + additive; leave).
- Skill **invocation** (model-driven; nothing to wire).
- Eager pre-session slash menu (the session emits on connect — sufficient).

## Step-by-step
1. Client methods + protocol types.
2. `command-skill-discovery.ts` (cwd-keyed cached) for the skills IPC.
3. `OpencodeSession.run(null)` eager connect + emit slash-commands/skills; store command names.
4. `OpencodeSession.run(prompt)` slash routing (known-command → `runCommand`, else `promptAsync`).
5. Capability flips + comment.
6. Skills IPC engine-dispatch (+ remote mirror).
7. Tests.

## Tests (default suite — no binary/network; must pass in `test`/`test:ci`)
- `OpencodeClient`: `listCommands`/`runCommand`/`listSkills` hit the right method+path (mock `fetch`).
- `OpencodeSession`: `run(null)` with a stubbed client → emits `session:slash-commands` (mapped, '/'-prefixed) + `session:skills`; `run('/review pr 1')` with `review` in the discovered set → calls `runCommand({command:'review', arguments:'pr 1'})`, NOT `promptAsync`; `run('/unknown …')` → `promptAsync` (literal); `run('plain')` → `promptAsync`. Stub the server manager + client (no binary).
- Skills discovery mapping (`GET /skill` shape → `SkillInfo[]`).
- `model-capabilities`: opencode resolved caps `slashCommands` + `skills` true (update the existing `resolve-capabilities` / `OpencodeSession` cap assertions that currently expect false).
- Keep ALL existing opencode tests green.

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- App-shot (`verifier-electron`): open an opencode session → type `/` → assert the opencode command menu (init/review/…) renders; click the Skills button → assert it appears + lists skills. Confirm a Claude session's slash menu + skills are unchanged. **Read the PNG.**

## Gotchas
- **Don't break Claude** — the slash-commands/skills events + the skills IPC must stay byte-identical for claude (engine-dispatch only branches on opencode).
- **opencode optional** — every connect/discovery failure degrades silently (no throw into create/run/getEngineModels).
- **Ref-count** — `run(null)` acquires; `run(prompt)` reuses; `cancel` releases once.
- `command.executed` is **not** completion; `session.idle` is.
- **'/'-prefix** the emitted command names (renderer expects it, matching Claude).
- **No `bun install`/`bun add`** (better-sqlite3 ABI). No new runtime deps (global fetch only).

## Commit
Branch `v2-phase-8a-opencode-commands-skills` (already created off the V2 tip). One commit, no AI attribution, multi-paragraph body. Suggested subject:
`feat(v2/opencode): slash commands + skills (Phase 8a)`.
