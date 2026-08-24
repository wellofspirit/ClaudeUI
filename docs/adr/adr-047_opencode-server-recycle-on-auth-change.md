# ADR-047 — Recycle pooled opencode servers on user-initiated credential changes; the timer feed stays write-only

**Status:** Accepted (2026-08-04) — shipped in `5926792`
**Relates to:** ADR-044 (provider disable vs remove — the auth mutations this covers),
ADR-045 (engine disconnect contract — the recycle deliberately rides that exact
fan-out → `markDisconnected` → lazy-reconnect path)

## Context

opencode builds its provider map **once per server process** (`InstanceState` in the
fork's `provider/provider.ts`) and never watches `auth.json`; `Auth.set` — including the
server's own `PUT /auth/{id}` route — only writes the file. ClaudeUI pools long-lived
`opencode serve` processes per cwd (`OpencodeServerManager`). Consequence: a credential
added or removed in Settings was invisible to every already-running server. Every prompt
for that provider's models then failed with the confusingly self-referential

```
ProviderModelNotFoundError: Model not found: openrouter/~deepseek/deepseek-v4-flash-latest.
Did you mean: ~deepseek/deepseek-v4-flash-latest?
```

— the provider is absent from the stale process's runtime map, while the "did you mean"
suggestion comes from the static models.dev catalog the process _does_ have. (Diagnosed
live 2026-08-03: server spawned 22:30, openrouter key added 22:32, all openrouter models
failed until restart; the same binary + config + auth.json worked from a fresh process.)

The staleness was a documented v1 limitation ("LIVE-SERVER STALENESS", M6b) in
`OpencodeAuthProvider.ts`. Options considered:

1. **Recycle pooled servers after auth mutations (ClaudeUI-only).** Chosen.
2. **Fork patch + broadcast**: make `authSet`/`authRemove` invalidate provider
   `InstanceState` in the fork, and have ClaudeUI broadcast `PUT /auth` to every running
   server. Live pickup, zero session disruption — but a fork rebuild + binary bump, and
   the Effect `InstanceState` reset mechanics are unexplored. Remains open as the proper
   long-term fix; it does not obviate option 1 (the broadcast loop is still needed, and
   recycle stays the safety net for servers the broadcast misses).

## Decision

After every **successful, user-initiated** opencode auth mutation —
`setVendorApiKey`, `oauthCallback` (only when the flow returned `true`),
`removeVendorAuth` — `OpencodeAuthProvider` calls `OpencodeServerManager.recycleAll()`.
A fresh spawn re-reads `auth.json`; recycling is the only reload signal that exists.

**`recycleAll()` mechanics** (order matters, per handle):

1. `handles.delete(key)` FIRST — a racing `acquire()` must spawn a fresh server rather
   than be handed a dying handle, and the child's `'exit'` handler is identity-gated on
   `handles.get(key)`, so early removal suppresses its duplicate cleanup/fan-out.
2. Drain + fire `exitListeners` (copy, clear, per-callback try/catch) — attached sessions
   `markDisconnected` now and lazily reconnect on their next prompt (ADR-045 path). Their
   `releaseIfCurrent` no-ops against the already-removed handle: no refcount underflow,
   no double kill.
3. `killProcess` (tree-kill), then `mcpHost.close()`.

In-flight spawns (`pending`) are left alone: a process that hasn't served a request yet
builds its provider state lazily, necessarily after the auth.json write that triggered
the recycle.

**The timer-driven credential feed does NOT recycle.** `feedOauthCredential`
(CredentialSync's background refresh) fires at moments the user never chose; killing
whatever sessions happen to be mid-turn on a refresh tick is strictly worse than the edge
it would fix. The timer keeps the on-disk copy fresh well before expiry, so any fresh
server start finds a good credential; a live server using a just-rotated credential can
401 until its next restart — accepted (M6c), not solved here.

Call-site rule: recycle **only on success**, and **only after the transient server ref is
released** (`release()` no-ops on missing handles, so the ordering is clean).

## Consequences

- A credential change tears down all pooled opencode servers, including for other cwds
  (opencode auth is global, so they are all equally stale). A session mid-turn at that
  moment loses the turn with a visible `session:error` — acceptable for an action the
  user just took in Settings.
- Sessions self-heal with no new code: exit fan-out → `markDisconnected` →
  next prompt re-acquires → respawn.
- `exitListeners` semantics widened: fired on unexpected death **or** deliberate
  `recycleAll()` — NOT on `release()`/`dispose()` (doc comments updated accordingly).
- Spawn identity is the per-spawn random `password`, never `baseUrl` — the real binary
  reuses port 4096 across respawns even with `--port 0` (proven by the gated integration
  smoke `src/integration/opencode/opencode-recycle.integration.test.ts`,
  `OPENCODE_INTEGRATION_TESTS=1`).
- Open follow-ups: option 2 (fork-side `authSet` invalidation + `PUT /auth` broadcast);
  the same staleness exists for **config** changes ("in-session config reload" gap) and
  is NOT addressed by this ADR — recycle-on-config-change would piggyback on the same
  primitive if/when wanted.
