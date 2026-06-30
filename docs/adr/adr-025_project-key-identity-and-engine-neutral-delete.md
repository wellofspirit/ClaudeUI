# ADR-025 — projectKey as a derived render-identity + engine-neutral persisted-session delete

**Status:** Accepted
**Relates to:** ADR-018 (engine/vendor/account model), ADR-019 (opencode backend), ADR-020 (persistence)

## Context

The sidebar groups sessions into projects by a string `projectKey`. The two engines derived it
incompatibly for the *same* physical directory, so one project listed twice:

- **Claude** — `projectKey` is the real on-disk directory name under `~/.claude/projects/`, produced
  by Claude Code's lossy encoding of the cwd: every non-alphanumeric character → `-`
  (e.g. `D:\WorkPlace\ClaudeUI` → `D--WorkPlace-ClaudeUI`). ClaudeUI reads these dir names directly
  (`session-history.ts`), so they are authoritative — and *lossy* (you cannot recover the original
  path: `my.app` and `my-app` both encode to `my-app`).
- **opencode** — stored the real cwd in its own SQLite (`D:/WorkPlace/ClaudeUI`, Windows drive +
  forward slashes) and used `cwd.replace(/\\/g,'/')` as the key — a different string.

Two consequences had to be resolved together:
1. **Grouping.** The keys must match for the same directory.
2. **Deletion.** opencode's key contained `:` / `/`, which the Claude file-delete path's traversal
   guard rejected — so deleting an opencode session threw. And opencode sessions live in opencode's
   DB, not in `~/.claude/projects/`, so the Claude JSONL deleter can never remove them.

## Decision

### 1. `projectKey` is a DERIVED render/identity token, not a path

A single shared helper `cwdToProjectKey(cwd)` (`src/shared/project-key.ts`) replicates Claude Code's
encoding (`cwd.replace(/[^a-zA-Z0-9]/g, '-')`). Both engines' sessions are grouped by it, so the same
directory collapses to one sidebar project. Properties:

- **Lossy and one-way.** The key is *never* reversed to a path. It is an identity/grouping token and
  the on-disk directory name for Claude's own file ops — nothing more.
- **Backends keep their NATIVE identity.** opencode persists the real cwd as-is in its DB; the
  projectKey is *computed* from it for the UI. `SessionInfo` carries both `cwd` (real, for display +
  engine ops) and `projectKey` (derived, for grouping).
- **Cross-format safe by construction.** `\`, `/`, `:` all map to `-`, so `D:\…` and `D:/…` produce
  the same key. The renderer's in-memory (running-session) grouping also keys on
  `cwdToProjectKey(cwd)`, with exact-cwd retained as a fallback so Claude never regresses if a JSONL's
  recorded cwd format diverges from the dir name that produced its key.

The Claude **spawn/history-path** encoders (`claude-session.ts`, `session-manager.ts`,
`session-history.ts`) use an older, narrower `[/.]→-` form. They were deliberately left untouched here
(daily-driver risk) and are flagged as a separate latent inconsistency to investigate.

### 2. Persisted-session deletion is engine-neutral

A single dispatcher `deleteSessionByEngine(sessionId, projectKey, engineId?)`
(`opencode-session-list.ts`) routes by the owning engine; both the IPC handler and the remote
dispatcher call it (no duplicated branch):

- **opencode** → `DELETE /session/{id}` over its HTTP API via the shared server (global-by-id), keyed
  by the engine-owned `sessionId`. The lossy `projectKey` is not used. No opencode DB writes.
- **claude / undefined** → remove the JSONL + subagent directory (`deleteSessionFiles`), keyed by the
  `projectKey` (its real dir name).

`engineId` is threaded as an **optional** parameter through the type/preload/IPC/remote/web surface so
legacy callers default to the Claude path. `deleteProject` additionally deletes any opencode members
of a merged group through the same dispatcher, so they don't reappear on the next poll.

## Alternatives considered

- **Match by normalized real cwd instead of the lossy key.** Rejected: the merged group must keep
  Claude's dir-name `projectKey` for Claude's own load/delete/watch file ops, which need the real
  directory name — you can't substitute a normalized cwd there.
- **Write opencode's SQLite directly for delete.** Rejected: we only ever *read* opencode's DB
  (ADR-019 / ADR-020); deletion goes through opencode's own HTTP API so the engine owns the mechanism.
- **A full `EnginePersistenceProvider` registry** (list/history/delete behind one interface).
  Deferred as over-engineering for a single method today; the `deleteSessionByEngine` dispatcher is the
  seam to promote into the registry (alongside `EngineRegistry` / `EngineAuthProvider`) when list +
  history are also unified.

## Consequences

- The same directory with both engines' sessions shows as one sidebar project (verified: `ClaudeUI`
  ×1, count 53 = the previously-split 24 + 29).
- opencode session deletion now works (removes from opencode's DB via HTTP) instead of throwing.
- `projectKey` is documented as derived + lossy, so future code won't treat it as a reversible path.
- A follow-up remains: reconcile the narrower Claude spawn-path encoders with the shared helper.
