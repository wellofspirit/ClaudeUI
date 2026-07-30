# ADR-042 — Pinned Tailscale HTTPS port + persisted serve-config reconciliation

**Status:** Accepted
**Relates to:** ADR-039 (the `tailscale serve` TLS mode this hardens), ADR-007 (remote-server
settings live in the app DB, not Claude settings.json)

## Context

TLS mode fronts the loopback listener with `tailscale serve`. The original port policy walked a
candidate list (443 → 8443 → 10000), skipping any HTTPS port whose serve entry looked *foreign* —
where "ours" meant *the entry's proxy target string equals `http://127.0.0.1:<current localPort>`*.

That ownership test is only as stable as the local port. With the local listener on a random port
(the default), every run binds a new loopback port, so a serve entry leaked by a previous run —
`stop()` tears serve down **fire-and-forget** (`remote-server.ts`), and at app quit the CLI call
often doesn't land; a force-kill never even attempts it — points at a *dead, different* port. The
next launch classifies our own stale 443 entry as foreign, silently falls back to 8443, and the
user's bookmark (`https://<node>.ts.net`) breaks. Observed in production on 2026-07-30: 443 →
dead `127.0.0.1:64032` (stale), live app on 8443. Left alone, leaked entries eventually occupy all
three candidates and TLS mode fails entirely.

Silent port drift is the wrong trade: the whole point of TLS mode is a stable, bookmarkable URL.

## Decision

Three coupled changes:

1. **The HTTPS port is pinned config, not a search.** `remote_config.tls_https_port`
   (INTEGER NOT NULL DEFAULT **443**, migration v8) is the only port `enableServe` will bind.
   No fallback walk — if the pinned port is held by a foreign config, `enableServe` throws
   `TailscaleServeError('port-occupied')` naming the occupant. Any uint16 is accepted
   (`tailscale serve` itself allows it; 443/8443/10000 remain the Funnel-compatible triple and the
   Settings UI says so). The candidate-list policy (`HTTPS_PORT_CANDIDATES`) is retired.

2. **Errors are surfaced app-level, with a one-click recovery.** A serve failure while TLS mode is
   requested is pushed through `RemoteStatus.tls.serveError { reason, message }` and rendered by a
   desktop-only banner pinned at the top of the app (same card language as the chat
   `FloatingError`), not buried in the modal. The banner's **Force re-serve** action calls the
   desktop-only IPC `remote:force-reserve` (in `RemoteDispatcher.BLOCKED` — remote clients must
   never mutate serve config), which re-runs serve enablement with `force: true`: it claims the
   pinned port by overwriting whatever handler sits there. Force is explicitly destructive to the
   occupant and the UI copy says so; it is the user's deliberate "my bookmark wins" button.

3. **Cleanup is a persisted contract, reconciled at startup.** On serve success the app persists
   `{last_serve_https_port, last_serve_local_port}` in `remote_config`; a confirmed `disableServe`
   clears them. On every app startup, before autostart, the app reconciles: if the record exists
   and the live serve config shows that HTTPS port proxying to `127.0.0.1:<recorded localPort>`,
   the entry is **provably ours** — remove it (targeted `serve --https=<port> off`, never
   `serve reset`). This one mechanism covers graceful-quit races, crashes, and force-kills
   identically, and stays correct when the pinned port changes or TLS mode is turned off between
   runs. The persisted record also feeds the `ours` classification in `getServeStatus`, so a stale
   own entry can never again masquerade as foreign.

   Quit-time teardown stays **fire-and-forget** (best effort). Making `QuitCoordinator`'s teardown
   async would delay every quit by up to a CLI exec and still cannot cover force-kill — the startup
   reconcile is the guarantee; the quit-time attempt is an optimization that usually lands.

## Consequences

- Bookmarks are stable: the app binds the configured port (default 443 → bare
  `https://<node>.ts.net`) or reports loudly why it can't. No silent drift.
- One accepted stale window: after a force-kill, the dead serve entry lingers until the next app
  launch reconciles it (a browser hitting the bookmark meanwhile gets a connection error). Nothing
  but the app can clean this up; accepted explicitly.
- Two profiles/instances pinning the same port on one node now *conflict visibly* (banner +
  force-steal) instead of silently spreading across 8443/10000. This is intended.
- `TailscaleHttpsPort`'s closed union type is gone; the port is a validated number.

## Alternatives considered

- **Keep the fallback walk, just fix `ours` detection.** Fixes the observed leak but keeps silent
  drift for genuinely-foreign occupancy — the bookmark still breaks without explanation. Rejected.
- **Async quit teardown (bounded await).** Adds latency to every quit, cannot cover force-kill,
  and is redundant once startup reconciliation exists. Rejected (fire-and-forget kept as-is).
- **Heuristic reclaim of dead loopback targets** (probe the target port, treat dead = ours).
  Could clobber another local app's serve entry that is merely restarting. Rejected in favour of
  the exact persisted-record match.
