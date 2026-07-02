# ADR-030 — Capability honesty: a capability flag is true only when the end-to-end path works

**Status:** Accepted
**Relates to:** ADR-018 (engine/vendor/account capability model), ADR-019 (opencode backend)

## Context

`EngineCapabilities` (ADR-018) gates UI affordances per engine — the renderer shows or hides
features (Fork, voice, background tasks, …) purely by reading a boolean off `status.capabilities`.
That contract only holds if a `true` flag means the feature actually works end to end. It didn't:
`OPENCODE_ENGINE_CAPABILITIES` declared `fork: true` and `forkFromMessage: true`, so `MessageBubble`
showed a Fork button on opencode sessions whose only possible outcome was an error — "Cannot branch
from this message yet…" — because the whole path behind the flag was unwired: `OpencodeSession`
discards the `_resumeSessionAt`/`_forkSession` spawn params, `OpencodeClient.forkSession()` has no
production caller, and `forkFromMessage`'s anchor resolution (`resolveForkAnchor`) only reads Claude's
JSONL transcripts. The flag was scaffolding for a feature that was never wired up, left `true` by
default.

## Decision

A capability flag may be `true` for an engine **only** when the full end-to-end path behind it is
implemented and reachable for that engine — spawn params consumed, a real caller wired to any client
method, and any resolution/lookup step engine-aware (not hardcoded to another engine's storage
format). A partial scaffold (an unused client method, an ignored constructor param) does not earn a
`true`; the flag stays `false` until the path is actually wired.

The store keeps a defensive last-resort guard in `forkFromMessage` (`session-store.ts`) that
re-checks `status.capabilities.forkFromMessage` before calling `resolveForkAnchor`, so a stale-true
flag can never reach the Claude-only anchor-resolution path even if UI gating (`MessageBubble`) were
bypassed or regressed.

Concrete action taken here: `OPENCODE_ENGINE_CAPABILITIES.fork` and `.forkFromMessage` flip to
`false`. `OpencodeClient.forkSession()` stays in the tree, documented as intentionally unwired, for a
future native-fork implementation.

## Consequences

- Opencode sessions no longer show a Fork button that can only fail — the UI is honest about what the
  engine can do.
- The flip is guarded by tests at three layers: the raw capability constant, the store action's
  defensive guard, and the component's render gating.
- Future engines get an explicit checklist item: wire the full path (spawn params → client caller →
  engine-aware resolution) before flipping the corresponding flag to `true`, not after.
- `OpencodeClient.forkSession()` remains as a documented, currently-uncalled scaffold rather than
  being deleted — it's the seam a future native-fork implementation picks up.
