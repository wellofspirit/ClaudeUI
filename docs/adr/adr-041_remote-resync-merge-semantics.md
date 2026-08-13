# ADR-041 — Remote re-sync merges into local view state instead of replacing it

**Status:** Accepted — **superseded in part by ADR-051 (SyncCore)**: the desktop-renderer snapshot source and the resync merge model are replaced by main-process canonical state (`docs/architecture/sync-core.md`). This ADR remains the accurate as-built record until SyncCore phase 4 lands; the per-client-view-state lesson it encodes (selection/drafts never replicated) is carried forward into SyncCore's state classification.
**Relates to:** ADR-039 (the remote server this rides on), ADR-008 (the web client is typed against
`ClaudeAPI` — `applyRemoteSnapshot` is part of that contract), ADR-040 (`activeTasks` is one of the
per-session fields the snapshot carries)

## Context

A remote client that falls off the event stream re-syncs with `{type:'sync', lastSeq, epoch}`; the
server answers with a **sync-full** whenever catchup is impossible — page reload (`lastSeq === 0`),
desktop restart (epoch mismatch), or ring-buffer overrun while the phone was backgrounded. The
snapshot is literally the **desktop renderer's** Zustand state (`window.__getRemoteState()`).

The web client used to apply every sync-full wholesale: replace the `sessions` map, adopt the
desktop's `activeSessionId`. On a phone this is the common path, not the edge case — mobile
browsers discard backgrounded pages, so *every* app switch produced a full re-hydration that
teleported the client to whatever the desktop was showing. With the desktop on the welcome screen
(`activeSessionId: null`) the phone fell back to its localStorage `lastSelectedEngineId` plus a
first-in-catalog model ("opencode / Qwen 3.8 max"). Both cases were **routing bugs, not cosmetic**:
the next prompt went to the desktop's session, or created a fresh wrong-engine session. Locally
hydrated historical sessions (`loadHistoricalSession`) and per-session drafts were dropped on the
floor as well. Nothing mirrors the mobile client's selection back to the desktop, so the two
selections are independent by design — the desktop's must not win by accident.

## Decision

`applyRemoteSnapshot(snapshot, isResync)` distinguishes first hydration from re-sync; the web
client passes `isResync = true` from the second sync-full onward (a `hasHydratedRef` in
`RemoteApp`, flipped before the async store import so racing sync-fulls stay ordered).

- **First hydration (`isResync` falsy):** unchanged — the snapshot wins wholesale. There is no
  local state worth preserving, and desktop callers are unaffected (the parameter is optional and
  only `src/web/main.tsx` passes it).
- **Re-sync:** the `sessions` map is **merged** — `{...local, ...snapshot}` — snapshot entries win
  wherever both sides know the session; local-only entries (mobile-hydrated historical sessions)
  survive so the kept selection still resolves. `activeSessionId` keeps the **local** non-null
  value when it resolves in the merged map; otherwise it falls back to the snapshot's (a stale
  pointer rendering `EMPTY_SESSION_STATE` is worse than following the desktop).
- Server-authoritative collections (`directories`, `recentSessionIds`, pins, custom titles,
  settings) are still adopted wholesale on every sync — the merge protects *view/navigation*
  state, not data the desktop owns.

## Consequences

- Reconnect is now a pure state refresh: the phone stays on the session (and therefore the
  engine/model pair) it was looking at, and the next prompt routes there. Five store-level guard
  tests pin the exact clobber scenarios (verified failing pre-fix).
- **Accepted staleness:** a session the desktop deleted while the phone was away lingers in the
  merged map as a local-only entry until the next page reload. That map holds per-session view
  state, not the sidebar listing, so the cost is a little memory — not a ghost row.
- The mobile→desktop direction remains deliberately unmirrored; if that ever changes, the merge
  rule here (snapshot wins per-entry) is the place to revisit first.
- Anything added to `PerSessionSnapshot` is automatically covered by the merge — new fields ride
  whichever side wins the entry; snapshot-absent optional fields must default sanely on rebuild
  (as `activeTasks ?? {}` does).
