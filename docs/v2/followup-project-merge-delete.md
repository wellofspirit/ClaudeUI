# Followup — merge same-project groups across engines + engine-neutral session delete

**Branch:** `v2-followup-engine-ux-polish` (same branch as the engine-UX polish).
**Status:** kickoff spec. Implementing agent: Sonnet. Reviewer/orchestrator: Opus.

## Problem

A single physical project directory appears **twice** in the sidebar PROJECTS list when it
has both Claude and opencode sessions (e.g. `ClaudeUI` shows up twice). The sidebar groups by
`projectKey`, but the two engines compute incompatible keys for the same cwd:

- **Claude** group key = the real on-disk dir under `~/.claude/projects/` — Claude Code's lossy
  encoding of the cwd (`[^A-Za-z0-9] → '-'`). Verified on this machine:
  `D:/WorkPlace/ClaudeUI` → `D--WorkPlace-ClaudeUI` (and 9 siblings, all consistent).
  Source: `session-history.ts:196` reads the dir names directly (authoritative).
- **opencode** group key = `cwdToProjectKey(cwd)` = `cwd.replace(/\\/g,'/')` →
  `D:/WorkPlace/ClaudeUI` (opencode-session-list.ts:67-70). opencode's DB stores the real cwd
  as `D:/WorkPlace/ClaudeUI` (Windows drive, forward slashes) — verified by reading
  `~/.local/share/opencode/opencode.db` `session.directory`.

Different strings → two groups.

## Design (decided with the user)

1. **`projectKey` is a RENDER/IDENTITY token in Claude's lossy format.** It is derived from a cwd
   via a single shared helper; it is **never reversed** back to a path (it can't — lossy). The UI
   groups + renders by it; Claude's own file ops (load/delete/watch JSONL) already use it as the
   real dir name.
2. **Backends keep their NATIVE identity.** opencode keeps the real cwd as-is in its DB; the
   projectKey is *derived* for the UI. `SessionInfo` carries BOTH `cwd` (real) and `projectKey`
   (Claude-format) — it already does; we only change how the opencode key is computed.
3. **Delete is engine-neutral.** The renderer sends `{ sessionId, projectKey, engineId }`; main
   routes to the engine that owns the session:
   - claude → `deleteSessionFiles(sessionId, projectKey)` (existing — removes JSONL + subagent dir).
   - opencode → `client.deleteSession(sessionId)` via the shared server (HTTP `DELETE /session/{id}`,
     global-by-id; mirror `loadOpencodeSessionHistory`'s shared-server pattern). The lossy projectKey
     is NOT used for opencode delete — the engine-owned `sessionId` is.

## Out of scope (do NOT touch)

- The Claude **spawn/history-path** encoders `claude-session.ts:1799`, `session-manager.ts:122`,
  `session-history.ts:559` (`cwd.replace(/[/.]/g,'-')`). They are on the daily-driver path and may be
  a separate latent inconsistency — leave them. The sidebar Claude key comes from real dir names, not
  these. Do not refactor them to the shared helper in this change.
- Any opencode DB **write**. opencode deletion goes through opencode's own HTTP API, never a direct
  SQLite write (we only ever read its DB).
- A full `EnginePersistenceProvider` registry. Use a simple main-side dispatcher (documented as the
  seam to promote later). Don't over-build.

## File / seam map + steps

### 1. Shared encoder — NEW `src/shared/project-key.ts`

```ts
/**
 * Encode a cwd into the project-grouping key used across the sidebar.
 *
 * This MUST match Claude Code's on-disk project-dir naming under
 * ~/.claude/projects/ — it replaces every non-alphanumeric character with '-'
 * (lossy; not reversible). Both engines' sessions are grouped by this key so the
 * same physical directory collapses to ONE sidebar project.
 *
 * Empty/undefined cwd → ''. No separator/drive-case pre-normalization: '\\' and
 * '/' and ':' all map to '-' already, and Claude uses the path as-is (uppercase
 * Windows drive letters, matching opencode's stored cwd).
 */
export function cwdToProjectKey(cwd: string): string {
  if (!cwd) return ''
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
```
- Add a unit test `src/shared/__tests__/project-key.test.ts`: assert the 10 real cases collapse
  (`D:/WorkPlace/ClaudeUI` and `D:\WorkPlace\ClaudeUI` BOTH → `D--WorkPlace-ClaudeUI`;
  `D:/WorkPlace/tools-auggie` → `D--WorkPlace-tools-auggie`; `''` → `''`; a POSIX path
  `/home/u/proj` → `-home-u-proj`). The Windows `\\` and `/` cases producing the SAME key is the
  core guarantee — make that an explicit assertion.

### 2. opencode emits the Claude-format key — `opencode-session-list.ts`
- Replace the local `cwdToProjectKey` (lines 62-71) with an import from `../../shared/project-key`.
- `listOpencodeSessionsGlobal` keeps `cwd: row.directory` (real) and now sets
  `projectKey: cwdToProjectKey(cwd)` (Claude-format). No other change.

### 3. Renderer in-memory grouping is canonical-key aware — `Sidebar.tsx` `augmentedDirs` (~620-672)
The in-memory (running, not-yet-on-disk) sessions are grouped by EXACT `data.cwd` and matched to a
persisted group by `group.cwd` (lines 641, 654). A running opencode session whose cwd format differs
from the merged group's `cwd` would still split. Make matching canonical WITHOUT regressing Claude's
exact-cwd match:
- Build a lookup of persisted groups by BOTH their `projectKey` AND their exact `cwd`.
- For each in-memory session, compute `const pk = cwdToProjectKey(data.cwd)`. Match a persisted group
  if `group.projectKey === pk` **OR** `group.cwd === data.cwd` (exact-cwd kept as a fallback so Claude
  never regresses).
- Group leftover in-memory sessions (no persisted match) by `pk` (canonical), so two in-memory
  sessions of different engines in the same dir collapse into ONE new group. Set that new group's
  `projectKey: pk` (was `''`) and `cwd: data.cwd`, `folderName` = basename of data.cwd.
- Import `cwdToProjectKey` from `../../../../shared/project-key`.
- Keep `applyCustomTitles` and ordering behavior intact.

### 4. Engine-neutral session delete (main)
- NEW `deleteOpencodeSession(sessionId)` in `opencode-session-list.ts`, mirroring
  `loadOpencodeSessionHistory`: `acquire(PERSISTED_SESSIONS_DIR)` → `new OpencodeClient(...)` →
  `await client.deleteSession(sessionId)` → `release` in `finally`. Best-effort: log + swallow on
  error (never throw to the IPC layer). (If DELETE turns out project-scoped rather than global, that
  surfaces in the real-app verify — note it; do not pre-engineer a cwd path.)
- `session.ipc.ts` `session:delete-session` (1032-1037): add an `engineId?: EngineId` param; route
  `engineId === 'opencode'` → `deleteOpencodeSession(sessionId)`, else →
  `deleteSessionFiles(sessionId, projectKey)`. Import `deleteOpencodeSession`.
- Mirror the new param in `remote-handlers.ts` (`session:delete-session`, ~315) and the web adapter
  `src/web/api-adapter.ts` (deleteSession, ~186) and `src/test/helpers/boot-test-app.ts` (~224).
- Type surface: `src/shared/types.ts` `deleteSession(sessionId, projectKey, engineId?)` (~659) and
  `preload/index.ts` deleteSession (~248). Keep `engineId` OPTIONAL so existing callers compile.

### 5. Renderer delete wiring threads engineId
- `session-store.ts` `deleteSession` (1203): rename `_engineId` → `engineId`, pass it:
  `await window.api.deleteSession(sessionId, projectKey, engineId)`. (The action signature already
  has `engineId?`; `confirmDelete` in Sidebar already passes `deleteTarget.engineId`.) No further
  renderer change needed for single-session delete.
- `deleteProject` (1245): a merged project may contain opencode sessions. AFTER
  `await window.api.deleteProject(projectKey)` (which nukes the Claude dir), also delete each opencode
  member via the engine-neutral path. Before the `setState`, read the group from the current state and
  for every session with `engineId === 'opencode'` call
  `await window.api.deleteSession(s.sessionId, projectKey, 'opencode')` (best-effort;
  `Promise.allSettled`). The existing state-scrub logic stays as-is. This prevents opencode sessions
  in the group from reappearing on the next poll.

### Display
- No change required: a merged group keeps the Claude group's `cwd`/`folderName` (Claude group is the
  base in `mergeOpencodeIntoDirectories`). opencode-only groups display their real cwd + basename.
  Confirm folderName still renders (basename of `cwd`).

## Tests (practical; each must fail against pre-change behavior)
- `project-key.test.ts` (above) — the `\\` vs `/` → same-key guarantee + the real samples.
- opencode-session-list: a unit test that `listOpencodeSessionsGlobal` maps a row with
  `directory: 'D:/WorkPlace/ClaudeUI'` to `projectKey: 'D--WorkPlace-ClaudeUI'` (mock
  `readOpencodeSessionRows`). This is the merge regression guard — it would fail under the old
  forward-slash key.
- A renderer unit test for `mergeOpencodeIntoDirectories` (export it if needed, or test via the
  existing Sidebar test) proving an opencode SessionInfo with `projectKey: 'D--WorkPlace-ClaudeUI'`
  merges INTO an existing Claude group with the same projectKey (one group out, both sessions in),
  and creates a separate group when keys differ.
- Engine-neutral delete: a main-side test that `session:delete-session` routes opencode →
  `deleteOpencodeSession` (mock) and claude → `deleteSessionFiles` (mock) by engineId. Keep the
  existing `delete-session-files.test.ts` green.

## Verify gates
`bun run typecheck && bun run lint && bun run test` — 0 lint errors (the 3 known exhaustive-deps
warnings are OK). Then `bun run build`. Report exact output. Do NOT commit, branch, or `bun install`.

## Gotchas
- `deleteSessionFiles` uses `rm({force:true})` — missing targets are ignored. Its `SEGMENT_TRAVERSAL`
  guard rejects `/`,`\`,`..`; the new opencode key (`D--WorkPlace-ClaudeUI`) passes it, but opencode
  delete must NOT go through that path — it routes to `deleteOpencodeSession`. Make sure the engineId
  branch is taken BEFORE `deleteSessionFiles`.
- `engineId` must stay OPTIONAL across the IPC/type surface so nothing else breaks to compile.
- Don't change the Claude spawn-path encoders (out of scope).
- Best-effort everywhere for opencode (server may be down) — never throw to the UI; log via `logger`.
